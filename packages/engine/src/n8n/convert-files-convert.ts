import type { JsonObject, JsonValue } from '../types.js';
import { isObject, jsonish, type Converted, type Ctx, type Params } from './import.js';

/**
 * Conversores do importador do n8n para os nós de arquivos: Convert to File, Extract from File,
 * iCalendar e os nós antigos que viraram esses (Spreadsheet File, Read PDF e Move Binary Data).
 * XLS e ODS não existem aqui: o conversor avisa e o nó fica como não convertido.
 */

const opts = (params: Params, key = 'options'): Params => (isObject(params[key]) ? (params[key] as Params) : {});
const has = (o: Params, key: string) => o[key] !== undefined && o[key] !== null;
/** Valor simples do n8n para o nosso (expressões "={{ }}" passam iguais). */
const v = (value: unknown, fallback: JsonValue): JsonValue => (value === undefined || value === null ? fallback : jsonish(value));
const bool = (value: unknown, fallback: boolean): JsonValue => (value === undefined || value === null ? fallback : typeof value === 'string' && value.startsWith('=') ? value : value === true || value === 'true');

const SHEET_FORMATS = ['csv', 'html', 'rtf', 'xlsx'];

function noOldSheet(format: string, warn: Ctx['warn']): null {
  warn(`o formato ${format.toUpperCase()} não é suportado aqui (só XLSX, CSV, HTML e RTF); salve a planilha como XLSX ou CSV e troque o nó`);
  return null;
}

// ---------- Convert to File ----------

/** Opções de escrita de planilha (Convert to File e Spreadsheet File > Write to File). */
function sheetWriteParams(format: string, params: Params, defaultName: string): JsonObject {
  const o = opts(params);
  const p: JsonObject = { operation: format, binaryPropertyName: v(params.binaryPropertyName, 'data'), headerRow: bool(o.headerRow, true) };
  if (format === 'csv') p.delimiter = v(o.delimiter, ',') || ',';
  if (format === 'xlsx') {
    p.sheetName = v(o.sheetName, 'Sheet');
    p.compression = bool(o.compression, false);
  }
  p.fileName = has(o, 'fileName') ? v(o.fileName, '') : `${defaultName}.${format}`;
  return p;
}

/** Campos do evento (iCalendar e Convert to File > ICS): as coleções viram campos soltos. */
function icalParams(params: Params, warn: Ctx['warn']): JsonObject {
  const o = opts(params, 'additionalFields');
  const p: JsonObject = {
    title: v(params.title, ''),
    start: v(params.start, ''),
    end: v(params.end, ''),
    allDay: bool(params.allDay, false),
    binaryPropertyName: v(params.binaryPropertyName, 'data'),
    // O n8n lê datas sem fuso no fuso do servidor (normalmente UTC).
    timezone: 'UTC',
  };
  warn('datas sem fuso (ex.: 2026-05-10T14:00) eram lidas no fuso do servidor do n8n; aqui o campo "Fuso horário" ficou UTC, confira');
  for (const key of ['description', 'location', 'url', 'uid', 'calName', 'recurrenceRule', 'status', 'busyStatus', 'fileName']) if (has(o, key)) p[key] = v(o[key], '');
  if (has(o, 'sequence')) p.sequence = v(o.sequence, 0);
  const organizer = isObject(o.organizerUi) && isObject(o.organizerUi.organizerValues) ? o.organizerUi.organizerValues : null;
  if (organizer) {
    p.organizerName = v(organizer.name, '');
    p.organizerEmail = v(organizer.email, '');
  }
  const geo = isObject(o.geolocationUi) && isObject(o.geolocationUi.geolocationValues) ? o.geolocationUi.geolocationValues : null;
  if (geo) {
    p.geoLat = v(geo.lat, '');
    p.geoLon = v(geo.lon, '');
  }
  const attendees = isObject(o.attendeesUi) && Array.isArray(o.attendeesUi.attendeeValues) ? o.attendeesUi.attendeeValues.filter(isObject) : [];
  if (attendees.length) p.attendees = attendees.map((a) => ({ name: v(a.name, ''), email: v(a.email, ''), rsvp: bool(a.rsvp, false) }));
  return p;
}

function convertToFile({ params, warn, node }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'csv');
  if (operation === 'xls' || operation === 'ods') return noOldSheet(operation, warn);
  if (SHEET_FORMATS.includes(operation)) return { type: 'convertToFile', parameters: sheetWriteParams(operation, params, 'File') };
  const o = opts(params);
  const p: JsonObject = { operation, binaryPropertyName: v(params.binaryPropertyName, 'data') };
  switch (operation) {
    case 'toJson':
      p.mode = v(params.mode, 'once');
      p.format = bool(o.format, false);
      break;
    case 'toText':
      p.sourceProperty = v(params.sourceProperty, '');
      break;
    case 'toBinary':
      p.sourceProperty = v(params.sourceProperty, '');
      // Versão 1 com "Data Is Base64" desligado: o campo é texto comum.
      if ((node.typeVersion ?? 1) === 1 && o.dataIsBase64 === false) {
        p.operation = 'toText';
        if (has(o, 'mimeType')) warn(`o arquivo sai como texto (text/plain), não como "${String(o.mimeType)}"`);
      } else if (has(o, 'mimeType')) p.mimeType = v(o.mimeType, '');
      break;
    case 'iCal':
      return { type: 'convertToFile', parameters: { operation, ...icalParams(params, warn) } };
    default:
      warn(`a operação "${operation}" do Convert to File não existe aqui`);
      return null;
  }
  if (p.operation === 'toJson' || p.operation === 'toText') {
    if (has(o, 'encoding')) p.encoding = v(o.encoding, 'utf8');
    if (has(o, 'addBOM')) p.addBOM = bool(o.addBOM, false);
  }
  if (has(o, 'fileName')) p.fileName = v(o.fileName, '');
  return { type: 'convertToFile', parameters: p };
}

function iCal({ params, warn }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'createEventFile');
  if (operation !== 'createEventFile') {
    warn(`a operação "${operation}" do iCalendar não existe aqui`);
    return null;
  }
  return { type: 'iCal', parameters: { operation, ...icalParams(params, warn) } };
}

// ---------- Extract from File ----------

/** Opções de leitura de planilha (Extract from File e Spreadsheet File > Read from File). */
function sheetReadParams(format: string, params: Params, warn: Ctx['warn'], serialDates: boolean): JsonObject {
  const o = opts(params);
  const p: JsonObject = { operation: format, binaryPropertyName: v(params.binaryPropertyName, 'data') };
  if (has(o, 'headerRow')) p.headerRow = bool(o.headerRow, true);
  if (has(o, 'includeEmptyCells')) p.includeEmptyCells = bool(o.includeEmptyCells, false);
  if (format === 'csv') {
    if (has(o, 'delimiter')) p.delimiter = v(o.delimiter, ',');
    if (has(o, 'encoding')) p.csvEncoding = v(o.encoding, 'utf-8');
    if (has(o, 'enableBOM')) p.enableBOM = bool(o.enableBOM, false);
    if (has(o, 'relaxQuotes')) p.relaxQuotes = bool(o.relaxQuotes, false);
    if (has(o, 'maxRowCount')) p.maxRowCount = v(o.maxRowCount, -1);
    if (has(o, 'fromLine')) p.fromLine = v(o.fromLine, 0);
    const skip = isObject(o.skipRecordsWithErrors) && isObject(o.skipRecordsWithErrors.value) ? o.skipRecordsWithErrors.value : null;
    if (skip) {
      p.skipRecordsWithErrors = bool(skip.enabled, false);
      if (has(skip, 'maxSkippedRecords')) p.maxSkippedRecords = v(skip.maxSkippedRecords, -1);
    }
  }
  if (format === 'xlsx') {
    if (has(o, 'sheetName')) p.sheetName = v(o.sheetName, '');
    if (has(o, 'range')) p.range = v(o.range, '');
    if (serialDates && o.rawData !== true) {
      p.rawData = true;
      warn('nesta versão do nó as datas do XLSX saíam como número serial do Excel; ficou ligado "Dados brutos" para manter isso (desligue para receber datas em ISO)');
    }
  }
  if ((format === 'xlsx' || format === 'html' || format === 'rtf') && has(o, 'rawData')) p.rawData = bool(o.rawData, false);
  if (has(o, 'readAsString')) warn('a opção "Read As String" não existe aqui (o texto já é lido em UTF-8)');
  return p;
}

const MOVE_OPS = ['binaryToPropery', 'fromJson', 'text', 'fromIcs', 'xml'];

function extractFromFile({ params, warn, node }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'csv');
  const version = node.typeVersion ?? 1;
  if (operation === 'xls' || operation === 'ods') return noOldSheet(operation, warn);
  if (SHEET_FORMATS.includes(operation)) {
    if (operation === 'csv' && version < 1.1) warn('na versão 1 do nó o n8n ignorava erros de leitura do CSV; aqui eles param o nó (ligue "Pular linhas com erro" se precisar)');
    return { type: 'extractFromFile', parameters: sheetReadParams(operation, params, warn, version < 1.2) };
  }
  const o = opts(params);
  const p: JsonObject = { operation: operation === 'binaryToPropery' ? 'binaryToProperty' : operation, binaryPropertyName: v(params.binaryPropertyName, 'data') };
  if (MOVE_OPS.includes(operation)) {
    p.destinationKey = v(params.destinationKey, 'data');
    if (has(o, 'encoding')) p.encoding = v(o.encoding, 'utf8');
    if (has(o, 'stripBOM')) p.stripBOM = bool(o.stripBOM, true);
  } else if (operation === 'pdf') {
    if (has(o, 'joinPages')) p.joinPages = bool(o.joinPages, true);
    if (has(o, 'maxPages')) p.maxPages = v(o.maxPages, 0);
    if (has(o, 'password')) p.password = v(o.password, '');
  } else {
    warn(`a operação "${operation}" do Extract from File não existe aqui`);
    return null;
  }
  p.keepSource = v(o.keepSource, 'none');
  return { type: 'extractFromFile', parameters: p };
}

// ---------- Nós antigos ----------

function spreadsheetFile({ params, warn, node }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'fromFile');
  if (operation === 'toFile') {
    const format = String(params.fileFormat ?? 'xls');
    if (!SHEET_FORMATS.includes(format)) return noOldSheet(format, warn);
    return { type: 'convertToFile', parameters: sheetWriteParams(format, params, 'spreadsheet') };
  }
  if (operation !== 'fromFile') {
    warn(`a operação "${operation}" do Spreadsheet File não existe aqui`);
    return null;
  }
  let format = (node.typeVersion ?? 1) >= 2 ? String(params.fileFormat ?? 'autodetect') : 'autodetect';
  if (format === 'autodetect') {
    warn('o formato da planilha era detectado pelo arquivo; ficou XLSX (troque a operação para CSV, HTML ou RTF se for o caso)');
    format = 'xlsx';
  }
  if (!SHEET_FORMATS.includes(format)) return noOldSheet(format, warn);
  if (format === 'csv') warn('o Spreadsheet File ignorava erros de leitura do CSV; aqui eles param o nó (ligue "Pular linhas com erro" se precisar)');
  return { type: 'extractFromFile', parameters: sheetReadParams(format, params, warn, true) };
}

function readPDF({ params }: Ctx): Converted {
  const p: JsonObject = { operation: 'pdf', binaryPropertyName: v(params.binaryPropertyName, 'data'), keepSource: 'binary' };
  if (params.encrypted === true && has(params, 'password')) p.password = v(params.password, '');
  return { type: 'extractFromFile', parameters: p };
}

function moveBinaryData({ params, warn }: Ctx): Converted | null {
  const mode = String(params.mode ?? 'binaryToJson');
  const o = opts(params);
  const keep = o.keepSource === true;
  if (mode === 'binaryToJson') {
    const setAllData = params.setAllData !== false;
    const p: JsonObject = { binaryPropertyName: v(params.sourceKey, 'data') };
    if (setAllData) {
      // Destino vazio no JSON: o conteúdo do arquivo vira o item inteiro.
      Object.assign(p, { operation: 'fromJson', destinationKey: '', keepSource: keep ? 'binary' : 'none' });
    } else {
      const operation = o.keepAsBase64 === true ? 'binaryToProperty' : o.jsonParse === true ? 'fromJson' : 'text';
      Object.assign(p, { operation, destinationKey: v(params.destinationKey, 'data'), keepSource: keep ? 'both' : 'json' });
    }
    if (has(o, 'encoding')) p.encoding = v(o.encoding, 'utf8');
    if (has(o, 'stripBOM')) p.stripBOM = bool(o.stripBOM, true);
    warn('item sem o arquivo era pulado no n8n; aqui dá erro');
    return { type: 'extractFromFile', parameters: p };
  }
  if (mode !== 'jsonToBinary') {
    warn(`o modo "${mode}" do Move Binary Data não existe aqui`);
    return null;
  }
  const p: JsonObject = { binaryPropertyName: v(params.destinationKey, 'data') };
  const convertAll = params.convertAllData !== false;
  if (convertAll) Object.assign(p, { operation: 'toJson', mode: 'each' });
  else if (o.dataIsBase64 === true) Object.assign(p, { operation: 'toBinary', sourceProperty: v(params.sourceKey, 'data') });
  else {
    Object.assign(p, { operation: 'toText', sourceProperty: v(params.sourceKey, 'data') });
    if (o.useRawData !== true) warn('o n8n gravava o campo com JSON.stringify (texto saía entre aspas); aqui o texto sai como está');
  }
  if (p.operation !== 'toBinary') {
    if (has(o, 'encoding')) p.encoding = v(o.encoding, 'utf8');
    if (has(o, 'addBOM')) p.addBOM = bool(o.addBOM, false);
  }
  if (has(o, 'fileName')) p.fileName = v(o.fileName, '');
  if (has(o, 'mimeType') && o.mimeType !== 'application/json') {
    if (p.operation === 'toBinary') p.mimeType = v(o.mimeType, '');
    else warn(`o tipo MIME "${String(o.mimeType)}" não foi importado (o arquivo sai como ${p.operation === 'toJson' ? 'application/json' : 'text/plain'})`);
  }
  warn(`o nó novo devolve só o arquivo; o n8n mantinha ${keep ? 'o JSON e ' : ''}os outros arquivos do item (use um Merge se precisar deles)`);
  return { type: 'convertToFile', parameters: p };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  convertToFile,
  extractFromFile,
  iCal,
  spreadsheetFile,
  readPDF,
  moveBinaryData,
};
