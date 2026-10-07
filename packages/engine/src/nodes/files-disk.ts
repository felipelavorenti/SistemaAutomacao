import { constants as fsConstants } from 'node:fs';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip as zlibGunzip } from 'node:zlib';
import fg from 'fast-glob';
import * as fflate from 'fflate';
import sharp, { type Blend, type Metadata, type Sharp } from 'sharp';
import { binaryPropertyList, getBinary, getBinaryBuffer, toBinary } from '../binary.js';
import type { NodeExecuteContext, NodeType, PropertyDescription } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue } from '../types.js';

/**
 * Nós de arquivos, réplicas dos nós do n8n: Compression (zip, gzip, tar), Edit Image e
 * Read/Write Files from Disk. O Compression usa o fflate, como o n8n; o Edit Image usa o sharp
 * no lugar do GraphicsMagick; o Read/Write só enxerga as pastas liberadas em FILES_DIRS.
 */

// ---------- Utilitários ----------

const str = (value: JsonValue | undefined, fallback = ''): string => (value === undefined || value === null ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value));
const bool = (value: JsonValue | undefined, fallback = false): boolean => (value === undefined || value === null || value === '' ? fallback : value === true || value === 'true');
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Arquivo montado a partir do caminho, como o prepareBinaryData do n8n (nome, pasta e extensão). */
function binaryFromPath(content: Buffer, filePath: string, mimeType?: string): BinaryData {
  const parsed = path.posix.parse(filePath.replace(/\\/g, '/'));
  return toBinary(content, { fileName: parsed.base || undefined, directory: parsed.dir || undefined, mimeType });
}

const MB = 1024 * 1024;
/** Limite do conteúdo descompactado (soma de todos os arquivos de um item). */
export const MAX_DECOMPRESSED_SIZE = 512 * MB;
/** Limite de arquivos dentro de um zip ou tar. */
export const MAX_ARCHIVE_ENTRIES = 10_000;
/** Maior arquivo que o Read Files from Disk lê. */
export const MAX_READ_FILE_SIZE = 512 * MB;
/** Maior imagem (em pixels) que o Edit Image cria ou gera. */
const MAX_IMAGE_PIXELS = 268_402_689;

const sizeExceeded = () => new NodeOperationError(`O conteúdo descompactado passa do limite de ${MAX_DECOMPRESSED_SIZE / MB} MB`);
const tooManyEntries = () => new NodeOperationError(`O arquivo compactado tem mais de ${MAX_ARCHIVE_ENTRIES} arquivos`);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// =====================================================================
// Compression
// =====================================================================

/** Extensões que já vêm compactadas: vão para o zip sem compressão, como no n8n. */
const ALREADY_COMPRESSED = ['7z', 'aifc', 'bz2', 'doc', 'docx', 'gif', 'gz', 'heic', 'heif', 'jpg', 'jpeg', 'mov', 'mp3', 'mp4', 'pdf', 'png', 'ppt', 'pptx', 'rar', 'webm', 'webp', 'xls', 'xlsx', 'zip'];

const gzipAsync = promisify(fflate.gzip);
const zipAsync = promisify(fflate.zip);
const gunzipAsync = promisify(zlibGunzip);

/** Descompacta gzip sem passar do limite (o zlib para assim que a saída estoura). */
export async function boundedGunzip(data: Buffer, maxOutputSize = MAX_DECOMPRESSED_SIZE): Promise<Buffer> {
  try {
    return await gunzipAsync(data, { maxOutputLength: Math.max(maxOutputSize, 1) });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw sizeExceeded();
    throw new NodeOperationError(`Não foi possível descompactar o gzip: ${errMessage(err)}`);
  }
}

/**
 * Descompacta um zip. Pastas e entradas __MACOSX ficam de fora; o tamanho declarado de cada
 * arquivo é conferido antes (o fflate nunca escreve além dele) e a soma real depois.
 */
export function boundedUnzip(data: Buffer, maxOutputSize = MAX_DECOMPRESSED_SIZE, maxEntries = MAX_ARCHIVE_ENTRIES): Record<string, Buffer> {
  let count = 0;
  let declared = 0;
  let files: fflate.Unzipped;
  try {
    files = fflate.unzipSync(data, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false;
        if (++count > maxEntries) throw tooManyEntries();
        declared += file.originalSize;
        if (declared > maxOutputSize) throw sizeExceeded();
        return true;
      },
    });
  } catch (err) {
    if (err instanceof NodeOperationError) throw err;
    throw new NodeOperationError(`Não foi possível descompactar o zip: ${errMessage(err)}`);
  }
  const result: Record<string, Buffer> = Object.create(null);
  let total = 0;
  for (const [name, bytes] of Object.entries(files)) {
    total += bytes.length;
    if (total > maxOutputSize) throw sizeExceeded();
    result[name] = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return result;
}

// ---------- tar (ustar com cabeçalho PAX para nomes longos) ----------

function tarHeader(name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(512);
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';
  let prefix = '';
  let short = name;
  if (Buffer.byteLength(name) > 100) {
    // Tenta dividir em prefixo (155) + nome (100); o PAX guarda o nome inteiro de qualquer jeito.
    const cut = name.lastIndexOf('/', name.length - 1);
    if (cut > 0 && Buffer.byteLength(name.slice(0, cut)) <= 155 && Buffer.byteLength(name.slice(cut + 1)) <= 100) {
      prefix = name.slice(0, cut);
      short = name.slice(cut + 1);
    } else short = name.slice(-100);
  }
  header.write(short, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

const tarPad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);

/** Monta um tar na memória (opcionalmente em gzip, .tar.gz). */
export async function createTar(files: { fileName: string; data: Buffer }[], gzipOutput: boolean): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const { fileName, data } of files) {
    if (Buffer.byteLength(fileName) > 100) {
      const body = (len: number) => `${len} path=${fileName}\n`;
      let len = Buffer.byteLength(body(0));
      while (Buffer.byteLength(body(len)) !== len) len = Buffer.byteLength(body(len));
      const record = Buffer.from(body(len));
      parts.push(tarHeader(`PaxHeader/${path.posix.basename(fileName)}`.slice(0, 100), record.length, 'x'), record, tarPad(record.length));
    }
    parts.push(tarHeader(fileName, data.length, '0'), data, tarPad(data.length));
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return gzipOutput ? Buffer.from(await gzipAsync(tar)) : tar;
}

function escapesRoot(entryPath: string): boolean {
  const trimmed = entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath;
  if (trimmed.startsWith('/')) return true;
  const normalized = path.posix.normalize(trimmed);
  return normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..');
}

/** Lê um tar (ou .tar.gz). Só arquivos comuns; caminhos absolutos ou com ".." ficam de fora. */
export async function boundedUntar(data: Buffer, maxOutputSize = MAX_DECOMPRESSED_SIZE, maxEntries = MAX_ARCHIVE_ENTRIES): Promise<Record<string, Buffer>> {
  if (data[0] === 0x1f && data[1] === 0x8b) data = await boundedGunzip(data, maxOutputSize + maxEntries * 1024 + 1024);
  const result: Record<string, Buffer> = Object.create(null);
  const cstr = (buf: Buffer, start: number, length: number) => {
    const slice = buf.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
  };
  let offset = 0;
  let count = 0;
  let total = 0;
  let nextName: string | undefined;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    const stored = parseInt(cstr(header, 148, 8).trim(), 8);
    if (stored !== sum) throw new NodeOperationError('O arquivo tar está corrompido ou não é um tar');
    const size = parseInt(cstr(header, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new NodeOperationError('O arquivo tar está corrompido');
    const type = String.fromCharCode(header[156]!);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (match) nextName = match[1];
      continue;
    }
    if (type === 'L') {
      nextName = cstr(body, 0, body.length);
      continue;
    }
    const prefix = header.subarray(257, 262).toString('ascii') === 'ustar' ? cstr(header, 345, 155) : '';
    const name = nextName ?? (prefix ? `${prefix}/${cstr(header, 0, 100)}` : cstr(header, 0, 100));
    nextName = undefined;
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    if (!name || escapesRoot(name) || FORBIDDEN_KEYS.has(name)) continue;
    if (++count > maxEntries) throw tooManyEntries();
    total += size;
    if (total > maxOutputSize) throw sizeExceeded();
    if (body.length < size) throw new NodeOperationError('O arquivo tar está incompleto');
    result[name] = Buffer.from(body);
  }
  return result;
}

const COMPRESS_FORMATS = ['zip', 'tar', 'targz'];

export const compression: NodeType = {
  description: {
    type: 'compression',
    displayName: 'Compression',
    description: 'Compacta arquivos em zip, gzip ou tar e descompacta arquivos zip, gzip, tar e tar.gz.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'decompress',
        options: [
          { name: 'Compactar', value: 'compress' },
          { name: 'Descompactar', value: 'decompress' },
        ],
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Campo(s) de arquivo de entrada',
        type: 'string',
        default: 'data',
        required: true,
        placeholder: 'data, data2, data3',
        description: 'Propriedade(s) do item com os arquivos. Para mais de um arquivo, separe os nomes por vírgula.',
      },
      {
        name: 'outputFormat',
        displayName: 'Formato de saída',
        type: 'options',
        default: 'zip',
        options: [
          { name: 'Gzip', value: 'gzip' },
          { name: 'Tar', value: 'tar' },
          { name: 'Tar (Gzip)', value: 'targz' },
          { name: 'Zip', value: 'zip' },
        ],
        description: 'Zip e tar juntam todos os arquivos num só; gzip compacta cada arquivo separado.',
        showWhen: { operation: ['compress'] },
      },
      {
        name: 'fileName',
        displayName: 'Nome do arquivo',
        type: 'string',
        default: '',
        placeholder: 'dados.zip',
        description: 'Nome do arquivo gerado. No gzip, vazio usa o nome do arquivo original (fica "nome.ext.gz").',
        showWhen: { operation: ['compress'] },
      },
      {
        name: 'binaryPropertyOutput',
        displayName: 'Colocar o arquivo no campo',
        type: 'string',
        default: 'data',
        description: 'Propriedade de saída. No gzip com vários arquivos, os seguintes ganham número (data, data1, data2…).',
        showWhen: { operation: ['compress'] },
      },
      {
        name: 'outputPrefix',
        displayName: 'Prefixo de saída',
        type: 'string',
        default: 'file_',
        required: true,
        description: 'Prefixo das propriedades dos arquivos descompactados (file_0, file_1…).',
        showWhen: { operation: ['decompress'] },
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i]!;
      const operation = str(await ctx.getParam('operation', i), 'decompress');
      const names = binaryPropertyList(await ctx.getParam('binaryPropertyName', i));
      if (!names.length) throw new NodeOperationError('Informe o campo de arquivo de entrada');
      if (operation === 'decompress') {
        const prefix = str(await ctx.getParam('outputPrefix', i), 'file_');
        const binary: Record<string, BinaryData> = {};
        let zipIndex = 0;
        for (const [index, name] of names.entries()) {
          const source = getBinary(item, name, i);
          const content = getBinaryBuffer(item, name, i);
          const fileName = source.fileName ?? '';
          const ext = (source.fileExtension || (fileName.includes('.') ? fileName.split('.').pop() : '') || '').toLowerCase();
          if (!ext) throw new NodeOperationError(`O arquivo "${name}" não tem extensão; não dá para saber o formato`);
          const isTar = ext === 'tar' || ext === 'tgz' || fileName.toLowerCase().endsWith('.tar.gz');
          if (ext === 'zip' || isTar) {
            const files = isTar ? await boundedUntar(content) : boundedUnzip(content);
            for (const key of Object.keys(files)) {
              if (key.includes('__MACOSX')) continue;
              binary[`${prefix}${zipIndex++}`] = binaryFromPath(files[key]!, key);
            }
          } else if (ext === 'gz' || ext === 'gzip') {
            const file = await boundedGunzip(content);
            const base = fileName.split('.')[0] || 'file';
            const inner = fileName.replace(/\.(gz|gzip)$/i, '').split('.');
            const innerExt = inner.length > 1 ? inner[inner.length - 1] : undefined;
            binary[`${prefix}${index}`] = toBinary(file, { fileName: innerExt ? `${base}.${innerExt}` : base });
          } else {
            throw new NodeOperationError(`Formato ".${ext}" não suportado no arquivo "${name}". A descompactação aceita zip, gzip, tar, tar.gz e tgz.`);
          }
        }
        out.push({ json: item.json, binary });
        continue;
      }
      if (operation !== 'compress') throw new NodeOperationError(`Operação desconhecida: ${operation}`);
      const format = str(await ctx.getParam('outputFormat', i), 'zip');
      if (![...COMPRESS_FORMATS, 'gzip'].includes(format)) throw new NodeOperationError(`Formato de saída desconhecido: ${format}`);
      const outputName = str(await ctx.getParam('fileName', i));
      const outputField = str(await ctx.getParam('binaryPropertyOutput', i), 'data') || 'data';
      if (format === 'gzip') {
        const binary: Record<string, BinaryData> = {};
        for (const [index, name] of names.entries()) {
          const source = getBinary(item, name, i);
          const content = getBinaryBuffer(item, name, i);
          const base = outputName ? outputName.replace('.gz', '').replace('.gzip', '') : source.fileName?.split('.')[0] || name;
          const ext = source.fileExtension ? `.${source.fileExtension.toLowerCase()}` : '';
          binary[`${outputField}${index ? index : ''}`] = toBinary(Buffer.from(await gzipAsync(content)), { fileName: `${base}${ext}.gz` });
        }
        out.push({ json: item.json, binary });
        continue;
      }
      if (format === 'zip') {
        const zipData: fflate.Zippable = {};
        for (const name of names) {
          const source = getBinary(item, name, i);
          const level = ALREADY_COMPRESSED.includes((source.fileExtension ?? '').toLowerCase()) ? 0 : 6;
          zipData[source.fileName || name] = [new Uint8Array(getBinaryBuffer(item, name, i)), { level }];
        }
        const zipped = Buffer.from(await zipAsync(zipData));
        out.push({ json: item.json, binary: { [outputField]: toBinary(zipped, { fileName: outputName || undefined, mimeType: 'application/zip' }) } });
        continue;
      }
      const files = names.map((name) => ({ fileName: getBinary(item, name, i).fileName || name, data: getBinaryBuffer(item, name, i) }));
      const tar = await createTar(files, format === 'targz');
      const mimeType = format === 'targz' ? 'application/gzip' : 'application/x-tar';
      out.push({ json: item.json, binary: { [outputField]: toBinary(tar, { fileName: outputName || undefined, mimeType }) } });
    }
    return [out];
  },
};

// =====================================================================
// Edit Image
// =====================================================================

interface Rgba {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  navy: [0, 0, 128],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
};

/**
 * Cor no formato do GraphicsMagick (o que o n8n usa): "#rgb", "#rrggbb", nomes ("red"),
 * "transparent", "rgb()"/"rgba()". Em "#rrggbbaa" os dois últimos dígitos são a OPACIDADE
 * invertida, como no GraphicsMagick: 00 é opaco e ff é transparente.
 */
export function parseColor(value: string): Rgba {
  const raw = value.trim().toLowerCase();
  if (raw === 'transparent' || raw === 'none') return { r: 0, g: 0, b: 0, alpha: 0 };
  if (NAMED_COLORS[raw]) {
    const [r, g, b] = NAMED_COLORS[raw]!;
    return { r, g, b, alpha: 1 };
  }
  let m = /^#([0-9a-f]{3})$/.exec(raw);
  if (m) {
    const [r, g, b] = m[1]!.split('').map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b!, alpha: 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(raw);
  if (m) {
    const hex = m[1]!;
    const opacity = m[2] ? parseInt(m[2], 16) : 0;
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), alpha: Math.round((1 - opacity / 255) * 1000) / 1000 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(raw);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  throw new NodeOperationError(`Cor inválida: "${value}". Use #rrggbb, #rrggbbaa (aa = opacidade invertida: 00 opaco, ff transparente), um nome (red) ou transparent.`);
}

const svgColor = (c: Rgba) => `rgba(${c.r},${c.g},${c.b},${c.alpha})`;
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Imagem em memória: pixels RGBA crus. */
interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

const OUTPUT_FORMATS = ['bmp', 'gif', 'jpeg', 'png', 'tiff', 'webp'];

// ---------- BMP (o sharp não lê nem grava BMP) ----------

/** Lê BMP sem compressão (8, 24 e 32 bits) ou 32 bits com BI_BITFIELDS. */
export function decodeBmp(buf: Buffer): RawImage {
  if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') throw new NodeOperationError('Arquivo BMP inválido');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compressionType = buf.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) throw new NodeOperationError('BMP com dimensões inválidas');
  if (!((compressionType === 0 && [8, 24, 32].includes(bpp)) || (compressionType === 3 && bpp === 32))) {
    throw new NodeOperationError(`BMP de ${bpp} bits com compressão ${compressionType} não é suportado (só 8, 24 e 32 bits sem compressão)`);
  }
  let masks = [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
  if (compressionType === 3) {
    masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), headerSize >= 56 ? buf.readUInt32LE(66) : 0];
  }
  const channel = (pixel: number, mask: number) => {
    if (!mask) return 255;
    let shift = 0;
    while (((mask >>> shift) & 1) === 0) shift++;
    const max = mask >>> shift;
    return Math.round((((pixel & mask) >>> shift) * 255) / max);
  };
  const paletteOffset = 14 + headerSize;
  const rowSize = Math.ceil((bpp * width) / 32) * 4;
  if (dataOffset + rowSize * height > buf.length) throw new NodeOperationError('Arquivo BMP incompleto');
  const out = Buffer.alloc(width * height * 4);
  // BMP de 32 bits sem compressão costuma ter o 4º byte zerado: só vale como alfa se algum pixel usar.
  let hasAlpha = false;
  if (bpp === 32 && compressionType === 0) {
    for (let y = 0; y < height && !hasAlpha; y++) for (let x = 0; x < width; x++) if (buf[dataOffset + y * rowSize + x * 4 + 3] !== 0) hasAlpha = true;
  }
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp === 8) {
        const p = paletteOffset + buf[row + x]! * 4;
        out[o] = buf[p + 2]!;
        out[o + 1] = buf[p + 1]!;
        out[o + 2] = buf[p]!;
        out[o + 3] = 255;
      } else if (bpp === 24) {
        out[o] = buf[row + x * 3 + 2]!;
        out[o + 1] = buf[row + x * 3 + 1]!;
        out[o + 2] = buf[row + x * 3]!;
        out[o + 3] = 255;
      } else if (compressionType === 3) {
        const pixel = buf.readUInt32LE(row + x * 4);
        out[o] = channel(pixel, masks[0]!);
        out[o + 1] = channel(pixel, masks[1]!);
        out[o + 2] = channel(pixel, masks[2]!);
        out[o + 3] = channel(pixel, masks[3]!);
      } else {
        out[o] = buf[row + x * 4 + 2]!;
        out[o + 1] = buf[row + x * 4 + 1]!;
        out[o + 2] = buf[row + x * 4]!;
        out[o + 3] = hasAlpha ? buf[row + x * 4 + 3]! : 255;
      }
    }
  }
  return { data: out, width, height };
}

/** Grava BMP de 24 bits (sem alfa), como a maioria dos programas lê. */
export function encodeBmp(img: RawImage): Buffer {
  const rowSize = Math.ceil((24 * img.width) / 32) * 4;
  const size = 54 + rowSize * img.height;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(img.width, 18);
  buf.writeInt32LE(img.height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * img.height, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < img.height; y++) {
    const row = 54 + (img.height - 1 - y) * rowSize;
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      buf[row + x * 3] = img.data[o + 2]!;
      buf[row + x * 3 + 1] = img.data[o + 1]!;
      buf[row + x * 3 + 2] = img.data[o]!;
    }
  }
  return buf;
}

// ---------- Pipeline ----------

const isBmp = (buf: Buffer) => buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d;

/** Abre a imagem já girada pela orientação EXIF (como o autoOrient do n8n), em RGBA. */
async function decodeImage(buf: Buffer): Promise<RawImage & { format: string }> {
  if (isBmp(buf)) return { ...decodeBmp(buf), format: 'bmp' };
  try {
    const image = sharp(buf, { failOn: 'none' });
    const meta = await image.metadata();
    const { data, info } = await image.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, format: meta.format ?? 'png' };
  } catch (err) {
    throw new NodeOperationError(`Não foi possível abrir a imagem: ${errMessage(err)}`);
  }
}

const fromRaw = (img: RawImage) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });

async function toRaw(pipeline: Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function checkSize(width: number, height: number): void {
  if (!(width >= 1 && height >= 1)) throw new NodeOperationError('A largura e a altura da imagem precisam ser maiores que zero');
  if (width * height > MAX_IMAGE_PIXELS) throw new NodeOperationError(`A imagem ficaria grande demais (${width}x${height}); o limite é ${MAX_IMAGE_PIXELS} pixels`);
}

/** Valores padrão de cada operação, os mesmos do n8n. */
export const IMAGE_OPERATION_DEFAULTS: Record<string, JsonObject> = {
  blur: { blur: 5, sigma: 2 },
  border: { borderWidth: 10, borderHeight: 10, borderColor: '#000000' },
  composite: { dataPropertyNameComposite: '', operator: 'Over', positionX: 0, positionY: 0 },
  create: { backgroundColor: '#ffffff00', width: 50, height: 50 },
  crop: { width: 500, height: 500, positionX: 0, positionY: 0 },
  draw: { primitive: 'rectangle', color: '#ff000000', startPositionX: 50, startPositionY: 50, endPositionX: 250, endPositionY: 250, cornerRadius: 0 },
  information: {},
  resize: { width: 500, height: 500, resizeOption: 'maximumArea' },
  rotate: { rotate: 0, backgroundColor: '#ffffffff' },
  shear: { degreesX: 0, degreesY: 0 },
  text: { text: '', fontSize: 18, fontColor: '#000000', positionX: 50, positionY: 50, horizontalAlignment: 'center', verticalAlignment: 'middle', lineLength: 80, font: '' },
  transparent: { color: '#ff0000' },
};

const NUMERIC_PARAMETERS: Record<string, string[]> = {
  blur: ['blur', 'sigma'],
  border: ['borderWidth', 'borderHeight'],
  composite: ['positionX', 'positionY'],
  create: ['width', 'height'],
  crop: ['width', 'height', 'positionX', 'positionY'],
  draw: ['startPositionX', 'startPositionY', 'endPositionX', 'endPositionY', 'cornerRadius'],
  resize: ['width', 'height'],
  rotate: ['rotate'],
  shear: ['degreesX', 'degreesY'],
  text: ['fontSize', 'positionX', 'positionY', 'lineLength'],
};

const COMPOSITE_BLEND: Record<string, Blend> = {
  Over: 'over',
  In: 'in',
  Out: 'out',
  Atop: 'atop',
  Xor: 'xor',
  Multiply: 'multiply',
  Difference: 'difference',
  Add: 'add',
  Plus: 'add',
  Copy: 'source',
};

/** Parâmetros da operação: vazio vale o padrão do n8n; números são conferidos. */
function normalizeOperation(op: JsonObject): JsonObject {
  const name = str(op.operation);
  const defaults = IMAGE_OPERATION_DEFAULTS[name];
  if (!defaults) throw new NodeOperationError(`Operação de imagem desconhecida: "${name}"`);
  const result: JsonObject = { operation: name };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = op[key];
    result[key] = value === undefined || value === null || value === '' ? fallback : value;
  }
  for (const key of NUMERIC_PARAMETERS[name] ?? []) {
    if (key === 'cornerRadius' && result.primitive !== 'rectangle') continue;
    const n = Number(result[key]);
    if (typeof result[key] === 'boolean' || !Number.isFinite(n)) throw new NodeOperationError(`O valor de "${key}" precisa ser um número`);
    result[key] = n;
  }
  return result;
}

/** Quebra o texto como o n8n: no máximo `lineLength` caracteres por linha, quebrando nos espaços. */
export function wrapText(text: string, lineLength: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const textLine of text.split('\n')) {
    for (const part of textLine.split(' ')) {
      if (current.length + part.length + 1 > lineLength) {
        lines.push(current.trim());
        current = `${part} `;
        continue;
      }
      current += `${part} `;
    }
    lines.push(current.trim());
    current = '';
  }
  return lines;
}

/** Tamanho final do redimensionamento, com as opções de proporção do n8n (geometria do GraphicsMagick). */
export function resizeTarget(width: number, height: number, w: number, h: number, option: string): { width: number; height: number } {
  const keep = { width, height };
  const fit = (scale: number) => ({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
  switch (option) {
    case 'ignoreAspectRatio':
      return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
    case 'percent':
      return { width: Math.max(1, Math.round((width * w) / 100)), height: Math.max(1, Math.round((height * h) / 100)) };
    case 'minimumArea':
      // Cobre a caixa: a menor escala em que largura >= w e altura >= h.
      return fit(Math.max(w / width, h / height));
    case 'onlyIfLarger':
      return width > w || height > h ? fit(Math.min(w / width, h / height)) : keep;
    case 'onlyIfSmaller':
      return width < w && height < h ? fit(Math.min(w / width, h / height)) : keep;
    case 'maximumArea':
    default: {
      // Área máxima em pixels (w × h), mantendo a proporção; só reduz.
      const area = w * h;
      return width * height > area ? fit(Math.sqrt(area / (width * height))) : keep;
    }
  }
}

interface EditOptions {
  font: string;
  fileName: string;
  format: string;
  quality: number | null;
}

async function overlaySvg(img: RawImage, body: string): Promise<RawImage> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}" viewBox="0 0 ${img.width} ${img.height}">${body}</svg>`;
  return toRaw(fromRaw(img).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]));
}

async function applyOperation(img: RawImage | null, op: JsonObject, item: Item, itemIndex: number, options: EditOptions): Promise<RawImage> {
  const name = str(op.operation);
  if (name === 'create') {
    const width = Math.round(op.width as number);
    const height = Math.round(op.height as number);
    checkSize(width, height);
    return toRaw(sharp({ create: { width, height, channels: 4, background: parseColor(str(op.backgroundColor)) } }));
  }
  if (!img) throw new NodeOperationError('Não há imagem para editar');
  switch (name) {
    case 'blur': {
      const radius = op.blur as number;
      const given = op.sigma as number;
      if (given <= 0 && radius <= 0) return img;
      // Sem sigma, o GraphicsMagick deriva do raio; aqui, metade do raio.
      const sigma = Math.min(1000, Math.max(0.3, given > 0 ? given : radius / 2));
      return toRaw(fromRaw(img).blur(sigma));
    }
    case 'border': {
      const w = Math.max(0, Math.round(op.borderWidth as number));
      const h = Math.max(0, Math.round(op.borderHeight as number));
      checkSize(img.width + 2 * w, img.height + 2 * h);
      return toRaw(fromRaw(img).extend({ top: h, bottom: h, left: w, right: w, background: parseColor(str(op.borderColor)) }));
    }
    case 'composite': {
      const property = str(op.dataPropertyNameComposite).trim();
      if (!property) throw new NodeOperationError('Informe o campo com a imagem a sobrepor');
      const operator = str(op.operator, 'Over');
      const blend = COMPOSITE_BLEND[operator];
      if (!blend) throw new NodeOperationError(`O operador "${operator}" não existe aqui. Use: ${Object.keys(COMPOSITE_BLEND).join(', ')}`);
      const overlay = await decodeImage(getBinaryBuffer(item, property, itemIndex));
      const x = Math.round(op.positionX as number);
      const y = Math.round(op.positionY as number);
      // Só a parte que cabe na imagem de baixo (o sharp não aceita sobrar para fora).
      const sx = Math.max(0, -x);
      const sy = Math.max(0, -y);
      const left = Math.max(0, x);
      const top = Math.max(0, y);
      const w = Math.min(overlay.width - sx, img.width - left);
      const h = Math.min(overlay.height - sy, img.height - top);
      if (w <= 0 || h <= 0) return img;
      const piece = await fromRaw(overlay).extract({ left: sx, top: sy, width: w, height: h }).png().toBuffer();
      return toRaw(fromRaw(img).composite([{ input: piece, left, top, blend }]));
    }
    case 'crop': {
      const x = Math.max(0, Math.round(op.positionX as number));
      const y = Math.max(0, Math.round(op.positionY as number));
      if (x >= img.width || y >= img.height) throw new NodeOperationError(`O corte começa fora da imagem (${img.width}x${img.height})`);
      const width = Math.min(Math.round(op.width as number), img.width - x);
      const height = Math.min(Math.round(op.height as number), img.height - y);
      if (width <= 0 || height <= 0) throw new NodeOperationError('A largura e a altura do corte precisam ser maiores que zero');
      return toRaw(fromRaw(img).extract({ left: x, top: y, width, height }));
    }
    case 'draw': {
      const color = svgColor(parseColor(str(op.color)));
      const x0 = op.startPositionX as number;
      const y0 = op.startPositionY as number;
      const x1 = op.endPositionX as number;
      const y1 = op.endPositionY as number;
      const primitive = str(op.primitive, 'rectangle');
      let shape: string;
      if (primitive === 'line') shape = `<line x1="${x0 + 0.5}" y1="${y0 + 0.5}" x2="${x1 + 0.5}" y2="${y1 + 0.5}" stroke="${color}" stroke-width="1"/>`;
      else if (primitive === 'circle') shape = `<circle cx="${x0}" cy="${y0}" r="${Math.hypot(x1 - x0, y1 - y0)}" fill="${color}"/>`;
      else if (primitive === 'rectangle') {
        const r = Math.max(0, (op.cornerRadius as number) || 0);
        shape = `<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0) + 1}" height="${Math.abs(y1 - y0) + 1}" rx="${r}" ry="${r}" fill="${color}"/>`;
      } else throw new NodeOperationError(`Forma desconhecida: ${primitive}`);
      return overlaySvg(img, shape);
    }
    case 'resize': {
      const w = op.width as number;
      const h = op.height as number;
      if (!(w > 0) || !(h > 0)) throw new NodeOperationError('A largura e a altura precisam ser maiores que zero');
      const target = resizeTarget(img.width, img.height, w, h, str(op.resizeOption, 'maximumArea'));
      if (target.width === img.width && target.height === img.height) return img;
      checkSize(target.width, target.height);
      return toRaw(fromRaw(img).resize(target.width, target.height, { fit: 'fill' }));
    }
    case 'rotate': {
      const angle = op.rotate as number;
      if (angle % 360 === 0) return img;
      return toRaw(fromRaw(img).rotate(angle, { background: parseColor(str(op.backgroundColor)) }));
    }
    case 'shear': {
      const tx = Math.tan(((op.degreesX as number) * Math.PI) / 180);
      const ty = Math.tan(((op.degreesY as number) * Math.PI) / 180);
      if (!Number.isFinite(tx) || !Number.isFinite(ty) || Math.abs(tx) > 1e3 || Math.abs(ty) > 1e3) throw new NodeOperationError('Ângulo de inclinação inválido (use valores longe de 90°)');
      if (tx === 0 && ty === 0) return img;
      // Inclina em X e depois em Y, como o -shear do GraphicsMagick; o fundo fica transparente.
      return toRaw(fromRaw(img).affine([1, tx, ty, 1 + tx * ty], { background: { r: 0, g: 0, b: 0, alpha: 0 } }));
    }
    case 'text': {
      const fontSize = op.fontSize as number;
      if (!(fontSize > 0)) throw new NodeOperationError('O tamanho da fonte precisa ser maior que zero');
      const lineLength = Math.max(1, op.lineLength as number);
      const lines = wrapText(str(op.text), lineLength);
      const font = (options.font || str(op.font)).trim() || 'DejaVu Sans, Arial, Helvetica, sans-serif';
      const px = op.positionX as number;
      const py = op.positionY as number;
      const horizontal = str(op.horizontalAlignment, 'center');
      const vertical = str(op.verticalAlignment, 'middle');
      const lineHeight = fontSize * 1.2;
      const blockHeight = fontSize + (lines.length - 1) * lineHeight;
      const [x, anchor] = horizontal === 'west' ? [px, 'start'] : horizontal === 'east' ? [img.width - px, 'end'] : [img.width / 2 + px, 'middle'];
      const top = vertical === 'north' ? py : vertical === 'south' ? img.height - py - blockHeight : img.height / 2 + py - blockHeight / 2;
      const spans = lines.map((line, i) => `<tspan x="${x}" y="${top + fontSize * 0.8 + i * lineHeight}">${xmlEscape(line)}</tspan>`).join('');
      const fill = parseColor(str(op.fontColor));
      const body = `<text font-family="${xmlEscape(font)}" font-size="${fontSize}" fill="${svgColor(fill)}" text-anchor="${anchor}" xml:space="preserve">${spans}</text>`;
      return overlaySvg(img, body);
    }
    case 'transparent': {
      const c = parseColor(str(op.color));
      const data = Buffer.from(img.data);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === c.r && data[i + 1] === c.g && data[i + 2] === c.b) data[i + 3] = 0;
      }
      return { ...img, data };
    }
    default:
      throw new NodeOperationError(`Operação de imagem desconhecida: "${name}"`);
  }
}

async function encodeImage(img: RawImage, format: string, quality: number | null): Promise<Buffer> {
  if (format === 'bmp') return encodeBmp(img);
  const pipeline = fromRaw(img);
  const q = quality === null ? undefined : Math.min(100, Math.max(1, Math.round(quality)));
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg(q === undefined ? {} : { quality: q }).toBuffer();
    case 'png':
      // No GraphicsMagick a "qualidade" do PNG é o nível de compressão (dezenas).
      return pipeline.png(q === undefined ? {} : { compressionLevel: Math.min(9, Math.floor(q / 10)) }).toBuffer();
    case 'tiff':
      return pipeline.tiff(q === undefined ? {} : { quality: q }).toBuffer();
    case 'webp':
      return pipeline.webp(q === undefined ? {} : { quality: q }).toBuffer();
    case 'gif':
      return pipeline.gif().toBuffer();
    default:
      throw new NodeOperationError(`Formato de imagem inválido: ${format}. Formatos válidos: ${OUTPUT_FORMATS.join(', ')}`);
  }
}

/** Informações da imagem, com os nomes do "identify" do GraphicsMagick que o n8n devolve. */
async function imageInformation(buf: Buffer, binary: BinaryData): Promise<JsonObject> {
  if (isBmp(buf)) {
    const img = decodeBmp(buf);
    return {
      format: 'BMP',
      Format: 'BMP (Microsoft Windows bitmap image)',
      Geometry: `${img.width}x${img.height}`,
      size: { width: img.width, height: img.height },
      depth: 8,
      Colorspace: 'RGB',
      Filesize: binary.fileSize ?? `${buf.length} B`,
      bytes: buf.length,
    };
  }
  let meta: Metadata;
  try {
    meta = await sharp(buf, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new NodeOperationError(`Não foi possível abrir a imagem: ${errMessage(err)}`);
  }
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;
  const depthBits: Record<string, number> = { uchar: 8, char: 8, ushort: 16, short: 16, uint: 32, int: 32, float: 32, double: 64 };
  const info: JsonObject = {
    format: (meta.format ?? '').toUpperCase(),
    Format: (meta.format ?? '').toUpperCase(),
    Geometry: `${width}x${height}`,
    size: { width, height },
    depth: depthBits[meta.depth ?? 'uchar'] ?? 8,
    Colorspace: meta.space ?? 'srgb',
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
    Filesize: binary.fileSize ?? `${buf.length} B`,
    bytes: buf.length,
  };
  if (meta.density) info.Resolution = `${meta.density}x${meta.density}`;
  if (meta.orientation) info.Orientation = meta.orientation;
  if (meta.pages && meta.pages > 1) info.pages = meta.pages;
  if (meta.isProgressive !== undefined) info.Interlace = meta.isProgressive ? 'Line' : 'None';
  return info;
}

const IMAGE_OPERATIONS = [
  { name: 'Borrar (Blur)', value: 'blur' },
  { name: 'Borda (Border)', value: 'border' },
  { name: 'Sobrepor imagem (Composite)', value: 'composite' },
  { name: 'Criar imagem (Create)', value: 'create' },
  { name: 'Cortar (Crop)', value: 'crop' },
  { name: 'Desenhar (Draw)', value: 'draw' },
  { name: 'Girar (Rotate)', value: 'rotate' },
  { name: 'Redimensionar (Resize)', value: 'resize' },
  { name: 'Inclinar (Shear)', value: 'shear' },
  { name: 'Escrever texto (Text)', value: 'text' },
  { name: 'Cor transparente (Transparent)', value: 'transparent' },
];

const COLOR_HINT = 'Ex.: #ff0000, red ou transparent. Com 8 dígitos (#rrggbbaa) os dois últimos são a opacidade invertida, como no n8n: 00 = opaco, ff = transparente.';

/** Campos de cada operação; `n8nDefault` na descrição quando o padrão muda entre operações. */
function operationFields(): PropertyDescription[] {
  const on = (...ops: string[]) => ({ operation: ops });
  return [
    { name: 'backgroundColor', displayName: 'Cor de fundo', type: 'string', default: '', placeholder: '#ffffff00', description: `Vazio: #ffffff00 (branco opaco) ao criar; #ffffffff (transparente) ao girar. ${COLOR_HINT}`, showWhen: on('create', 'rotate') },
    { name: 'width', displayName: 'Largura', type: 'number', default: null, description: 'Em pixels (ou % no redimensionamento por porcentagem). Vazio: 50 ao criar, 500 ao cortar e redimensionar.', showWhen: on('create', 'crop', 'resize') },
    { name: 'height', displayName: 'Altura', type: 'number', default: null, description: 'Em pixels (ou % no redimensionamento por porcentagem). Vazio: 50 ao criar, 500 ao cortar e redimensionar.', showWhen: on('create', 'crop', 'resize') },
    {
      name: 'primitive',
      displayName: 'Forma',
      type: 'options',
      default: 'rectangle',
      options: [
        { name: 'Círculo', value: 'circle' },
        { name: 'Linha', value: 'line' },
        { name: 'Retângulo', value: 'rectangle' },
      ],
      showWhen: on('draw'),
    },
    { name: 'color', displayName: 'Cor', type: 'string', default: '#ff0000', description: `Cor da forma (desenhar) ou cor que vira transparente. ${COLOR_HINT}`, showWhen: on('draw', 'transparent') },
    { name: 'startPositionX', displayName: 'Posição inicial X', type: 'number', default: 50, description: 'No círculo, o centro.', showWhen: on('draw') },
    { name: 'startPositionY', displayName: 'Posição inicial Y', type: 'number', default: 50, showWhen: on('draw') },
    { name: 'endPositionX', displayName: 'Posição final X', type: 'number', default: 250, description: 'No círculo, um ponto da borda (define o raio).', showWhen: on('draw') },
    { name: 'endPositionY', displayName: 'Posição final Y', type: 'number', default: 250, showWhen: on('draw') },
    { name: 'cornerRadius', displayName: 'Raio dos cantos', type: 'number', default: 0, description: 'Arredonda os cantos do retângulo.', showWhen: on('draw') },
    { name: 'text', displayName: 'Texto', type: 'string', default: '', multiline: true, placeholder: 'Texto a escrever', showWhen: on('text') },
    { name: 'fontSize', displayName: 'Tamanho da fonte', type: 'number', default: 18, showWhen: on('text') },
    { name: 'fontColor', displayName: 'Cor da fonte', type: 'string', default: '#000000', description: COLOR_HINT, showWhen: on('text') },
    { name: 'positionX', displayName: 'Posição X', type: 'number', default: null, description: 'Vazio: 50 no texto, 0 ao cortar e sobrepor. No texto é o deslocamento a partir do alinhamento.', showWhen: on('text', 'composite', 'crop') },
    { name: 'positionY', displayName: 'Posição Y', type: 'number', default: null, description: 'Vazio: 50 no texto, 0 ao cortar e sobrepor. No texto é o deslocamento a partir do alinhamento.', showWhen: on('text', 'composite', 'crop') },
    {
      name: 'horizontalAlignment',
      displayName: 'Alinhamento horizontal',
      type: 'options',
      default: 'center',
      options: [
        { name: 'Esquerda', value: 'west' },
        { name: 'Centro', value: 'center' },
        { name: 'Direita', value: 'east' },
      ],
      showWhen: on('text'),
    },
    {
      name: 'verticalAlignment',
      displayName: 'Alinhamento vertical',
      type: 'options',
      default: 'middle',
      options: [
        { name: 'Topo', value: 'north' },
        { name: 'Meio', value: 'middle' },
        { name: 'Base', value: 'south' },
      ],
      showWhen: on('text'),
    },
    { name: 'lineLength', displayName: 'Máximo de caracteres por linha', type: 'number', default: 80, description: 'Acima disso o texto quebra a linha (nos espaços).', showWhen: on('text') },
    { name: 'blur', displayName: 'Raio do desfoque', type: 'number', default: 5, description: 'Mantido por compatibilidade com o n8n; a intensidade vem do sigma.', showWhen: on('blur') },
    { name: 'sigma', displayName: 'Sigma', type: 'number', default: 2, description: 'Intensidade do desfoque (0,3 a 1000).', showWhen: on('blur') },
    { name: 'borderWidth', displayName: 'Largura da borda', type: 'number', default: 10, description: 'Pixels à esquerda e à direita.', showWhen: on('border') },
    { name: 'borderHeight', displayName: 'Altura da borda', type: 'number', default: 10, description: 'Pixels em cima e embaixo.', showWhen: on('border') },
    { name: 'borderColor', displayName: 'Cor da borda', type: 'string', default: '#000000', description: COLOR_HINT, showWhen: on('border') },
    { name: 'dataPropertyNameComposite', displayName: 'Campo da imagem a sobrepor', type: 'string', default: '', placeholder: 'data2', description: 'Propriedade do item com a imagem que vai por cima.', showWhen: on('composite') },
    {
      name: 'operator',
      displayName: 'Operador',
      type: 'options',
      default: 'Over',
      options: Object.keys(COMPOSITE_BLEND).map((k) => ({ name: k, value: k })),
      description: 'Como juntar as imagens. Over é colar por cima.',
      showWhen: on('composite'),
    },
    {
      name: 'resizeOption',
      displayName: 'Opção',
      type: 'options',
      default: 'maximumArea',
      options: [
        { name: 'Ignorar a proporção (tamanho exato)', value: 'ignoreAspectRatio' },
        { name: 'Área máxima (largura × altura em pixels)', value: 'maximumArea' },
        { name: 'Área mínima (cobre a largura e a altura)', value: 'minimumArea' },
        { name: 'Só se for maior', value: 'onlyIfLarger' },
        { name: 'Só se for menor', value: 'onlyIfSmaller' },
        { name: 'Porcentagem', value: 'percent' },
      ],
      showWhen: on('resize'),
    },
    { name: 'rotate', displayName: 'Graus', type: 'number', default: 0, description: 'De -360 a 360, no sentido horário.', showWhen: on('rotate') },
    { name: 'degreesX', displayName: 'Graus em X', type: 'number', default: 0, description: 'Inclinação horizontal.', showWhen: on('shear') },
    { name: 'degreesY', displayName: 'Graus em Y', type: 'number', default: 0, description: 'Inclinação vertical.', showWhen: on('shear') },
  ];
}

const singleFields = operationFields();
/** Nas linhas do Multi Step todo campo começa vazio (vale o padrão da operação). */
const stepFields: PropertyDescription[] = [
  { name: 'operation', displayName: 'Operação', type: 'options', default: 'resize', options: IMAGE_OPERATIONS },
  ...singleFields.map((f) => ({ ...f, default: f.type === 'options' ? f.default : f.type === 'number' ? null : '' })),
  { name: 'font', displayName: 'Fonte', type: 'string', default: '', placeholder: 'DejaVu Sans', description: 'Nome da família da fonte instalada no servidor.', showWhen: { operation: ['text'] } },
];

export const editImage: NodeType = {
  description: {
    type: 'editImage',
    displayName: 'Edit Image',
    description: 'Edita imagens: redimensiona, corta, gira, desfoca, põe borda, texto e formas, sobrepõe imagens e mostra informações.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'border',
        options: [...IMAGE_OPERATIONS, { name: 'Informações (Get Information)', value: 'information' }, { name: 'Várias etapas (Multi Step)', value: 'multiStep' }].sort((a, b) =>
          a.name.localeCompare(b.name, 'pt-BR'),
        ),
      },
      { name: 'dataPropertyName', displayName: 'Campo do arquivo', type: 'string', default: 'data', description: 'Propriedade do item com a imagem.' },
      {
        name: 'operations',
        displayName: 'Etapas',
        type: 'list',
        default: [],
        description: 'Operações feitas em ordem. Campo vazio vale o padrão da operação.',
        fields: stepFields,
        showWhen: { operation: ['multiStep'] },
      },
      ...singleFields,
      { name: 'font', displayName: 'Fonte', type: 'string', default: '', placeholder: 'DejaVu Sans', description: 'Nome da família da fonte instalada no servidor. Vazio: DejaVu Sans (ou outra sem serifa).', showWhen: { operation: ['text', 'multiStep'] } },
      { name: 'destinationKey', displayName: 'Campo de saída', type: 'string', default: '', placeholder: 'data', description: 'Propriedade onde vai a imagem editada. Vazio: o mesmo campo de entrada.', showWhen: { operation: [...IMAGE_OPERATIONS.map((o) => o.value), 'multiStep'] } },
      { name: 'fileName', displayName: 'Nome do arquivo', type: 'string', default: '', description: 'Nome do arquivo gerado. Vazio: mantém o nome original.', showWhen: { operation: [...IMAGE_OPERATIONS.map((o) => o.value), 'multiStep'] } },
      {
        name: 'format',
        displayName: 'Formato',
        type: 'options',
        default: '',
        options: [{ name: 'Manter o formato (PNG ao criar)', value: '' }, ...OUTPUT_FORMATS.map((f) => ({ name: f === 'webp' ? 'WebP' : f, value: f }))],
        showWhen: { operation: [...IMAGE_OPERATIONS.map((o) => o.value), 'multiStep'] },
      },
      { name: 'quality', displayName: 'Qualidade', type: 'number', default: 100, description: 'De 0 a 100 (melhor). No PNG vira o nível de compressão.', showWhen: { format: ['jpeg', 'png', 'tiff', 'webp'] } },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i]!;
      const operation = str(await ctx.getParam('operation', i), 'border');
      const dataPropertyName = str(await ctx.getParam('dataPropertyName', i), 'data') || 'data';
      const destination = str(await ctx.getParam('destinationKey', i)).trim() || dataPropertyName;
      const options: EditOptions = {
        font: str(await ctx.getParam('font', i)),
        fileName: str(await ctx.getParam('fileName', i)),
        format: str(await ctx.getParam('format', i)),
        quality: null,
      };
      if (options.format && !OUTPUT_FORMATS.includes(options.format)) throw new NodeOperationError(`Formato de imagem inválido: ${options.format}. Formatos válidos: ${OUTPUT_FORMATS.join(', ')}`);
      if (['jpeg', 'png', 'tiff', 'webp'].includes(options.format)) {
        const q = await ctx.getParam('quality', i);
        if (q !== null && q !== '' && q !== undefined) {
          if (!Number.isFinite(Number(q))) throw new NodeOperationError('O valor de "quality" precisa ser um número');
          options.quality = Number(q);
        }
      }

      if (operation === 'information') {
        const binary = getBinary(item, dataPropertyName, i);
        out.push({ json: await imageInformation(getBinaryBuffer(item, dataPropertyName, i), binary), binary: item.binary });
        continue;
      }

      let steps: JsonObject[];
      if (operation === 'multiStep') {
        const list = await ctx.getParam('operations', i);
        const rows = Array.isArray(list) ? list : [];
        steps = rows.filter((r): r is JsonObject => !!r && typeof r === 'object' && !Array.isArray(r)).map(normalizeOperation);
        if (!steps.length) throw new NodeOperationError('Adicione ao menos uma etapa');
      } else {
        const defaults = IMAGE_OPERATION_DEFAULTS[operation];
        if (!defaults) throw new NodeOperationError(`Operação desconhecida: ${operation}`);
        const op: JsonObject = { operation };
        for (const key of Object.keys(defaults)) op[key] = key === 'font' ? '' : await ctx.getParam(key, i);
        steps = [normalizeOperation(op)];
      }

      let img: RawImage | null = null;
      let format = options.format;
      const source = steps[0]!.operation === 'create' ? undefined : getBinary(item, dataPropertyName, i);
      if (source) {
        const decoded = await decodeImage(getBinaryBuffer(item, dataPropertyName, i));
        img = decoded;
        if (!format) format = OUTPUT_FORMATS.includes(decoded.format) ? decoded.format : 'png';
      } else if (!format) format = 'png';
      for (const step of steps) img = await applyOperation(img, step, item, i, options);
      const buffer = await encodeImage(img!, format, options.quality);

      const previous = item.binary?.[destination];
      let fileName = previous?.fileName;
      if (options.format && fileName?.includes('.')) fileName = `${fileName.split('.').slice(0, -1).join('.')}.${options.format}`;
      if (options.fileName) fileName = options.fileName;
      const binary = toBinary(buffer, { fileName, mimeType: `image/${format}`, directory: previous?.directory });
      binary.fileExtension = options.format || previous?.fileExtension || (format === 'jpeg' ? 'jpg' : format);
      out.push({ json: item.json, binary: { ...(item.binary ?? {}), [destination]: binary } });
    }
    return [out];
  },
};

// =====================================================================
// Read/Write Files from Disk
// =====================================================================

interface AllowedRoot {
  /** Pasta como foi configurada (absoluta). */
  resolved: string;
  /** A mesma pasta com os links simbólicos resolvidos. */
  real: string;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** As pastas liberadas (FILES_DIRS) que existem no servidor. */
export async function allowedRoots(dirs: string[]): Promise<AllowedRoot[]> {
  if (!dirs.length) {
    throw new NodeOperationError(
      'Nenhuma pasta do servidor está liberada para ler ou gravar arquivos. Configure a variável FILES_DIRS no .env (ex.: FILES_DIRS=/files) e reinicie o servidor.',
    );
  }
  const roots: AllowedRoot[] = [];
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    try {
      roots.push({ resolved, real: await realpath(resolved) });
    } catch {
      // Pasta configurada que não existe: fica de fora.
    }
  }
  if (!roots.length) throw new NodeOperationError(`As pastas liberadas em FILES_DIRS não existem no servidor: ${dirs.join(', ')}`);
  return roots;
}

const outsideError = (p: string, dirs: string[]) => new NodeOperationError(`O caminho "${p}" está fora das pastas liberadas (${dirs.join(', ')}). Use um caminho dentro delas ou peça para incluir a pasta em FILES_DIRS no .env.`);

/** Caminho real dentro de uma pasta liberada; segue links simbólicos e recusa o que sair delas. */
export async function resolveAllowedPath(filePath: string, dirs: string[], roots?: AllowedRoot[]): Promise<string> {
  roots ??= await allowedRoots(dirs);
  if (!filePath.trim()) throw new NodeOperationError('Informe o caminho do arquivo');
  if (filePath.includes('\0')) throw new NodeOperationError('Caminho de arquivo inválido');
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(dirs[0]!, filePath);
  if (!roots.some((r) => isInside(absolute, r.resolved) || isInside(absolute, r.real))) throw outsideError(filePath, dirs);
  // Resolve links simbólicos: do próprio arquivo, ou da pasta existente mais próxima (arquivo novo).
  let existing = absolute;
  const rest: string[] = [];
  let real: string | undefined;
  for (;;) {
    try {
      real = path.join(await realpath(existing), ...rest);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw outsideError(filePath, dirs);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (!roots.some((r) => isInside(real!, r.real))) throw outsideError(filePath, dirs);
  return real;
}

/** Como o n8n: caminhos do Windows com barra invertida viram barra normal. */
export function normalizeFileSelector(selector: string): string {
  if (!/^[a-zA-Z]:/.test(selector)) return selector;
  return /^[a-zA-Z]:\\|\\(?![()[\]])/.test(selector) ? path.win32.normalize(selector).replace(/\\/g, '/') : path.posix.normalize(selector);
}

export function escapeBracketsAndParens(selector: string): string {
  return selector.replace(/\\?([()[\]])/g, '\\$1');
}

function fileError(err: unknown, filePath: string, operation: 'read' | 'write'): NodeOperationError {
  if (err instanceof NodeOperationError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return new NodeOperationError(
      operation === 'read'
        ? `Sem permissão para ler ${filePath}. Confira o caminho ou as permissões do arquivo.`
        : `Sem permissão para gravar o arquivo ${filePath}. Escolha outra pasta ou ajuste as permissões da pasta.`,
    );
  }
  if (code === 'EISDIR') return new NodeOperationError(`"${filePath}" é uma pasta, não um arquivo`);
  if (code === 'ENOENT') return new NodeOperationError(`Arquivo não encontrado: ${filePath}`);
  return new NodeOperationError(`Erro ao ${operation === 'read' ? 'ler' : 'gravar'} ${filePath}: ${errMessage(err)}`);
}

/** Arquivos que casam com o seletor, só dentro das pastas liberadas. */
export async function findFiles(selector: string, dirs: string[], literalBrackets = true): Promise<string[]> {
  const roots = await allowedRoots(dirs);
  const normalized = normalizeFileSelector(selector.trim());
  if (!normalized) throw new NodeOperationError('Informe o caminho ou o padrão dos arquivos');
  const cwd = path.resolve(dirs[0]!);
  const pattern = literalBrackets ? escapeBracketsAndParens(normalized) : normalized;
  const globOptions: fg.Options = { cwd, absolute: true, onlyFiles: true, followSymbolicLinks: true, ...(literalBrackets ? {} : { extglob: false }) };
  // A parte fixa do padrão (antes do primeiro curinga) precisa estar dentro das pastas liberadas.
  for (const task of fg.generateTasks([pattern], globOptions)) {
    const base = path.resolve(cwd, task.base);
    if (!roots.some((r) => isInside(base, r.resolved) || isInside(base, r.real))) throw outsideError(normalized, dirs);
  }
  const matches = (await fg(pattern, globOptions)).sort();
  const files: string[] = [];
  let skipped = 0;
  for (const match of matches) {
    try {
      const real = await realpath(match);
      if (roots.some((r) => isInside(real, r.real))) files.push(match);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (!files.length && skipped) throw new NodeOperationError(`Os arquivos encontrados por "${normalized}" estão fora das pastas liberadas (${dirs.join(', ')})`);
  return files;
}

const fileOptionsShow = { operation: ['read'] };

export const readWriteFile: NodeType = {
  description: {
    type: 'readWriteFile',
    displayName: 'Read/Write Files from Disk',
    description: 'Lê e grava arquivos nas pastas do servidor liberadas em FILES_DIRS (no Docker, /files, ligada a uma pasta do computador).',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'read',
        options: [
          { name: 'Ler arquivo(s) do disco', value: 'read' },
          { name: 'Gravar arquivo no disco', value: 'write' },
        ],
      },
      {
        name: 'fileSelector',
        displayName: 'Arquivo(s)',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/files/entrada/**/*.csv',
        description:
          'Caminho ou padrão (glob) dos arquivos, sempre com barra "/". Caminho relativo começa na primeira pasta liberada. Curingas: * (qualquer nome), ** (qualquer subpasta), ? (um caractere), {a,b}.',
        showWhen: fileOptionsShow,
      },
      { name: 'dataPropertyName', displayName: 'Colocar o arquivo no campo', type: 'string', default: 'data', description: 'Propriedade de saída com o arquivo lido.', showWhen: fileOptionsShow },
      { name: 'fileName', displayName: 'Nome do arquivo na saída', type: 'string', default: '', placeholder: 'dados.zip', description: 'Troca o nome do arquivo lido. Vazio: o nome no disco.', showWhen: fileOptionsShow },
      { name: 'fileExtension', displayName: 'Extensão na saída', type: 'string', default: '', placeholder: 'zip', description: 'Troca a extensão informada no arquivo lido.', showWhen: fileOptionsShow },
      { name: 'mimeType', displayName: 'Tipo MIME na saída', type: 'string', default: '', placeholder: 'application/zip', description: 'Troca o tipo do arquivo lido. Vazio: pelo nome do arquivo.', showWhen: fileOptionsShow },
      {
        name: 'literalBrackets',
        displayName: 'Tratar [ ] e ( ) como texto',
        type: 'boolean',
        default: true,
        description: 'Desligue para usar classes como [0-9] ou grupos como (a|b) no padrão. Não afeta * ? { }.',
        showWhen: fileOptionsShow,
      },
      {
        name: 'fileName',
        displayName: 'Caminho e nome do arquivo',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/files/saida/relatorio.pdf',
        description: 'Onde gravar, com a extensão. Precisa estar numa pasta liberada; caminho relativo começa na primeira delas. Pastas que faltam são criadas.',
        showWhen: { operation: ['write'] },
      },
      { name: 'dataPropertyName', displayName: 'Campo do arquivo de entrada', type: 'string', default: 'data', required: true, description: 'Propriedade do item com o arquivo a gravar.', showWhen: { operation: ['write'] } },
      {
        name: 'append',
        displayName: 'Acrescentar ao final',
        type: 'boolean',
        default: false,
        description: 'Acrescenta ao arquivo existente em vez de substituir. Serve para texto (CSV, log); arquivos com estrutura (PDF, imagem) ficam inválidos.',
        showWhen: { operation: ['write'] },
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const operation = str(await ctx.getParam('operation', 0), 'read');
    if (operation === 'read') return [await readFiles(ctx, input)];
    if (operation === 'write') return [await writeFiles(ctx, input)];
    throw new NodeOperationError(`Operação desconhecida: ${operation}`);
  },
};

async function readFiles(ctx: NodeExecuteContext, input: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (let i = 0; i < input.length; i++) {
    const selector = str(await ctx.getParam('fileSelector', i));
    const literalBrackets = bool(await ctx.getParam('literalBrackets', i), true);
    const property = str(await ctx.getParam('dataPropertyName', i), 'data') || 'data';
    const fileName = str(await ctx.getParam('fileName', i));
    const fileExtension = str(await ctx.getParam('fileExtension', i));
    const mimeType = str(await ctx.getParam('mimeType', i));
    const files = await findFiles(selector, ctx.filesDirs, literalBrackets);
    if (!files.length) {
      const escaped = escapeBracketsAndParens(selector) !== selector;
      const hint = !escaped
        ? ''
        : literalBrackets
          ? '. Se [ ] e ( ) eram classe ou grupo do padrão, desligue "Tratar [ ] e ( ) como texto"'
          : '. Se [ ] e ( ) fazem parte do nome, ligue "Tratar [ ] e ( ) como texto"';
      throw new NodeOperationError(`Nenhum arquivo encontrado com "${selector}"${hint}`);
    }
    for (const file of files) {
      let content: Buffer;
      try {
        const info = await stat(file);
        if (info.size > MAX_READ_FILE_SIZE) throw new NodeOperationError(`O arquivo ${file} é grande demais (limite ${MAX_READ_FILE_SIZE / MB} MB)`);
        const handle = await open(file, 'r');
        try {
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (err) {
        throw fileError(err, file, 'read');
      }
      const binary = binaryFromPath(content, file, mimeType || undefined);
      if (fileName) binary.fileName = fileName;
      if (fileExtension) binary.fileExtension = fileExtension;
      const json: JsonObject = { mimeType: binary.mimeType };
      if (binary.fileType) json.fileType = binary.fileType;
      if (binary.fileName) json.fileName = binary.fileName;
      if (binary.fileExtension) json.fileExtension = binary.fileExtension;
      if (binary.fileSize) json.fileSize = binary.fileSize;
      out.push({ json, binary: { [property]: binary } });
    }
  }
  return out;
}

async function writeFiles(ctx: NodeExecuteContext, input: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  const roots = await allowedRoots(ctx.filesDirs);
  for (let i = 0; i < input.length; i++) {
    const item = input[i]!;
    const property = str(await ctx.getParam('dataPropertyName', i), 'data') || 'data';
    const fileName = str(await ctx.getParam('fileName', i));
    const append = bool(await ctx.getParam('append', i));
    const content = getBinaryBuffer(item, property, i);
    const target = await resolveAllowedPath(fileName, ctx.filesDirs, roots);
    // Gravar dentro de um .git mudaria a configuração do repositório que o nó Git usa (hooks, filtros).
    if (target.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) {
      throw new NodeOperationError(`Não é permitido gravar dentro de uma pasta .git ("${fileName}"); use o nó Git para mexer no repositório`);
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      // O_NOFOLLOW: não grava através de um link simbólico trocado depois da conferência.
      const flags = (append ? fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC) | (fsConstants.O_NOFOLLOW ?? 0);
      const handle = await open(target, flags, 0o644);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw fileError(err, fileName, 'write');
    }
    const result: Item = { json: { ...item.json, fileName } };
    if (item.binary) result.binary = { ...item.binary };
    out.push(result);
  }
  return out;
}

export const fileDiskNodes: NodeType[] = [compression, editImage, readWriteFile];
