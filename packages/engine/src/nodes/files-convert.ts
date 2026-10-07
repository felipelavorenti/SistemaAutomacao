import * as cheerio from 'cheerio';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import * as ics from 'ics';
import { DateTime } from 'luxon';
import { getBinary, getBinaryBuffer, mimeTypeFromFileName, toBinary } from '../binary.js';
import type { NodeExecuteContext, NodeType, PropertyDescription } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue } from '../types.js';
import { setPath } from './formats.js';
import { getPath, isPlainObject } from './paths.js';

/**
 * Nós de arquivos, réplicas dos nós do n8n: Convert to File (itens viram arquivo), Extract from
 * File (arquivo vira itens) e iCalendar (cria um evento .ics). Planilhas usam exceljs (o n8n usa o
 * SheetJS, que não está disponível aqui; por isso não há XLS nem ODS), CSV usa csv-parse, PDF usa
 * pdfjs-dist e eventos usam a mesma biblioteca ics do n8n.
 */

// ---------- Utilitários ----------

const str = (value: JsonValue | undefined, fallback = ''): string => (value === undefined || value === null ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value));
const bool = (value: JsonValue | undefined): boolean => value === true || value === 'true';
const num = (value: JsonValue | undefined, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return value === '' || value === null || value === undefined || !Number.isFinite(n) ? fallback : n;
};
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Codificações do iconv-lite, as mesmas que o n8n oferece. */
const ENCODINGS = [
  'armscii8', 'ascii', 'base64', 'big5hkscs', 'binary', 'cesu8', 'cp1046', 'cp1124', 'cp1125', 'cp1129', 'cp1133', 'cp1161', 'cp1162', 'cp1163', 'cp437', 'cp720',
  'cp737', 'cp775', 'cp808', 'cp850', 'cp852', 'cp855', 'cp856', 'cp857', 'cp858', 'cp860', 'cp861', 'cp862', 'cp863', 'cp864', 'cp865', 'cp866', 'cp869', 'cp922',
  'cp936', 'cp949', 'cp950', 'eucjp', 'gb18030', 'gbk', 'georgianacademy', 'georgianps', 'hex', 'hproman8', 'iso646cn', 'iso646jp', 'iso88591', 'iso885910',
  'iso885911', 'iso885913', 'iso885914', 'iso885915', 'iso885916', 'iso88592', 'iso88593', 'iso88594', 'iso88595', 'iso88596', 'iso88597', 'iso88598', 'iso88599',
  'koi8r', 'koi8ru', 'koi8t', 'koi8u', 'maccenteuro', 'maccroatian', 'maccyrillic', 'macgreek', 'maciceland', 'macintosh', 'macroman', 'macromania', 'macthai',
  'macturkish', 'macukraine', 'mik', 'pt154', 'rk1048', 'shiftjis', 'tcvn', 'tis620', 'ucs2', 'utf16', 'utf16be', 'utf32', 'utf32be', 'utf32le', 'utf7', 'utf7imap',
  'utf8', 'viscii', 'windows1250', 'windows1251', 'windows1252', 'windows1253', 'windows1254', 'windows1255', 'windows1256', 'windows1257', 'windows1258', 'windows874',
].map((e) => ({ name: e, value: e }));

/** Codificações em que a marca BOM faz sentido. */
const BOM_ENCODINGS = ['utf8', 'cesu8', 'ucs2'];

function checkEncoding(encoding: string): string {
  if (!iconv.encodingExists(encoding)) throw new NodeOperationError(`A codificação "${encoding}" não existe`);
  return encoding;
}

/** Achata objetos como o flattenObject do n8n: { a: { b: 1 } } vira { "a.b": 1 }. */
export function flattenObject(data: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object') {
      for (const [sub, v] of Object.entries(flattenObject(value as JsonObject))) out[`${key}.${sub}`] = v;
    } else out[key] = value;
  }
  return out;
}

/** Colunas na ordem em que aparecem nos itens (como o json_to_sheet do SheetJS). */
function tableOf(items: Item[]): { headers: string[]; rows: JsonObject[] } {
  const rows = items.map((i) => flattenObject(i.json));
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) seen.add(key), headers.push(key);
  return { headers, rows };
}

/** Texto da célula como a planilha mostra (booleanos em TRUE/FALSE, como o SheetJS). */
function cellText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Formato de planilha que não existe aqui (a biblioteca do n8n para eles não está disponível). */
function unsupportedFormat(format: string): never {
  const name = format.toUpperCase();
  throw new NodeOperationError(`O formato ${name} não é suportado nesta plataforma. Use XLSX ou CSV (no Excel ou LibreOffice: Salvar como .xlsx ou .csv).`);
}

/**
 * Detecta o tipo pelo começo do conteúdo, como o n8n quando o arquivo não tem nome nem tipo; sem
 * reconhecer, fica texto.
 */
function sniffMimeType(buffer: Buffer): string {
  const hex = buffer.subarray(0, 8).toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('504b0304')) return 'application/zip';
  if (hex.startsWith('1f8b')) return 'application/gzip';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'text/plain';
}

/** Arquivo gerado, com nome "file.<extensão>" quando não há nome, como o n8n. */
function makeFile(content: Buffer, fileName: string, mimeType: string): BinaryData {
  const mime = mimeType || mimeTypeFromFileName(fileName) || sniffMimeType(content);
  const binary = toBinary(content, { fileName: fileName || undefined, mimeType: mime });
  if (!binary.fileName) binary.fileName = `file${binary.fileExtension ? `.${binary.fileExtension}` : ''}`;
  return binary;
}

/** Texto (ou objeto, que vira JSON) codificado como o createBinaryFromJson do n8n. */
function encodeText(value: JsonValue, opts: { encoding: string; addBOM: boolean; format?: boolean }): { buffer: Buffer; isJson: boolean } {
  const isJson = value !== null && typeof value === 'object';
  const text = isJson ? JSON.stringify(value, null, opts.format ? 2 : undefined) : String(value);
  return { buffer: iconv.encode(text, checkEncoding(opts.encoding || 'utf8'), { addBOM: opts.addBOM }), isJson };
}

async function eachItem(ctx: NodeExecuteContext, fn: (item: Item, i: number) => Promise<Item[] | Item>): Promise<Item[][]> {
  const input = ctx.inputs[0] ?? [];
  const out: Item[] = [];
  for (let i = 0; i < input.length; i++) {
    try {
      const result = await fn(input[i]!, i);
      if (Array.isArray(result)) out.push(...result);
      else out.push(result);
    } catch (err) {
      if (err instanceof NodeOperationError && input.length > 1 && !/^Item \d+:/.test(err.message)) throw new NodeOperationError(`Item ${i}: ${err.message}`, err.details);
      throw err;
    }
  }
  return [out];
}

// =====================================================================
// Planilhas (CSV, HTML, RTF e XLSX)
// =====================================================================

const SPREADSHEET_MIME: Record<string, string> = {
  csv: 'text/csv',
  html: 'text/html',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function toCsv(matrix: JsonValue[][], delimiter: string): string {
  const quote = (s: string) => (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') ? `"${s.replace(/"/g, '""')}"` : s);
  return matrix.map((row) => row.map((v) => quote(cellText(v))).join(delimiter)).join('\n');
}

function toHtmlTable(matrix: JsonValue[][]): string {
  const rows = matrix.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(cellText(v)).replace(/\r?\n/g, '<br/>')}</td>`).join('')}</tr>`).join('');
  return `<html><head><meta charset="utf-8"/><title>Planilha</title></head><body><table>${rows}</table></body></html>`;
}

/** Texto escapado para RTF (caracteres fora do ASCII viram \uN?). */
function rtfEscape(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\par ';
    else if (ch === '\r') continue;
    else if (code > 127) {
      // Fora do plano básico vira par de substitutos, cada um com \u.
      for (const unit of code > 0xffff ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [code]) out += `\\u${unit > 32767 ? unit - 65536 : unit}?`;
    } else out += ch;
  }
  return out;
}

/** Tabela em RTF no mesmo formato que o SheetJS escreve. */
function toRtf(matrix: JsonValue[][]): string {
  const width = Math.max(0, ...matrix.map((r) => r.length));
  let out = '{\\rtf1\\ansi';
  for (const row of matrix) {
    out += '\\trowd\\trautofit1';
    for (let c = 0; c < width; c++) out += `\\cellx${c + 1}`;
    out += '\\pard\\intbl';
    for (let c = 0; c < width; c++) {
      const text = cellText(row[c]);
      out += text ? ` ${rtfEscape(text)}\\cell` : ' \\cell';
    }
    out += '\\pard\\intbl\\row';
  }
  return `${out}}`;
}

async function toXlsx(matrix: JsonValue[][], sheetName: string, compression: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet;
  try {
    sheet = workbook.addWorksheet(sheetName || 'Sheet');
  } catch (err) {
    throw new NodeOperationError(`Nome de aba inválido "${sheetName}": ${errMessage(err)}`);
  }
  for (const row of matrix) sheet.addRow(row.map((v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : v)));
  const options = compression ? { zip: { compression: 'DEFLATE' as const, compressionOptions: { level: 9 } } } : {};
  return Buffer.from(await workbook.xlsx.writeBuffer(options));
}

/** Os itens numa planilha do formato pedido (um arquivo para todos os itens). */
async function itemsToSpreadsheet(
  items: Item[],
  format: string,
  opts: { headerRow: boolean; delimiter: string; sheetName: string; compression: boolean },
): Promise<Buffer> {
  const { headers, rows } = tableOf(items);
  const matrix: JsonValue[][] = rows.map((row) => headers.map((h) => (row[h] === undefined ? null : row[h]!)));
  if (opts.headerRow) matrix.unshift(headers);
  switch (format) {
    case 'csv':
      return Buffer.from(toCsv(matrix, opts.delimiter || ','), 'utf8');
    case 'html':
      return Buffer.from(toHtmlTable(matrix), 'utf8');
    case 'rtf':
      return Buffer.from(toRtf(matrix), 'latin1');
    case 'xlsx':
      return toXlsx(matrix, opts.sheetName, opts.compression);
    case 'xls':
    case 'ods':
      return unsupportedFormat(format);
    default:
      throw new NodeOperationError(`Formato desconhecido: ${format}`);
  }
}

/** Célula ainda sem valor. */
type Cell = JsonValue | undefined;

/**
 * Linhas da planilha viram itens como o sheet_to_json do SheetJS: com cabeçalho, a primeira linha
 * dá os nomes (repetidos ganham "_1", vazios viram "__EMPTY") e linhas vazias somem; sem
 * cabeçalho, cada linha vira { row: [...] }.
 */
export function matrixToItems(matrix: Cell[][], opts: { headerRow: boolean; includeEmptyCells: boolean }): Item[] {
  const width = Math.max(0, ...matrix.map((r) => r.length));
  if (!opts.headerRow) {
    return matrix.map((r) => {
      const row: JsonValue[] = [];
      // Sem células vazias, a linha vai até a última célula preenchida (os buracos saem null).
      let last = r.length - 1;
      while (last >= 0 && r[last] === undefined) last--;
      for (let c = 0; c < (opts.includeEmptyCells ? width : last + 1); c++) row.push(r[c] === undefined ? (opts.includeEmptyCells ? '' : null) : r[c]!);
      return { json: { row } };
    });
  }
  const [head = [], ...body] = matrix;
  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    const base = head[c] === undefined || head[c] === null || head[c] === '' ? '__EMPTY' : cellText(head[c]);
    let name = base;
    for (let n = 1; headers.includes(name); n++) name = `${base}_${n}`;
    headers.push(name);
  }
  const items: Item[] = [];
  for (const r of body) {
    const json: JsonObject = {};
    let empty = true;
    for (let c = 0; c < width; c++) {
      const v = r[c];
      if (v === undefined || v === null) {
        if (opts.includeEmptyCells) json[headers[c]!] = '';
        continue;
      }
      json[headers[c]!] = v;
      empty = false;
    }
    if (!empty) items.push({ json });
  }
  return items;
}

/** Número ou booleano lido de um texto, como as planilhas fazem (fora do modo "dados brutos"). */
function parseCellText(text: string, raw: boolean): Cell {
  if (text === '') return undefined;
  if (raw) return text;
  const t = text.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  return text;
}

/** Primeira tabela de um HTML, respeitando colspan e rowspan. */
function htmlToMatrix(html: string, raw: boolean): Cell[][] {
  const $ = cheerio.load(html);
  const table = $('table').first();
  if (!table.length) throw new NodeOperationError('O HTML não tem nenhuma tabela (<table>)');
  const matrix: Cell[][] = [];
  const taken: boolean[][] = [];
  table.find('tr').each((r, tr) => {
    // Só as linhas desta tabela, não as de tabelas dentro dela.
    if ($(tr).closest('table')[0] !== table[0]) return;
    matrix[r] ??= [];
    taken[r] ??= [];
    let c = 0;
    $(tr)
      .children('td, th')
      .each((_, td) => {
        while (taken[r]![c]) c++;
        const cell = $(td);
        cell.find('br').replaceWith('\n');
        const value = parseCellText(cell.text().trim(), raw);
        const colspan = Math.max(1, Number(cell.attr('colspan')) || 1);
        const rowspan = Math.max(1, Number(cell.attr('rowspan')) || 1);
        for (let dr = 0; dr < rowspan; dr++) {
          matrix[r + dr] ??= [];
          taken[r + dr] ??= [];
          for (let dc = 0; dc < colspan; dc++) taken[r + dr]![c + dc] = true;
        }
        matrix[r]![c] = value;
        c += colspan;
      });
  });
  return matrix.filter(Boolean).map((row) => Array.from(row, (v) => v));
}

/** Texto de um trecho de RTF: tira os comandos e decodifica \'hh e \uN. */
function rtfText(fragment: string): string {
  let out = '';
  for (let i = 0; i < fragment.length; ) {
    const ch = fragment[i]!;
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    if (ch !== '\\') {
      if (ch !== '\r' && ch !== '\n') out += ch;
      i++;
      continue;
    }
    const next = fragment[i + 1];
    if (next === '\\' || next === '{' || next === '}') {
      out += next;
      i += 2;
      continue;
    }
    if (next === "'") {
      out += iconv.decode(Buffer.from([parseInt(fragment.slice(i + 2, i + 4), 16)]), 'windows1252');
      i += 4;
      continue;
    }
    const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(fragment.slice(i));
    if (!m) {
      i += 2;
      continue;
    }
    i += m[0].length;
    if (m[1] === 'u' && m[2]) {
      const code = Number(m[2]);
      out += String.fromCharCode(code < 0 ? code + 65536 : code);
      if (fragment[i] === '?') i++;
    } else if (m[1] === 'par' || m[1] === 'line') out += '\n';
    else if (m[1] === 'tab') out += '\t';
  }
  return out;
}

/** Tabelas de um RTF (\trowd ... \row), uma linha da planilha por linha da tabela. */
function rtfToMatrix(rtf: string, raw: boolean): Cell[][] {
  const rows = rtf.match(/\\trowd[\s\S]*?\\row(?![a-zA-Z])/g);
  if (!rows) throw new NodeOperationError('O RTF não tem nenhuma tabela');
  return rows.map((row) => {
    const parts = row.replace(/\\row$/, '').split(/\\cell(?![a-zA-Z])/);
    parts.pop();
    return parts.map((p) => parseCellText(rtfText(p.replace(/\\trowd[\s\S]*?(?=\\pard|\\intbl)/, '')).trim(), raw));
  });
}

/** Coluna "A" -> 0, "AB" -> 27. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface Bounds {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Intervalo pedido: número é a linha inicial (a partir de 0); texto é "A1:C10". */
function applyRange(range: string, sheet: Bounds): Bounds {
  const value = range.trim();
  if (!value) return sheet;
  if (/^\d+$/.test(value)) return { ...sheet, r1: Number(value) };
  const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(value.replace(/\$/g, ''));
  if (!m) throw new NodeOperationError(`Intervalo inválido "${range}". Use o número da linha inicial (a partir de 0) ou o formato A1:C10.`);
  const start = { r1: Number(m[2]) - 1, c1: columnIndex(m[1]!) };
  return m[3] ? { ...start, r2: Number(m[4]) - 1, c2: columnIndex(m[3]) } : { ...start, r2: start.r1, c2: start.c1 };
}

/** Data do Excel como número serial (dias desde 30/12/1899). */
const excelSerial = (date: Date) => date.getTime() / 86_400_000 + 25569;

/** Valor da célula do exceljs como o n8n devolve: datas em ISO (ou serial, em dados brutos). */
function excelValue(value: ExcelJS.CellValue, raw: boolean): Cell {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return raw ? excelSerial(value) : value.toISOString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if ('result' in value) return excelValue((value as { result?: ExcelJS.CellValue }).result ?? null, raw);
    if ('formula' in value || 'sharedFormula' in value) return undefined;
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return excelValue((value as { text: ExcelJS.CellValue }).text, raw);
    if ('error' in value) return String(value.error);
  }
  return String(value as unknown);
}

async function xlsxToMatrix(buffer: Buffer, opts: { sheetName: string; range: string; raw: boolean }): Promise<Cell[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  if (!workbook.worksheets.length) throw new NodeOperationError('A planilha não tem nenhuma aba');
  let sheet = workbook.worksheets[0]!;
  if (opts.sheetName) {
    const found = workbook.worksheets.find((w) => w.name === opts.sheetName);
    if (!found) throw new NodeOperationError(`A planilha não tem a aba "${opts.sheetName}". Abas: ${workbook.worksheets.map((w) => w.name).join(', ')}`);
    sheet = found;
  }
  const cells: { r: number; c: number; v: Cell }[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      // Célula mesclada: só a primeira tem o valor, como no SheetJS.
      if (cell.isMerged && cell.master !== cell) return;
      const v = excelValue(cell.value, opts.raw);
      if (v !== undefined) cells.push({ r: rowNumber - 1, c: colNumber - 1, v });
    });
  });
  if (!cells.length) return [];
  const used: Bounds = {
    r1: Math.min(...cells.map((x) => x.r)),
    c1: Math.min(...cells.map((x) => x.c)),
    r2: Math.max(...cells.map((x) => x.r)),
    c2: Math.max(...cells.map((x) => x.c)),
  };
  const b = applyRange(opts.range, used);
  const matrix: Cell[][] = Array.from({ length: Math.max(0, b.r2 - b.r1 + 1) }, () => []);
  for (const { r, c, v } of cells) {
    if (r < b.r1 || r > b.r2 || c < b.c1 || c > b.c2) continue;
    matrix[r - b.r1]![c - b.c1] = v;
  }
  // Largura do intervalo inteiro, para o cabeçalho ter todas as colunas.
  if (matrix.length) matrix[0]!.length = Math.max(matrix[0]!.length, b.c2 - b.c1 + 1);
  return matrix;
}

interface CsvOptions {
  delimiter: string;
  encoding: string;
  enableBOM: boolean;
  relaxQuotes: boolean;
  headerRow: boolean;
  includeEmptyCells: boolean;
  maxRowCount: number;
  fromLine: number;
  skipRecordsWithErrors: boolean;
  maxSkippedRecords: number;
}

/** CSV em itens com o csv-parse, com as mesmas opções do n8n. */
export function csvToItems(buffer: Buffer, o: CsvOptions): Item[] {
  // Sem "Excluir BOM", a marca fica no primeiro nome de coluna, como no n8n.
  const text = iconv.decode(buffer, checkEncoding(o.encoding || 'utf8'), { stripBOM: false });
  let skipped = 0;
  let records: (string[] | Record<string, string>)[];
  try {
    records = parseCsv(text, {
      delimiter: o.delimiter || ',',
      bom: o.enableBOM,
      from_line: o.fromLine > 0 ? o.fromLine : undefined,
      to: o.maxRowCount > 0 ? o.maxRowCount : undefined,
      skip_empty_lines: true,
      skip_records_with_error: o.skipRecordsWithErrors,
      on_skip: () => {
        skipped++;
      },
      columns: o.headerRow,
      relax_quotes: o.relaxQuotes,
    }) as (string[] | Record<string, string>)[];
  } catch (err) {
    throw new NodeOperationError(`Não foi possível ler o CSV: ${errMessage(err)}`);
  }
  if (o.skipRecordsWithErrors && o.maxSkippedRecords > 0 && skipped > o.maxSkippedRecords) {
    throw new NodeOperationError(`Linhas com erro demais no CSV: ${skipped} (o máximo é ${o.maxSkippedRecords})`);
  }
  return records.map((record) => {
    // Igual ao n8n: sem as células vazias, uma linha sem cabeçalho vira objeto { "0": ..., "1": ... }.
    const value: JsonValue = o.includeEmptyCells ? (record as JsonValue) : Object.fromEntries(Object.entries(record).filter(([, v]) => v !== ''));
    return { json: o.headerRow ? (value as JsonObject) : { row: value } };
  });
}

// =====================================================================
// iCalendar (evento .ics)
// =====================================================================

/** Campos do evento, usados no iCalendar e no Convert to File (operação "Converter para ICS"). */
function icalProperties(showWhen?: Record<string, JsonValue[]>): PropertyDescription[] {
  const props: PropertyDescription[] = [
    { name: 'title', displayName: 'Título do evento', type: 'string', default: '', placeholder: 'Reunião de equipe' },
    {
      name: 'start',
      displayName: 'Início',
      type: 'dateTime',
      default: '',
      required: true,
      description: 'Data e hora de início. Em eventos de dia inteiro, a hora é ignorada.',
    },
    {
      name: 'end',
      displayName: 'Fim',
      type: 'dateTime',
      default: '',
      description: 'Data e hora de fim. Vazio: igual ao início. Em eventos de dia inteiro, a hora é ignorada.',
    },
    { name: 'allDay', displayName: 'Dia inteiro', type: 'boolean', default: false },
    {
      name: 'timezone',
      displayName: 'Fuso horário',
      type: 'string',
      default: 'America/Sao_Paulo',
      description: 'Fuso das datas sem fuso (ex.: 2026-05-10T14:00). O arquivo sai em UTC.',
    },
    { name: 'description', displayName: 'Descrição', type: 'string', default: '', multiline: true },
    { name: 'location', displayName: 'Local', type: 'string', default: '' },
    { name: 'url', displayName: 'URL', type: 'string', default: '', description: 'Endereço ligado ao evento.' },
    {
      name: 'attendees',
      displayName: 'Participantes',
      type: 'list',
      default: [],
      fields: [
        { name: 'name', displayName: 'Nome', type: 'string', default: '' },
        { name: 'email', displayName: 'E-mail', type: 'string', default: '', placeholder: 'nome@empresa.com' },
        { name: 'rsvp', displayName: 'Pedir confirmação', type: 'boolean', default: false },
      ],
    },
    { name: 'organizerName', displayName: 'Organizador: nome', type: 'string', default: '' },
    { name: 'organizerEmail', displayName: 'Organizador: e-mail', type: 'string', default: '', placeholder: 'nome@empresa.com' },
    { name: 'geoLat', displayName: 'Latitude', type: 'string', default: '' },
    { name: 'geoLon', displayName: 'Longitude', type: 'string', default: '' },
    {
      name: 'status',
      displayName: 'Status',
      type: 'options',
      default: '',
      options: [
        { name: '(não informar)', value: '' },
        { name: 'Confirmado', value: 'CONFIRMED' },
        { name: 'Cancelado', value: 'CANCELLED' },
        { name: 'Provisório', value: 'TENTATIVE' },
      ],
    },
    {
      name: 'busyStatus',
      displayName: 'Disponibilidade',
      type: 'options',
      default: '',
      description: 'Usado pelo Outlook e outros programas da Microsoft.',
      options: [
        { name: '(não informar)', value: '' },
        { name: 'Ocupado', value: 'BUSY' },
        { name: 'Provisório', value: 'TENTATIVE' },
      ],
    },
    {
      name: 'recurrenceRule',
      displayName: 'Regra de repetição',
      type: 'string',
      default: '',
      placeholder: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
      description: 'Regra RRULE do iCalendar.',
    },
    { name: 'calName', displayName: 'Nome do calendário', type: 'string', default: '', description: 'Usado pelo Apple Calendar e pelo Outlook.' },
    { name: 'uid', displayName: 'UID', type: 'string', default: '', description: 'Identificador único do evento. Vazio: gerado na hora.' },
    {
      name: 'sequence',
      displayName: 'Sequência',
      type: 'number',
      default: null,
      description: 'Número da revisão, ao enviar uma atualização do mesmo evento (mesmo UID).',
    },
  ];
  return showWhen ? props.map((p) => ({ ...p, showWhen })) : props;
}

/** Data em [ano, mês, dia, hora, minuto] para a biblioteca ics. */
function readIcalDate(value: JsonValue, zone: string, label: string): DateTime {
  const text = str(value).trim();
  if (!text) throw new NodeOperationError(`Informe a data de ${label}`);
  let date = /^\d+$/.test(text) ? DateTime.fromMillis(text.length < 12 ? Number(text) * 1000 : Number(text), { zone }) : DateTime.fromISO(text.replace(' ', 'T'), { zone });
  if (!date.isValid) date = DateTime.fromRFC2822(text, { zone });
  if (!date.isValid) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) date = DateTime.fromMillis(ms, { zone });
  }
  if (date.invalidReason === 'unsupported zone') throw new NodeOperationError(`O fuso horário ${zone} não é válido`);
  if (!date.isValid) throw new NodeOperationError(`Data de ${label} inválida: ${text}`);
  return date;
}

/** Monta o .ics de um item, como o Create Event do n8n. */
async function icalEvent(ctx: NodeExecuteContext, i: number): Promise<BinaryData> {
  const p = (name: string) => ctx.getParam(name, i);
  const zone = str(await p('timezone')).trim() || 'UTC';
  const allDay = bool(await p('allDay'));
  const startValue = await p('start');
  const endValue = await p('end');
  const start = readIcalDate(startValue, zone, 'início');
  let end = str(endValue).trim() ? readIcalDate(endValue, zone, 'fim') : start;
  // Dia inteiro: o fim no .ics é o dia seguinte (exclusivo).
  if (allDay) end = end.plus({ days: 1 });
  const toArray = (d: DateTime): ics.DateArray => {
    if (allDay) return [d.year, d.month, d.day];
    const u = d.toUTC();
    return [u.year, u.month, u.day, u.hour, u.minute];
  };

  const data: ics.EventAttributes = {
    title: str(await p('title')),
    start: toArray(start),
    end: toArray(end),
    startInputType: 'utc',
    endInputType: 'utc',
  } as ics.EventAttributes;
  const event = data as unknown as Record<string, unknown>;
  // Os segundos entram como no n8n (a biblioteca aceita até 6 posições).
  if (!allDay) {
    (event.start as number[]).push(start.toUTC().second);
    (event.end as number[]).push(end.toUTC().second);
  }
  for (const key of ['description', 'location', 'url', 'uid', 'calName', 'recurrenceRule', 'status', 'busyStatus']) {
    const value = str(await p(key)).trim();
    if (value) event[key] = value;
  }
  const sequence = await p('sequence');
  if (sequence !== null && sequence !== '' && sequence !== undefined) event.sequence = num(sequence, 0);
  const lat = str(await p('geoLat')).trim();
  const lon = str(await p('geoLon')).trim();
  if (lat || lon) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || !lat || !lon) throw new NodeOperationError('Latitude e longitude devem ser números');
    event.geo = { lat: Number(lat), lon: Number(lon) };
  }
  const organizerName = str(await p('organizerName')).trim();
  const organizerEmail = str(await p('organizerEmail')).trim();
  if (organizerName || organizerEmail) event.organizer = { name: organizerName, email: organizerEmail };
  const attendees = await p('attendees');
  if (Array.isArray(attendees) && attendees.length) {
    event.attendees = attendees.filter(isPlainObject).map((a) => ({ name: str(a.name), email: str(a.email), rsvp: bool(a.rsvp) }));
  }

  const result = ics.createEvent(data);
  if (result.error || !result.value) throw new NodeOperationError(`Não foi possível criar o evento: ${errMessage(result.error)}`);
  const fileName = str(await p('fileName')).trim() || 'event.ics';
  return toBinary(Buffer.from(result.value, 'utf8'), { fileName, mimeType: 'text/calendar' });
}

// ---------- Leitura de ICS ----------

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

function parseIcsLine(line: string): IcsProp | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const parts: string[] = [];
  let current = '';
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ';' && !inQuotes) parts.push(current), (current = '');
    else current += ch;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0]!.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeIcs = (s: string) => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** Data do ICS no formato do ts-ics (o que o n8n usa): { date, type, local? }. */
function icsDate(prop: IcsProp, raw = prop.value): JsonObject {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw.trim());
  if (!m) return { date: raw };
  const [, y, mo, d, h, mi, s, z] = m;
  if (prop.params.VALUE === 'DATE' || h === undefined) {
    return { date: new Date(Date.UTC(+y!, +mo! - 1, +d!)).toISOString(), type: 'DATE' };
  }
  const parts = { year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: +s! };
  const tzid = prop.params.TZID;
  if (!z && tzid) {
    const local = DateTime.fromObject(parts, { zone: tzid });
    const wall = DateTime.fromObject(parts, { zone: 'UTC' });
    if (local.isValid) {
      return { date: local.toUTC().toISO()!, type: 'DATE-TIME', local: { date: wall.toISO()!, timezone: tzid, tzoffset: local.toFormat('ZZZ') } };
    }
    // Fuso que não é IANA (ex.: nomes do Windows): a hora fica como está, em UTC.
    return { date: wall.toISO()!, type: 'DATE-TIME', local: { date: wall.toISO()!, timezone: tzid, tzoffset: '+0000' } };
  }
  return { date: DateTime.fromObject(parts, { zone: 'UTC' }).toISO()!, type: 'DATE-TIME' };
}

function icsDuration(value: string): JsonObject | string {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return value;
  const out: JsonObject = {};
  if (m[1] === '-') out.before = true;
  (['weeks', 'days', 'hours', 'minutes', 'seconds'] as const).forEach((k, idx) => {
    if (m[idx + 2] !== undefined) out[k] = Number(m[idx + 2]);
  });
  return out;
}

function icsPerson(prop: IcsProp): JsonObject {
  const out: JsonObject = { email: prop.value.replace(/^mailto:/i, '') };
  const map: Record<string, string> = { CN: 'name', DIR: 'dir', 'SENT-BY': 'sentBy', ROLE: 'role', PARTSTAT: 'partstat', MEMBER: 'member', 'DELEGATED-FROM': 'delegatedFrom' };
  for (const [param, key] of Object.entries(map)) if (prop.params[param] !== undefined) out[key] = prop.params[param]!;
  if (prop.params.RSVP !== undefined) out.rsvp = prop.params.RSVP.toUpperCase() === 'TRUE';
  return out;
}

function icsRecurrence(value: string): JsonObject {
  const out: JsonObject = {};
  const numbers: Record<string, string> = {
    BYSECOND: 'bySecond',
    BYMINUTE: 'byMinute',
    BYHOUR: 'byHour',
    BYMONTHDAY: 'byMonthday',
    BYYEARDAY: 'byYearday',
    BYWEEKNO: 'byWeekNo',
    BYMONTH: 'byMonth',
    BYSETPOS: 'bySetPos',
  };
  for (const part of value.split(';')) {
    const [k = '', v = ''] = part.split('=');
    const key = k.toUpperCase();
    if (key === 'FREQ') out.frequency = v;
    else if (key === 'UNTIL') out.until = icsDate({ name: 'UNTIL', params: {}, value: v });
    else if (key === 'COUNT' || key === 'INTERVAL') out[key.toLowerCase()] = Number(v);
    else if (key === 'WKST') out.workweekStart = v;
    else if (key === 'BYDAY') {
      out.byDay = v.split(',').map((d): JsonObject => {
        const m = /^([+-]?\d+)?([A-Z]{2})$/i.exec(d.trim());
        return m ? (m[1] ? { day: m[2]!.toUpperCase(), occurrence: Number(m[1]) } : { day: m[2]!.toUpperCase() }) : { day: d };
      });
    } else if (numbers[key]) out[numbers[key]!] = v.split(',').map(Number);
  }
  return out;
}

function icsEventLike(comp: IcsComponent): JsonObject {
  const out: JsonObject = {};
  const dates: Record<string, string> = { DTSTART: 'start', DTEND: 'end', DTSTAMP: 'stamp', CREATED: 'created', 'LAST-MODIFIED': 'lastModified', 'RECURRENCE-ID': 'recurrenceId', DUE: 'due' };
  const texts: Record<string, string> = {
    UID: 'uid',
    SUMMARY: 'summary',
    DESCRIPTION: 'description',
    LOCATION: 'location',
    URL: 'url',
    CLASS: 'class',
    STATUS: 'status',
    TRANSP: 'timeTransparent',
    COMMENT: 'comment',
    ACTION: 'action',
  };
  for (const prop of comp.props) {
    const { name, value } = prop;
    if (dates[name]) out[dates[name]!] = icsDate(prop);
    else if (texts[name]) out[texts[name]!] = unescapeIcs(value);
    else if (name === 'SEQUENCE' || name === 'PRIORITY' || name === 'REPEAT') out[name.toLowerCase()] = Number(value);
    else if (name === 'DURATION') out.duration = icsDuration(value);
    else if (name === 'GEO') {
      const [lat, lon] = value.split(/[;,]/).map(Number);
      out.geo = { lat: lat ?? null, lon: lon ?? null };
    } else if (name === 'ORGANIZER') out.organizer = icsPerson(prop);
    else if (name === 'ATTENDEE') ((out.attendees ??= []) as JsonValue[]).push(icsPerson(prop));
    else if (name === 'CATEGORIES') ((out.categories ??= []) as JsonValue[]).push(...value.split(/(?<!\\),/).map(unescapeIcs));
    else if (name === 'EXDATE') ((out.exceptionDates ??= []) as JsonValue[]).push(...value.split(',').map((v) => icsDate(prop, v)));
    else if (name === 'RRULE') out.recurrenceRule = icsRecurrence(value);
    else if (name === 'TRIGGER') {
      out.trigger =
        prop.params.VALUE === 'DATE-TIME' || /^\d{8}T/.test(value)
          ? { type: 'absolute', value: icsDate(prop) }
          : { type: 'relative', value: icsDuration(value), ...(prop.params.RELATED ? { options: { related: prop.params.RELATED } } : {}) };
    } else if (name === 'ATTACH') ((out.attach ??= []) as JsonValue[]).push(value);
  }
  const alarms = comp.children.filter((c) => c.type === 'VALARM').map(icsEventLike);
  if (alarms.length) out.alarms = alarms;
  return out;
}

/** Lê um calendário ICS no mesmo formato de objeto que o n8n devolve (biblioteca ts-ics). */
export function parseIcsCalendar(text: string): JsonObject {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const root: IcsComponent = { type: 'ROOT', props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseIcsLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const comp: IcsComponent = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1]!.children.push(comp);
      stack.push(comp);
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else stack[stack.length - 1]!.props.push(prop);
  }
  const calendar = root.children.find((c) => c.type === 'VCALENDAR');
  if (!calendar) throw new NodeOperationError('O arquivo não é um calendário ICS (falta BEGIN:VCALENDAR)');
  const get = (name: string) => calendar.props.find((p) => p.name === name)?.value;
  const out: JsonObject = { version: get('VERSION') ?? '', prodId: get('PRODID') ?? '' };
  if (get('METHOD')) out.method = get('METHOD')!;
  if (get('CALSCALE')) out.calScale = get('CALSCALE')!;
  const name = get('X-WR-CALNAME') ?? get('NAME');
  if (name) out.name = unescapeIcs(name);
  const events = calendar.children.filter((c) => c.type === 'VEVENT').map(icsEventLike);
  if (events.length) out.events = events;
  const todos = calendar.children.filter((c) => c.type === 'VTODO').map(icsEventLike);
  if (todos.length) out.todos = todos;
  return out;
}

// =====================================================================
// PDF
// =====================================================================

interface PdfTextItem {
  str?: string;
  transform?: number[];
}

/** Junta os trechos de texto da página, quebrando a linha quando a altura muda (como o n8n). */
function pdfPageText(items: PdfTextItem[]): string {
  let lastY: number | undefined;
  const text: string[] = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform?.[5];
    if (lastY === y || !lastY) text.push(item.str);
    else text.push(`\n${item.str}`);
    lastY = y;
  }
  return text.join('');
}

/** Texto e metadados do PDF, no mesmo formato do n8n (numpages, info, metadata, text, version). */
export async function extractPdf(buffer: Buffer, opts: { password?: string; maxPages?: number; joinPages?: boolean } = {}): Promise<JsonObject> {
  const { getDocument, version } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), password: opts.password || undefined, verbosity: 0 });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const code = (err as { code?: number }).code;
      if (name === 'PasswordException') {
        throw new NodeOperationError(code === 2 ? 'Senha do PDF incorreta' : 'O PDF é protegido por senha. Informe a senha no campo "Senha".');
      }
      if (name === 'InvalidPDFException') throw new NodeOperationError('O arquivo não é um PDF válido');
      throw new NodeOperationError(`Não foi possível ler o PDF: ${errMessage(err)}`);
    }
    const { info, metadata } = await document.getMetadata().catch(() => ({ info: null, metadata: null }));
    const pages: string[] = [];
    const total = document.numPages;
    const toRead = opts.maxPages && opts.maxPages > 0 && opts.maxPages < total ? opts.maxPages : total;
    for (let i = 1; i <= toRead; i++) {
      const page = await document.getPage(i);
      const content = await page.getTextContent();
      pages.push(pdfPageText(content.items as PdfTextItem[]));
    }
    const out: JsonObject = {
      numpages: total,
      numrender: total,
      info: info === null || info === undefined ? null : (JSON.parse(JSON.stringify(info)) as JsonValue),
    };
    if (metadata) out.metadata = JSON.parse(JSON.stringify(Object.fromEntries([...(metadata as unknown as Iterable<[string, unknown]>)]))) as JsonValue;
    out.text = opts.joinPages === false ? pages : pages.join('\n\n');
    out.version = version;
    return out;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

// =====================================================================
// Convert to File
// =====================================================================

const toFileOps = (...ops: string[]) => ({ operation: ops });

export const convertToFile: NodeType = {
  description: {
    type: 'convertToFile',
    displayName: 'Convert to File',
    description: 'Transforma os itens em arquivo: CSV, XLSX, HTML, RTF, JSON, texto, ICS ou um base64 de volta em arquivo.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'csv',
        options: [
          { name: 'Converter para CSV', value: 'csv' },
          { name: 'Converter para HTML (tabela)', value: 'html' },
          { name: 'Converter para ICS (evento)', value: 'iCal' },
          { name: 'Converter para JSON', value: 'toJson' },
          { name: 'Converter para RTF (tabela)', value: 'rtf' },
          { name: 'Converter para arquivo de texto', value: 'toText' },
          { name: 'Converter para XLSX (Excel)', value: 'xlsx' },
          { name: 'Base64 para arquivo', value: 'toBinary' },
        ],
      },
      {
        name: 'mode',
        displayName: 'Modo',
        type: 'options',
        default: 'once',
        options: [
          { name: 'Todos os itens num arquivo', value: 'once' },
          { name: 'Um arquivo por item', value: 'each' },
        ],
        showWhen: toFileOps('toJson'),
      },
      {
        name: 'sourceProperty',
        displayName: 'Campo de entrada',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'data',
        description: 'Campo com o conteúdo (texto ou base64). Aceita caminho com ponto (ex.: anexo.conteudo).',
        showWhen: toFileOps('toText', 'toBinary'),
      },
      ...icalProperties(toFileOps('iCal')),
      {
        name: 'binaryPropertyName',
        displayName: 'Campo do arquivo de saída',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Nome do campo de arquivo em que o resultado fica.',
      },
      { name: 'delimiter', displayName: 'Separador', type: 'string', default: ',', description: 'Caractere entre as colunas.', showWhen: toFileOps('csv') },
      {
        name: 'headerRow',
        displayName: 'Linha de cabeçalho',
        type: 'boolean',
        default: true,
        description: 'Escreve os nomes dos campos na primeira linha.',
        showWhen: toFileOps('csv', 'html', 'rtf', 'xlsx'),
      },
      { name: 'sheetName', displayName: 'Nome da aba', type: 'string', default: 'Sheet', showWhen: toFileOps('xlsx') },
      { name: 'compression', displayName: 'Compactar mais', type: 'boolean', default: false, description: 'Gera um arquivo menor.', showWhen: toFileOps('xlsx') },
      { name: 'format', displayName: 'Formatar o JSON', type: 'boolean', default: false, description: 'Com recuo e quebras de linha, mais fácil de ler.', showWhen: toFileOps('toJson') },
      { name: 'encoding', displayName: 'Codificação', type: 'options', default: 'utf8', options: ENCODINGS, showWhen: toFileOps('toJson', 'toText') },
      {
        name: 'addBOM',
        displayName: 'Incluir BOM',
        type: 'boolean',
        default: false,
        description: 'Marca no começo do arquivo que ajuda alguns programas (como o Excel) a reconhecer a codificação. Vale para utf8, cesu8 e ucs2.',
        showWhen: { operation: ['toJson', 'toText'], encoding: BOM_ENCODINGS },
      },
      {
        name: 'mimeType',
        displayName: 'Tipo MIME',
        type: 'string',
        default: '',
        placeholder: 'application/pdf',
        description: 'Vazio: pelo nome do arquivo ou pelo conteúdo.',
        showWhen: toFileOps('toBinary'),
      },
      {
        name: 'fileName',
        displayName: 'Nome do arquivo',
        type: 'string',
        default: '',
        description: 'Vazio: File.csv, File.xlsx etc. nas planilhas, file.json, file.txt ou event.ics.',
      },
    ],
  },
  async execute(ctx) {
    const operation = str(await ctx.getParam('operation', 0), 'csv');
    const input = ctx.inputs[0] ?? [];
    if (['csv', 'html', 'rtf', 'xlsx', 'xls', 'ods'].includes(operation)) {
      if (operation === 'xls' || operation === 'ods') unsupportedFormat(operation);
      if (!input.length) return [[]];
      const p = (name: string) => ctx.getParam(name, 0);
      const buffer = await itemsToSpreadsheet(input, operation, {
        headerRow: (await p('headerRow')) !== false,
        delimiter: str(await p('delimiter'), ','),
        sheetName: str(await p('sheetName')).trim() || 'Sheet',
        compression: bool(await p('compression')),
      });
      const fileName = str(await p('fileName')).trim() || `File.${operation}`;
      return [[{ json: {}, binary: { [str(await p('binaryPropertyName'), 'data') || 'data']: toBinary(buffer, { fileName, mimeType: SPREADSHEET_MIME[operation] }) } }]];
    }
    if (operation === 'toJson') {
      const mode = str(await ctx.getParam('mode', 0), 'once');
      const jsonFile = async (value: JsonValue, i: number): Promise<Item> => {
        const p = (name: string) => ctx.getParam(name, i);
        const { buffer } = encodeText(value, { encoding: str(await p('encoding'), 'utf8'), addBOM: bool(await p('addBOM')), format: bool(await p('format')) });
        return { json: {}, binary: { [str(await p('binaryPropertyName'), 'data') || 'data']: makeFile(buffer, str(await p('fileName')).trim(), 'application/json') } };
      };
      if (mode === 'each') return eachItem(ctx, (item, i) => jsonFile(item.json, i));
      if (!input.length) return [[]];
      return [[await jsonFile(input.map((item) => item.json), 0)]];
    }
    if (operation === 'toText' || operation === 'toBinary') {
      return eachItem(ctx, async (item, i) => {
        const p = (name: string) => ctx.getParam(name, i);
        const source = str(await p('sourceProperty')).trim();
        if (!source) throw new NodeOperationError('Informe o campo de entrada');
        const value = getPath(item.json, source);
        if (value === undefined) throw new NodeOperationError(`O campo "${source}" não existe no item`);
        const fileName = str(await p('fileName')).trim();
        let binary: BinaryData;
        if (operation === 'toText') {
          const { buffer, isJson } = encodeText(value, { encoding: str(await p('encoding'), 'utf8'), addBOM: bool(await p('addBOM')) });
          binary = makeFile(buffer, fileName || 'file.txt', isJson ? 'application/json' : 'text/plain');
        } else {
          if (typeof value !== 'string') throw new NodeOperationError(`O campo "${source}" não tem um texto em base64`);
          const base64 = value.replace(/^data:[^,]*;base64,/, '');
          binary = makeFile(Buffer.from(base64, 'base64'), fileName, str(await p('mimeType')).trim());
        }
        return { json: {}, binary: { [str(await p('binaryPropertyName'), 'data') || 'data']: binary } };
      });
    }
    if (operation === 'iCal') {
      return eachItem(ctx, async (_item, i) => ({ json: {}, binary: { [str(await ctx.getParam('binaryPropertyName', i), 'data') || 'data']: await icalEvent(ctx, i) } }));
    }
    throw new NodeOperationError(`Operação desconhecida: ${operation}`);
  },
};

// =====================================================================
// Extract from File
// =====================================================================

const fromFileOps = (...ops: string[]) => ({ operation: ops });
const SHEET_OPS = ['csv', 'html', 'rtf', 'xlsx'];
const MOVE_OPS = ['binaryToProperty', 'fromJson', 'text', 'fromIcs', 'xml'];

/** Monta o item de saída conforme "Manter a origem", como o n8n. */
function keepSourceItem(item: Item, property: string, keepSource: string, json: JsonObject, merge: boolean): Item {
  const keepJson = keepSource === 'json' || keepSource === 'both';
  const out: Item = { json: keepJson ? (merge ? { ...structuredClone(item.json), ...json } : json) : json };
  if (keepSource === 'binary' || keepSource === 'both') {
    if (item.binary) out.binary = item.binary;
  } else if (item.binary) {
    // Os outros arquivos do item seguem; só o lido sai.
    const rest = Object.fromEntries(Object.entries(item.binary).filter(([k]) => k !== property));
    if (Object.keys(rest).length) out.binary = rest;
  }
  return out;
}

const KEEP_SOURCE_OPTIONS = [
  { name: 'Nada', value: 'none' },
  { name: 'JSON do item', value: 'json' },
  { name: 'Arquivo do item', value: 'binary' },
  { name: 'JSON e arquivo', value: 'both' },
];

export const extractFromFile: NodeType = {
  description: {
    type: 'extractFromFile',
    displayName: 'Extract from File',
    description: 'Lê um arquivo do item e transforma em dados: CSV, XLSX, HTML, RTF, JSON, ICS, PDF, texto, XML ou base64.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'csv',
        options: [
          { name: 'Extrair de CSV', value: 'csv' },
          { name: 'Extrair de HTML (tabela)', value: 'html' },
          { name: 'Extrair de ICS (calendário)', value: 'fromIcs' },
          { name: 'Extrair de JSON', value: 'fromJson' },
          { name: 'Extrair de PDF', value: 'pdf' },
          { name: 'Extrair de RTF (tabela)', value: 'rtf' },
          { name: 'Extrair de arquivo de texto', value: 'text' },
          { name: 'Extrair de XML', value: 'xml' },
          { name: 'Extrair de XLSX (Excel)', value: 'xlsx' },
          { name: 'Arquivo para base64', value: 'binaryToProperty' },
        ],
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Campo do arquivo de entrada',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Nome do campo de arquivo do item que vai ser lido.',
      },
      {
        name: 'destinationKey',
        displayName: 'Campo de saída',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Campo que recebe o conteúdo. Aceita caminho com ponto. No JSON, vazio troca o item inteiro pelo conteúdo.',
        showWhen: fromFileOps(...MOVE_OPS),
      },
      // Planilhas
      { name: 'delimiter', displayName: 'Separador', type: 'string', default: ',', placeholder: ',', description: 'Caractere entre as colunas.', showWhen: fromFileOps('csv') },
      {
        name: 'csvEncoding',
        displayName: 'Codificação',
        type: 'options',
        default: 'utf-8',
        options: [
          { name: 'UTF-8', value: 'utf-8' },
          { name: 'Latin1 (ISO-8859-1)', value: 'latin1' },
          { name: 'Windows-1252', value: 'windows1252' },
          { name: 'ASCII', value: 'ascii' },
          { name: 'UTF-16LE', value: 'utf16le' },
          { name: 'UCS-2', value: 'ucs2' },
        ],
        showWhen: fromFileOps('csv'),
      },
      {
        name: 'enableBOM',
        displayName: 'Excluir BOM',
        type: 'boolean',
        default: false,
        description: 'Tira a marca BOM do começo do arquivo. Desligado, ela fica grudada no nome da primeira coluna.',
        showWhen: fromFileOps('csv'),
      },
      {
        name: 'relaxQuotes',
        displayName: 'Preservar aspas',
        type: 'boolean',
        default: false,
        description: 'Aspas sem fechamento ficam como parte do texto em vez de dar erro.',
        showWhen: fromFileOps('csv'),
      },
      { name: 'headerRow', displayName: 'Linha de cabeçalho', type: 'boolean', default: true, description: 'A primeira linha tem os nomes das colunas.', showWhen: fromFileOps(...SHEET_OPS) },
      {
        name: 'includeEmptyCells',
        displayName: 'Incluir células vazias',
        type: 'boolean',
        default: false,
        description: 'Células vazias entram com texto vazio.',
        showWhen: fromFileOps(...SHEET_OPS),
      },
      {
        name: 'maxRowCount',
        displayName: 'Máximo de linhas',
        type: 'number',
        default: -1,
        description: 'Para de ler depois desse número de linhas. -1: todas.',
        showWhen: fromFileOps('csv'),
      },
      {
        name: 'fromLine',
        displayName: 'Linha inicial',
        type: 'number',
        default: 0,
        description: 'Começa a ler nessa linha do arquivo (1 é a primeira). 0: do começo.',
        showWhen: fromFileOps('csv'),
      },
      {
        name: 'skipRecordsWithErrors',
        displayName: 'Pular linhas com erro',
        type: 'boolean',
        default: false,
        description: 'Linhas com número errado de colunas ou aspas quebradas são puladas.',
        showWhen: fromFileOps('csv'),
      },
      {
        name: 'maxSkippedRecords',
        displayName: 'Máximo de linhas puladas',
        type: 'number',
        default: -1,
        description: 'Dá erro se pular mais linhas que isso. -1: sem limite.',
        showWhen: { operation: ['csv'], skipRecordsWithErrors: [true] },
      },
      { name: 'sheetName', displayName: 'Nome da aba', type: 'string', default: '', description: 'Vazio: a primeira aba.', showWhen: fromFileOps('xlsx') },
      {
        name: 'range',
        displayName: 'Intervalo',
        type: 'string',
        default: '',
        placeholder: 'A1:D50',
        description: 'Número: a linha inicial (a partir de 0). Texto: intervalo no formato A1:D50. Vazio: a aba toda.',
        showWhen: fromFileOps('xlsx'),
      },
      {
        name: 'rawData',
        displayName: 'Dados brutos',
        type: 'boolean',
        default: false,
        description: 'No XLSX, datas saem como número serial do Excel; no HTML e RTF, números ficam como texto.',
        showWhen: fromFileOps('xlsx', 'html', 'rtf'),
      },
      // Texto, JSON, XML, ICS e base64
      { name: 'encoding', displayName: 'Codificação do arquivo', type: 'options', default: 'utf8', options: ENCODINGS, showWhen: fromFileOps('fromJson', 'text', 'fromIcs', 'xml') },
      {
        name: 'stripBOM',
        displayName: 'Remover BOM',
        type: 'boolean',
        default: true,
        description: 'Tira a marca BOM do começo do texto.',
        showWhen: { operation: ['fromJson', 'text', 'fromIcs', 'xml'], encoding: BOM_ENCODINGS },
      },
      // PDF
      { name: 'joinPages', displayName: 'Juntar páginas', type: 'boolean', default: true, description: 'Desligado, o texto sai numa lista com uma posição por página.', showWhen: fromFileOps('pdf') },
      { name: 'maxPages', displayName: 'Máximo de páginas', type: 'number', default: 0, description: 'Lê só as primeiras páginas. 0: todas.', showWhen: fromFileOps('pdf') },
      { name: 'password', displayName: 'Senha', type: 'string', default: '', description: 'Senha do PDF, se ele for protegido.', showWhen: fromFileOps('pdf') },
      {
        name: 'keepSource',
        displayName: 'Manter da entrada',
        type: 'options',
        default: 'none',
        options: KEEP_SOURCE_OPTIONS,
        description: 'O que do item de entrada vai junto na saída.',
        showWhen: fromFileOps(...MOVE_OPS, 'pdf'),
      },
    ],
  },
  async execute(ctx) {
    let operation = str(await ctx.getParam('operation', 0), 'csv');
    if (operation === 'binaryToPropery') operation = 'binaryToProperty';
    if (operation === 'xls' || operation === 'ods') unsupportedFormat(operation);

    return eachItem(ctx, async (item, i) => {
      const p = (name: string) => ctx.getParam(name, i);
      const property = str(await p('binaryPropertyName'), 'data').trim() || 'data';
      const binary = getBinary(item, property, i);
      const buffer = getBinaryBuffer(item, property, i);

      if (SHEET_OPS.includes(operation)) {
        const headerRow = (await p('headerRow')) !== false;
        const includeEmptyCells = bool(await p('includeEmptyCells'));
        try {
          if (operation === 'csv') {
            return csvToItems(buffer, {
              delimiter: str(await p('delimiter'), ','),
              encoding: str(await p('csvEncoding'), 'utf-8'),
              enableBOM: bool(await p('enableBOM')),
              relaxQuotes: bool(await p('relaxQuotes')),
              headerRow,
              includeEmptyCells,
              maxRowCount: num(await p('maxRowCount'), -1),
              fromLine: num(await p('fromLine'), 0),
              skipRecordsWithErrors: bool(await p('skipRecordsWithErrors')),
              maxSkippedRecords: num(await p('maxSkippedRecords'), -1),
            });
          }
          const raw = bool(await p('rawData'));
          const matrix =
            operation === 'xlsx'
              ? await xlsxToMatrix(buffer, { sheetName: str(await p('sheetName')).trim(), range: str(await p('range')), raw })
              : operation === 'html'
                ? htmlToMatrix(buffer.toString('utf8'), raw)
                : rtfToMatrix(buffer.toString('latin1'), raw);
          return matrixToItems(matrix, { headerRow, includeEmptyCells });
        } catch (err) {
          // Como o n8n: com a extensão de outro formato, o erro diz para trocar a operação.
          const ext = binary.fileExtension?.toLowerCase();
          if (ext && ext !== operation && !(err instanceof NodeOperationError && /aba|Intervalo|codificação|Linhas com erro/.test(err.message))) {
            throw new NodeOperationError(`O arquivo em "${property}" não está no formato ${operation.toUpperCase()}. Troque a operação ou escolha um arquivo ${operation.toUpperCase()}.`);
          }
          if (err instanceof NodeOperationError) throw err;
          throw new NodeOperationError(`Não foi possível ler o arquivo ${operation.toUpperCase()}: ${errMessage(err)}`);
        }
      }

      const keepSource = str(await p('keepSource'), 'none');
      if (operation === 'pdf') {
        const maxPages = num(await p('maxPages'), 0);
        const json = await extractPdf(buffer, { password: str(await p('password')), maxPages, joinPages: (await p('joinPages')) !== false });
        return keepSourceItem(item, property, keepSource, json, true);
      }

      if (MOVE_OPS.includes(operation)) {
        let value: JsonValue;
        if (operation === 'binaryToProperty') value = buffer.toString('base64');
        else {
          const encoding = checkEncoding(str(await p('encoding')).trim() || 'utf8');
          const stripBOM = (await p('stripBOM')) !== false;
          value = iconv.decode(buffer, encoding, { stripBOM });
          if (operation === 'fromJson') {
            try {
              value = value === '' ? {} : (JSON.parse(value) as JsonValue);
            } catch {
              throw new NodeOperationError(`O arquivo em "${property}" não está em formato JSON. Troque a operação ou escolha um arquivo JSON.`);
            }
          } else if (operation === 'fromIcs') value = parseIcsCalendar(value);
        }
        const destination = str(await p('destinationKey')).trim();
        const base: JsonObject = keepSource === 'json' || keepSource === 'both' ? structuredClone(item.json) : {};
        let json: JsonObject;
        if (!destination && operation === 'fromJson' && isPlainObject(value)) json = value;
        else {
          if (!destination) throw new NodeOperationError('Informe o campo de saída');
          json = base;
          setPath(json, destination, value);
        }
        return keepSourceItem(item, property, keepSource, json, false);
      }
      throw new NodeOperationError(`Operação desconhecida: ${operation}`);
    });
  },
};

// =====================================================================
// iCalendar
// =====================================================================

export const iCal: NodeType = {
  description: {
    type: 'iCal',
    displayName: 'iCalendar',
    description: 'Cria um arquivo de evento .ics para cada item (convite de calendário).',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'operation', displayName: 'Operação', type: 'options', default: 'createEventFile', options: [{ name: 'Criar arquivo de evento', value: 'createEventFile' }] },
      ...icalProperties(),
      {
        name: 'binaryPropertyName',
        displayName: 'Campo do arquivo de saída',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Nome do campo de arquivo em que o .ics fica.',
      },
      { name: 'fileName', displayName: 'Nome do arquivo', type: 'string', default: '', placeholder: 'evento.ics', description: 'Vazio: event.ics.' },
    ],
  },
  async execute(ctx) {
    const operation = str(await ctx.getParam('operation', 0), 'createEventFile');
    if (operation !== 'createEventFile') throw new NodeOperationError(`Operação desconhecida: ${operation}`);
    return eachItem(ctx, async (_item, i) => ({ json: {}, binary: { [str(await ctx.getParam('binaryPropertyName', i), 'data') || 'data']: await icalEvent(ctx, i) } }));
  },
};

export const fileConvertNodes: NodeType[] = [convertToFile, extractFromFile, iCal];
