import type { JsonObject, JsonValue } from '../types.js';
import { IMAGE_OPERATION_DEFAULTS } from '../nodes/files-disk.js';
import { isObject, jsonish, type Converted, type Ctx, type Params } from './import.js';

/**
 * Conversores do importador do n8n para os nós de arquivos: Compression, Edit Image,
 * Read/Write Files from Disk e os antigos Read Binary File, Read Binary Files e Write Binary File.
 */

const opts = (params: Params, key = 'options'): Params => (isObject(params[key]) ? (params[key] as Params) : {});
/** Valor simples do n8n para o nosso (expressões "={{ }}" passam iguais). */
const v = (value: unknown, fallback: JsonValue): JsonValue => (value === undefined || value === null ? fallback : jsonish(value));
const bool = (value: unknown, fallback: boolean): JsonValue => (value === undefined || value === null ? fallback : typeof value === 'string' && value.startsWith('=') ? value : value === true || value === 'true');

/** Aviso de que o caminho do n8n precisa existir numa pasta liberada daqui. */
function warnPath(warn: (m: string) => void, value: unknown, what: string): void {
  const text = typeof value === 'string' ? value : '';
  const shown = text && !text.startsWith('=') ? ` "${text}"` : '';
  warn(
    `${what}${shown} precisa estar numa pasta liberada em FILES_DIRS (no Docker, /files, ligada a uma pasta do computador); caminho relativo começa na primeira pasta liberada. Ajuste o caminho se ele apontava para outra pasta do servidor do n8n`,
  );
}

// ---------- Compression ----------

function compression({ params, node, warn }: Ctx): Converted | null {
  const version = node.typeVersion ?? 1;
  const operation = String(params.operation ?? 'decompress');
  if (operation === 'decompress') {
    return {
      type: 'compression',
      parameters: { operation, binaryPropertyName: v(params.binaryPropertyName, 'data'), outputPrefix: v(params.outputPrefix, 'file_') },
    };
  }
  if (operation !== 'compress') {
    warn(`a operação "${operation}" do Compression não existe aqui`);
    return null;
  }
  let outputFormat = params.outputFormat === undefined || params.outputFormat === '' ? (version < 1.1 ? '' : 'zip') : String(params.outputFormat);
  if (!outputFormat) {
    warn('o Compression V1 estava sem formato de saída (não gerava nada); aqui ficou zip');
    outputFormat = 'zip';
  }
  const p: JsonObject = { operation, binaryPropertyName: v(params.binaryPropertyName, 'data'), outputFormat };
  if (outputFormat === 'gzip' && version < 1.1) {
    p.fileName = '';
    p.binaryPropertyOutput = v(params.outputPrefix, 'data');
    warn('Compression V1 com gzip: os arquivos agora saem nos campos data, data1, data2… (antes data0, data1…) e com nome "arquivo.ext.gz" (antes "arquivo.gzip")');
  } else {
    p.fileName = v(params.fileName, '');
    p.binaryPropertyOutput = v(params.binaryPropertyOutput, 'data');
  }
  return { type: 'compression', parameters: p };
}

// ---------- Edit Image ----------

const SUPPORTED_OPERATORS = new Set(['Over', 'In', 'Out', 'Atop', 'Xor', 'Multiply', 'Difference', 'Add', 'Plus', 'Copy']);

/** Parâmetros de uma operação com os padrões do n8n (a exportação omite o que está no padrão). */
function imageOperation(source: Params, operation: string, version: number, warn: (m: string) => void, warnedFont: { done: boolean }): JsonObject {
  const defaults = IMAGE_OPERATION_DEFAULTS[operation] ?? {};
  const p: JsonObject = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    if (key === 'font') continue;
    p[key] = v(source[key], fallback);
  }
  if (operation === 'text' && version < 1.1) {
    // A versão 1 escrevia a partir do canto de cima à esquerda.
    p.horizontalAlignment = 'west';
    p.verticalAlignment = 'north';
  }
  if (operation === 'composite' && typeof p.operator === 'string' && !SUPPORTED_OPERATORS.has(p.operator)) {
    warn(`o operador "${p.operator}" do Composite não existe aqui (só ${[...SUPPORTED_OPERATORS].join(', ')}); escolha outro`);
  }
  if (operation === 'shear') warn('o Shear agora preenche os cantos com transparente; confira o resultado');
  if (operation === 'text' && source.font && !warnedFont.done) {
    warnedFont.done = true;
    warn('a fonte do Edit Image era um arquivo do servidor do n8n; aqui é o nome da família (ex.: DejaVu Sans). Escolha de novo');
  }
  return p;
}

function editImage({ params, node, warn }: Ctx): Converted | null {
  const version = node.typeVersion ?? 1;
  const operation = String(params.operation ?? 'border');
  const o = opts(params);
  const warnedFont = { done: false };
  const p: JsonObject = { operation, dataPropertyName: v(params.dataPropertyName, 'data') };
  if (operation === 'multiStep') {
    const rows = isObject(params.operations) && Array.isArray(params.operations.operations) ? params.operations.operations.filter(isObject) : [];
    p.operations = rows
      .filter((row) => typeof row.operation === 'string' && IMAGE_OPERATION_DEFAULTS[row.operation])
      .map((row) => {
        const op = String(row.operation);
        const values = imageOperation(row, op, version, warn, warnedFont);
        return { operation: op, ...values };
      });
    if ((p.operations as JsonValue[]).length !== rows.length) warn('algumas etapas do Multi Step não tinham operação válida e ficaram de fora');
  } else if (operation !== 'information') {
    if (!IMAGE_OPERATION_DEFAULTS[operation]) {
      warn(`a operação "${operation}" do Edit Image não existe aqui`);
      return null;
    }
    Object.assign(p, imageOperation(params, operation, version, warn, warnedFont));
  }
  if (operation !== 'information') {
    if (o.destinationKey !== undefined) p.destinationKey = v(o.destinationKey, '');
    if (o.fileName !== undefined) p.fileName = v(o.fileName, '');
    if (o.font !== undefined && !warnedFont.done) {
      warnedFont.done = true;
      warn('a fonte do Edit Image era um arquivo do servidor do n8n; aqui é o nome da família (ex.: DejaVu Sans). Escolha de novo');
    }
    if (o.format !== undefined) p.format = v(o.format, 'jpeg');
    if (o.quality !== undefined) {
      p.quality = v(o.quality, 100);
      if (o.format === undefined) warn('a qualidade só vale aqui quando o formato de saída é escolhido; escolha o formato');
    }
  } else {
    warn('Get Information agora devolve um resumo das informações (formato, tamanho, profundidade, cores), não a saída completa do GraphicsMagick');
  }
  return { type: 'editImage', parameters: p };
}

// ---------- Read/Write Files from Disk ----------

function readWriteFile({ params, node, warn }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'read');
  const o = opts(params);
  if (operation === 'read') {
    warnPath(warn, params.fileSelector, 'o caminho dos arquivos');
    if ((node.typeVersion ?? 1) < 1.1) warn('quando nenhum arquivo é encontrado, o nó agora para com erro (antes, na versão 1, saía vazio)');
    const p: JsonObject = {
      operation,
      fileSelector: v(params.fileSelector, ''),
      dataPropertyName: v(o.dataPropertyName, 'data'),
      fileName: v(o.fileName, ''),
      fileExtension: v(o.fileExtension, ''),
      mimeType: v(o.mimeType, ''),
      literalBrackets: bool(o.literalBrackets, true),
    };
    return { type: 'readWriteFile', parameters: p };
  }
  if (operation === 'write') {
    warnPath(warn, params.fileName, 'o arquivo de destino');
    return {
      type: 'readWriteFile',
      parameters: { operation, fileName: v(params.fileName, ''), dataPropertyName: v(params.dataPropertyName, 'data'), append: bool(o.append, false) },
    };
  }
  warn(`a operação "${operation}" do Read/Write Files from Disk não existe aqui`);
  return null;
}

/** Caminho exato do Read Binary File vira seletor: curingas viram texto. */
const literalPath = (value: unknown): JsonValue => {
  if (typeof value !== 'string') return v(value, '');
  return value.startsWith('=') ? value : value.replace(/([*?{}!])/g, '\\$1');
};

function readBinaryFile({ params, warn }: Ctx): Converted {
  warnPath(warn, params.filePath, 'o arquivo');
  warn('Read Binary File virou Read/Write Files from Disk: a saída agora traz os dados do arquivo no JSON (antes repetia o JSON e os outros arquivos do item de entrada)');
  return {
    type: 'readWriteFile',
    parameters: { operation: 'read', fileSelector: literalPath(params.filePath), dataPropertyName: v(params.dataPropertyName, 'data'), literalBrackets: true },
  };
}

function readBinaryFiles({ params, warn }: Ctx): Converted {
  warnPath(warn, params.fileSelector, 'o padrão dos arquivos');
  warn('Read Binary Files virou Read/Write Files from Disk: agora lê uma vez por item de entrada (antes lia uma vez só) e o JSON traz os dados de cada arquivo');
  return {
    type: 'readWriteFile',
    parameters: { operation: 'read', fileSelector: v(params.fileSelector, ''), dataPropertyName: v(params.dataPropertyName, 'data'), literalBrackets: false },
  };
}

function writeBinaryFile({ params, warn }: Ctx): Converted {
  warnPath(warn, params.fileName, 'o arquivo de destino');
  return {
    type: 'readWriteFile',
    parameters: { operation: 'write', fileName: v(params.fileName, ''), dataPropertyName: v(params.dataPropertyName, 'data'), append: bool(opts(params).append, false) },
  };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  compression,
  editImage,
  readWriteFile,
  readBinaryFile,
  readBinaryFiles,
  writeBinaryFile,
};
