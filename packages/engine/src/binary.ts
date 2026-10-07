import type { BinaryData, Item } from './types.js';
import { NodeOperationError } from './node-types.js';

/**
 * Arquivos dentro dos itens, no mesmo formato do n8n: `item.binary[propriedade]` com o conteúdo em
 * base64 em `data` e os dados do arquivo ao lado. Na execução gravada, `data` some (ou vira uma
 * referência, nas execuções manuais) para o histórico ocupar pouco espaço.
 */

/** Tamanho legível, como o n8n mostra ("12.3 kB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  gzip: 'application/gzip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  ics: 'text/calendar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION)
    .filter(([ext]) => !['htm', 'jpeg', 'tif', 'gzip'].includes(ext))
    .map(([ext, mime]) => [mime, ext]),
);

export function mimeTypeFromFileName(fileName: string | undefined): string | undefined {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return ext && ext !== fileName?.toLowerCase() ? MIME_BY_EXTENSION[ext] : undefined;
}

export function extensionFromMimeType(mimeType: string | undefined): string | undefined {
  return mimeType ? EXTENSION_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()] : undefined;
}

/** Monta o arquivo de um item a partir do conteúdo. */
export function toBinary(content: Buffer, options: { fileName?: string; mimeType?: string; directory?: string } = {}): BinaryData {
  const fileName = options.fileName || undefined;
  const mimeType = options.mimeType || mimeTypeFromFileName(fileName) || 'application/octet-stream';
  const fileExtension = (fileName && fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined) ?? extensionFromMimeType(mimeType);
  const binary: BinaryData = { data: content.toString('base64'), mimeType, fileSize: formatFileSize(content.length), bytes: content.length };
  if (fileName) binary.fileName = fileName;
  if (fileExtension) binary.fileExtension = fileExtension;
  if (options.directory) binary.directory = options.directory;
  const kind = mimeType.split('/')[0];
  if (['text', 'image', 'audio', 'video'].includes(kind)) binary.fileType = kind;
  else if (mimeType === 'application/json') binary.fileType = 'json';
  else if (mimeType === 'application/pdf') binary.fileType = 'pdf';
  return binary;
}

/** O arquivo da propriedade informada, ou erro claro quando o item não tem esse arquivo. */
export function getBinary(item: Item, property: string, itemIndex = 0): BinaryData {
  const binary = item.binary?.[property];
  if (!binary) {
    const available = Object.keys(item.binary ?? {});
    throw new NodeOperationError(
      available.length
        ? `O item ${itemIndex} não tem o arquivo "${property}". Arquivos do item: ${available.join(', ')}`
        : `O item ${itemIndex} não tem arquivo (procurado em "${property}"). Use antes um nó que gere arquivo, como Read Files from Disk, HTTP Request ou Convert to File.`,
    );
  }
  if (typeof binary.data !== 'string' || binary.omitted) {
    throw new NodeOperationError(`O conteúdo do arquivo "${property}" não está disponível nesta execução`);
  }
  return binary;
}

/** Conteúdo do arquivo da propriedade informada. */
export function getBinaryBuffer(item: Item, property: string, itemIndex = 0): Buffer {
  return Buffer.from(getBinary(item, property, itemIndex).data, 'base64');
}

/** Item com o arquivo na propriedade informada, mantendo o JSON e os outros arquivos. */
export function withBinary(item: Item, property: string, binary: BinaryData): Item {
  return { json: item.json, binary: { ...(item.binary ?? {}), [property]: binary } };
}

/** Nomes de propriedade separados por vírgula (ex.: "data, anexo"). */
export function binaryPropertyList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
