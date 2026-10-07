import { createHash, createHmac, createSign, getHashes, randomBytes, randomUUID, type BinaryToTextEncoding } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DateTime, type DateTimeUnit, type DurationLikeObject, type DurationUnit } from 'luxon';
import { NodeHtmlMarkdown, type NodeHtmlMarkdownOptions } from 'node-html-markdown';
import * as OTPAuth from 'otpauth';
import showdown from 'showdown';
import { Builder, Parser } from 'xml2js';
import type { NodeExecuteContext, NodeType, PropertyDescription } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { getBinaryBuffer } from '../binary.js';
import { getPath, isPlainObject, splitPath } from './paths.js';

/**
 * Nós de formatos e utilidades, réplicas dos nós do n8n: Date & Time (V2), Crypto, HTML,
 * Markdown, XML e TOTP. Usam as mesmas bibliotecas do n8n (luxon, cheerio, showdown,
 * node-html-markdown, xml2js e otpauth) para o resultado sair igual.
 */

export const DEFAULT_DATE_TIMEZONE = 'America/Sao_Paulo';

// ---------- Utilitários ----------

const str = (value: JsonValue | undefined, fallback = ''): string => (value === undefined || value === null ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value));
const bool = (value: JsonValue | undefined): boolean => value === true || value === 'true';
const num = (value: JsonValue | undefined, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return value === '' || value === null || value === undefined || !Number.isFinite(n) ? fallback : n;
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Grava o valor no caminho ("a.b", "a[0].b"), criando objetos e listas no meio, como o set do lodash. */
export function setPath(target: JsonObject, path: string, value: JsonValue): void {
  const keys = splitPath(path);
  if (!keys.length) throw new NodeOperationError('Informe o nome do campo de saída');
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) throw new NodeOperationError(`O nome de campo "${path}" não é permitido`);
  let current: JsonObject | JsonValue[] = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const nextIsIndex = /^\d+$/.test(keys[i + 1]!);
    const existing: JsonValue | undefined = Array.isArray(current) ? current[Number(key)] : current[key];
    let next: JsonObject | JsonValue[];
    if (existing !== null && typeof existing === 'object') next = existing;
    else {
      next = nextIsIndex ? [] : {};
      if (Array.isArray(current)) current[Number(key)] = next;
      else current[key] = next;
    }
    current = next;
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else current[last] = value;
}

/** Valor JSON a partir do que as bibliotecas devolvem (tira undefined, como o n8n ao gravar o item). */
function toJson(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

async function eachItem(ctx: NodeExecuteContext, fn: (item: Item, i: number) => Promise<Item[] | Item>): Promise<Item[][]> {
  const input = ctx.inputs[0] ?? [];
  const out: Item[] = [];
  for (let i = 0; i < input.length; i++) {
    const result = await fn(input[i]!, i);
    if (Array.isArray(result)) out.push(...result);
    else out.push(result);
  }
  return [out];
}

// =====================================================================
// Date & Time
// =====================================================================

const TIME_UNITS = [
  { name: 'Anos', value: 'years' },
  { name: 'Trimestres', value: 'quarters' },
  { name: 'Meses', value: 'months' },
  { name: 'Semanas', value: 'weeks' },
  { name: 'Dias', value: 'days' },
  { name: 'Horas', value: 'hours' },
  { name: 'Minutos', value: 'minutes' },
  { name: 'Segundos', value: 'seconds' },
  { name: 'Milissegundos', value: 'milliseconds' },
];

const DATE_PARTS = [
  { name: 'Ano', value: 'year' },
  { name: 'Mês', value: 'month' },
  { name: 'Semana', value: 'week' },
  { name: 'Dia', value: 'day' },
  { name: 'Hora', value: 'hour' },
  { name: 'Minuto', value: 'minute' },
  { name: 'Segundo', value: 'second' },
];

/** Nome padrão do campo de saída de cada operação, como no n8n. */
export const DATE_OUTPUT_DEFAULTS: Record<string, string> = {
  getCurrentDate: 'currentDate',
  addToDate: 'newDate',
  subtractFromDate: 'newDate',
  formatDate: 'formattedDate',
  roundDate: 'roundedDate',
  getTimeBetweenDates: 'timeDifference',
  extractDate: 'datePart',
};

class DateParseError extends NodeOperationError {}

/**
 * Lê uma data como o parseDate do n8n: números viram timestamp (segundos com menos de 12
 * dígitos, senão milissegundos; com casas decimais, segundos), textos são lidos como ISO,
 * RFC 2822, HTTP ou SQL (ou no formato informado) e o resultado vai para o fuso pedido.
 * Sem fuso pedido, um texto com "+hh" fica nesse deslocamento e o resto vai para UTC.
 * Textos sem fuso são lidos no fuso em uso (no n8n, no fuso do servidor).
 */
export function parseDate(value: JsonValue | undefined, options: { timezone?: string; fromFormat?: string } = {}): DateTime {
  if (value === null || value === undefined || value === '') throw new DateParseError('Informe a data');
  let date: string | number = typeof value === 'number' ? value : str(value).trim();
  let zone = options.timezone;
  if (typeof date === 'string' && date !== '' && !Number.isNaN(Number(date)) && !options.fromFormat) date = Number(date);
  if (typeof date === 'number' && !Number.isInteger(date)) date = Math.round(date * 1000);

  let parsed: DateTime;
  if (typeof date === 'number') {
    parsed = String(date).length < 12 ? DateTime.fromSeconds(date) : DateTime.fromMillis(date);
  } else {
    if (!zone && date.includes('+')) zone = `Etc/GMT-${Number(date.split('+')[1]!.slice(0, 2))}`;
    const readZone = zone || 'Etc/UTC';
    if (options.fromFormat) {
      parsed = DateTime.fromFormat(date, options.fromFormat, { zone: readZone });
    } else {
      const opts = { zone: readZone, setZone: false };
      parsed = DateTime.fromISO(date, opts);
      if (!parsed.isValid) parsed = DateTime.fromRFC2822(date, opts);
      if (!parsed.isValid) parsed = DateTime.fromHTTP(date, opts);
      if (!parsed.isValid) parsed = DateTime.fromSQL(date, opts);
      if (!parsed.isValid) {
        const ms = Date.parse(date);
        if (Number.isFinite(ms)) parsed = DateTime.fromMillis(ms);
      }
    }
  }
  parsed = parsed.setZone(zone || 'Etc/UTC');
  if (parsed.invalidReason === 'unsupported zone') throw new DateParseError(`O fuso horário ${zone} não é válido`);
  if (!parsed.isValid) throw new DateParseError(`Formato de data inválido: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  return parsed;
}

function checkZone(zone: string): string {
  if (DateTime.now().setZone(zone).invalidReason === 'unsupported zone') throw new NodeOperationError(`O fuso horário ${zone} não é válido. Confira o nome (ex.: America/Sao_Paulo).`);
  return zone;
}

export const dateTime: NodeType = {
  description: {
    type: 'dateTime',
    displayName: 'Date & Time',
    description: 'Manipula datas e horas: data atual, somar ou subtrair tempo, formatar, arredondar, diferença entre datas e partes de uma data.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'getCurrentDate',
        options: [
          { name: 'Pegar a data atual', value: 'getCurrentDate' },
          { name: 'Somar a uma data', value: 'addToDate' },
          { name: 'Subtrair de uma data', value: 'subtractFromDate' },
          { name: 'Formatar uma data', value: 'formatDate' },
          { name: 'Arredondar uma data', value: 'roundDate' },
          { name: 'Tempo entre datas', value: 'getTimeBetweenDates' },
          { name: 'Extrair parte de uma data', value: 'extractDate' },
        ],
      },
      {
        name: 'includeTime',
        displayName: 'Incluir a hora atual',
        type: 'boolean',
        default: true,
        description: 'Desligado, a hora fica meia-noite.',
        showWhen: { operation: ['getCurrentDate'] },
      },
      {
        name: 'magnitude',
        displayName: 'Data',
        type: 'string',
        default: '',
        required: true,
        placeholder: '={{ $json.vencimento }}',
        description: 'A data que vai mudar (ISO, timestamp ou outro formato reconhecido).',
        showWhen: { operation: ['addToDate', 'subtractFromDate'] },
      },
      {
        name: 'timeUnit',
        displayName: 'Unidade de tempo',
        type: 'options',
        default: 'days',
        options: TIME_UNITS,
        showWhen: { operation: ['addToDate', 'subtractFromDate'] },
      },
      {
        name: 'duration',
        displayName: 'Quantidade',
        type: 'number',
        default: 0,
        description: 'Quantas unidades de tempo somar ou subtrair.',
        showWhen: { operation: ['addToDate', 'subtractFromDate'] },
      },
      {
        name: 'date',
        displayName: 'Data',
        type: 'string',
        default: '',
        placeholder: '={{ $json.criadoEm }}',
        showWhen: { operation: ['formatDate', 'roundDate', 'extractDate'] },
      },
      {
        name: 'format',
        displayName: 'Formato',
        type: 'options',
        default: 'MM/dd/yyyy',
        showWhen: { operation: ['formatDate'] },
        options: [
          { name: 'Formato personalizado', value: 'custom' },
          { name: 'DD/MM/AAAA (ex.: 09/04/1986)', value: 'dd/MM/yyyy' },
          { name: 'MM/DD/AAAA (ex.: 04/09/1986)', value: 'MM/dd/yyyy' },
          { name: 'AAAA/MM/DD (ex.: 1986/04/09)', value: 'yyyy/MM/dd' },
          { name: 'MMMM DD AAAA (ex.: April 09 1986)', value: 'MMMM dd yyyy' },
          { name: 'MM-DD-AAAA (ex.: 04-09-1986)', value: 'MM-dd-yyyy' },
          { name: 'AAAA-MM-DD (ex.: 1986-04-09)', value: 'yyyy-MM-dd' },
          { name: 'Timestamp Unix (ex.: 1672531200)', value: 'X' },
          { name: 'Timestamp Unix em ms (ex.: 1674691200000)', value: 'x' },
        ],
      },
      {
        name: 'customFormat',
        displayName: 'Formato personalizado',
        type: 'string',
        default: '',
        placeholder: "dd/MM/yyyy HH:mm",
        description: 'Tokens do luxon (diferenciam maiúsculas): yyyy ano, MM mês, dd dia, HH hora, mm minuto, ss segundo, cccc dia da semana. Texto fixo entre aspas simples.',
        showWhen: { operation: ['formatDate'], format: ['custom'] },
      },
      {
        name: 'fromFormat',
        displayName: 'Formato da data de entrada',
        type: 'string',
        default: '',
        placeholder: 'yyyyMMdd',
        description: 'Opcional. Use quando a data não é reconhecida sozinha (tokens do luxon).',
        showWhen: { operation: ['formatDate'] },
      },
      {
        name: 'useWorkflowTimezone',
        displayName: 'Usar o fuso horário do nó',
        type: 'boolean',
        default: false,
        description: 'Ligado, formata no fuso abaixo. Desligado (como no n8n), usa o deslocamento "+hh" da própria data ou UTC.',
        showWhen: { operation: ['formatDate'] },
      },
      {
        name: 'mode',
        displayName: 'Modo',
        type: 'options',
        default: 'roundDown',
        options: [
          { name: 'Arredondar para baixo', value: 'roundDown' },
          { name: 'Arredondar para cima', value: 'roundUp' },
        ],
        showWhen: { operation: ['roundDate'] },
      },
      {
        name: 'toNearest',
        displayName: 'Para o início do(a)',
        type: 'options',
        default: 'month',
        options: DATE_PARTS,
        showWhen: { operation: ['roundDate'], mode: ['roundDown'] },
      },
      {
        name: 'to',
        displayName: 'Para',
        type: 'options',
        default: 'month',
        options: [{ name: 'Fim do mês (início do mês seguinte)', value: 'month' }],
        showWhen: { operation: ['roundDate'], mode: ['roundUp'] },
      },
      {
        name: 'startDate',
        displayName: 'Data inicial',
        type: 'string',
        default: '',
        showWhen: { operation: ['getTimeBetweenDates'] },
      },
      {
        name: 'endDate',
        displayName: 'Data final',
        type: 'string',
        default: '',
        showWhen: { operation: ['getTimeBetweenDates'] },
      },
      {
        name: 'units',
        displayName: 'Unidades',
        type: 'multiOptions',
        default: ['day'],
        options: [...DATE_PARTS, { name: 'Milissegundo', value: 'millisecond' }],
        showWhen: { operation: ['getTimeBetweenDates'] },
      },
      {
        name: 'isoString',
        displayName: 'Saída como texto ISO',
        type: 'boolean',
        default: false,
        description: 'Ligado, devolve a duração como texto ISO 8601 (ex.: P1DT2H) em vez de um objeto.',
        showWhen: { operation: ['getTimeBetweenDates'] },
      },
      {
        name: 'part',
        displayName: 'Parte',
        type: 'options',
        default: 'month',
        options: DATE_PARTS,
        showWhen: { operation: ['extractDate'] },
      },
      {
        name: 'outputFieldName',
        displayName: 'Nome do campo de saída',
        type: 'string',
        default: '',
        placeholder: 'vazio: currentDate, newDate, formattedDate...',
        description: 'Vazio usa o nome padrão do n8n para a operação (currentDate, newDate, formattedDate, roundedDate, timeDifference ou datePart).',
      },
      {
        name: 'timezone',
        displayName: 'Fuso horário',
        type: 'string',
        default: DEFAULT_DATE_TIMEZONE,
        placeholder: DEFAULT_DATE_TIMEZONE,
        description: 'Fuso das contas e do resultado (no n8n, o fuso do fluxo). Use "GMT" para +00:00.',
      },
      {
        name: 'includeInputFields',
        displayName: 'Incluir os campos de entrada',
        type: 'boolean',
        default: false,
        description: 'Ligado, o item de saída leva todos os campos do item de entrada.',
      },
    ],
  },
  async execute(ctx) {
    const operation = str(await ctx.getParam('operation', 0), 'getCurrentDate');
    const includeInputFields = bool(await ctx.getParam('includeInputFields', 0));
    return eachItem(ctx, async (item, i) => {
      const p = (name: string) => ctx.getParam(name, i);
      const out: JsonObject = includeInputFields ? { ...item.json } : {};
      const zone = checkZone(str(await p('timezone')).trim() || DEFAULT_DATE_TIMEZONE);
      const field = str(await p('outputFieldName')).trim() || DATE_OUTPUT_DEFAULTS[operation] || 'data';
      let result: JsonValue;
      switch (operation) {
        case 'getCurrentDate': {
          const now = DateTime.now().setZone(zone);
          result = (bool(await p('includeTime')) ? now : now.startOf('day')).toString();
          break;
        }
        case 'addToDate':
        case 'subtractFromDate': {
          const date = parseDate(await p('magnitude'), { timezone: zone });
          const unit = str(await p('timeUnit'), 'days') as keyof DurationLikeObject;
          const amount = num(await p('duration'), 0);
          result = (operation === 'addToDate' ? date.plus({ [unit]: amount }) : date.minus({ [unit]: amount })).toString();
          break;
        }
        case 'formatDate': {
          const raw = await p('date');
          if (raw === null || raw === undefined) {
            result = null;
            break;
          }
          const fromFormat = str(await p('fromFormat')).trim() || undefined;
          const date = parseDate(raw, { timezone: bool(await p('useWorkflowTimezone')) ? zone : undefined, fromFormat });
          const format = str(await p('format'), 'MM/dd/yyyy');
          const pattern = format === 'custom' ? str(await p('customFormat')) : format;
          if (!pattern) throw new NodeOperationError('Informe o formato personalizado');
          result = date.toFormat(pattern);
          break;
        }
        case 'roundDate': {
          const date = parseDate(await p('date'), { timezone: zone });
          if (str(await p('mode'), 'roundDown') === 'roundUp') {
            const to = str(await p('to'), 'month') as DateTimeUnit;
            result = date.plus({ [to]: 1 }).startOf(to).toString();
          } else {
            result = date.startOf(str(await p('toNearest'), 'month') as DateTimeUnit).toString();
          }
          break;
        }
        case 'getTimeBetweenDates': {
          const start = parseDate(await p('startDate'), { timezone: zone });
          const end = parseDate(await p('endDate'), { timezone: zone });
          const rawUnits = await p('units');
          const units = (Array.isArray(rawUnits) ? rawUnits.map((u) => str(u)) : str(rawUnits).split(',').map((u) => u.trim())).filter(Boolean) as DurationUnit[];
          const duration = end.diff(start, units.length ? units : ['day']);
          result = bool(await p('isoString')) ? duration.toString() : (duration.toObject() as JsonObject);
          break;
        }
        case 'extractDate': {
          const date = parseDate(await p('date'), { timezone: zone });
          const part = str(await p('part'), 'month');
          result = part === 'week' ? date.weekNumber : date.get(part as keyof DateTime);
          break;
        }
        default:
          throw new NodeOperationError(`Operação desconhecida: ${operation}`);
      }
      out[field] = result as JsonValue;
      return { json: out };
    });
  },
};

// =====================================================================
// Crypto
// =====================================================================

const HASH_TYPES = ['MD5', 'SHA1', 'SHA256', 'SHA3-256', 'SHA3-384', 'SHA3-512', 'SHA384', 'SHA512'].map((v) => ({ name: v, value: v }));
const UNSUPPORTED_SIGN = ['RSA-MD4', 'RSA-MDC2', 'md4', 'md4WithRSAEncryption', 'mdc2', 'mdc2WithRSA'];
const SIGN_ALGORITHMS = getHashes()
  .filter((a) => !UNSUPPORTED_SIGN.includes(a))
  .map((a) => ({ name: a, value: a }));
const ENCODINGS = [
  { name: 'BASE64', value: 'base64' },
  { name: 'HEX', value: 'hex' },
];

/** Refaz as quebras de linha de uma chave PEM colada numa linha só (como o formatPemBlock do n8n). */
export function formatPem(key: string): string {
  const text = key.trim().replace(/\\n/g, '\n');
  const m = /^(-----BEGIN [^-]+-----)\s*([\s\S]*?)\s*(-----END [^-]+-----)$/.exec(text);
  if (!m) return text;
  const body = m[2]!;
  // Cabeçalhos como "Proc-Type:" exigem as linhas originais.
  if (body.includes(':')) return text;
  const clean = body.replace(/\s+/g, '');
  return `${m[1]}\n${clean.match(/.{1,64}/g)?.join('\n') ?? ''}\n${m[3]}\n`;
}

export const cryptoNode: NodeType = {
  description: {
    type: 'crypto',
    displayName: 'Crypto',
    description: 'Gera hash, HMAC, assinatura com chave privada ou textos aleatórios (UUID, hex, base64).',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'action',
        displayName: 'Ação',
        type: 'options',
        default: 'hash',
        options: [
          { name: 'Hash de um texto', value: 'hash' },
          { name: 'HMAC de um texto', value: 'hmac' },
          { name: 'Assinar com chave privada', value: 'sign' },
          { name: 'Gerar texto aleatório', value: 'generate' },
        ],
      },
      { name: 'type', displayName: 'Tipo', type: 'options', default: 'SHA256', options: HASH_TYPES, showWhen: { action: ['hash', 'hmac'] } },
      {
        name: 'binaryData',
        displayName: 'Usar um arquivo do item',
        type: 'boolean',
        default: false,
        description: 'Ligado, calcula o hash ou o HMAC do conteúdo de um arquivo do item em vez de um texto.',
        showWhen: { action: ['hash', 'hmac'] },
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Propriedade do arquivo',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Nome do arquivo no item (ex.: data, attachment_0).',
        showWhen: { action: ['hash', 'hmac'], binaryData: [true] },
      },
      {
        name: 'value',
        displayName: 'Valor',
        type: 'string',
        default: '',
        required: true,
        placeholder: '={{ $json.senha }}',
        description: 'O texto a processar.',
        showWhen: { action: ['hash', 'hmac', 'sign'], binaryData: [false] },
      },
      { name: 'secret', displayName: 'Segredo', type: 'string', default: '', required: true, description: 'Chave secreta do HMAC.', showWhen: { action: ['hmac'] } },
      {
        name: 'connection',
        displayName: 'Chave privada',
        type: 'connection',
        default: '',
        required: true,
        connectionTypes: ['cryptoPrivateKey'],
        description: 'Conexão com a chave privada (PEM) usada na assinatura.',
        showWhen: { action: ['sign'] },
      },
      { name: 'algorithm', displayName: 'Algoritmo', type: 'options', default: 'RSA-SHA256', options: SIGN_ALGORITHMS, showWhen: { action: ['sign'] } },
      { name: 'encoding', displayName: 'Codificação', type: 'options', default: 'hex', options: ENCODINGS, showWhen: { action: ['hash', 'hmac', 'sign'] } },
      {
        name: 'encodingType',
        displayName: 'Tipo',
        type: 'options',
        default: 'uuid',
        options: [
          { name: 'ASCII', value: 'ascii' },
          { name: 'BASE64', value: 'base64' },
          { name: 'HEX', value: 'hex' },
          { name: 'UUID', value: 'uuid' },
        ],
        showWhen: { action: ['generate'] },
      },
      { name: 'stringLength', displayName: 'Tamanho', type: 'number', default: 32, description: 'Quantidade de caracteres do texto gerado.', showWhen: { action: ['generate'], encodingType: ['ascii', 'base64', 'hex'] } },
      {
        name: 'dataPropertyName',
        displayName: 'Nome do campo de saída',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Campo onde o resultado é gravado; aceita caminho com pontos (ex.: seguranca.hash).',
      },
    ],
  },
  async execute(ctx) {
    const action = str(await ctx.getParam('action', 0), 'hash');
    let privateKey = '';
    if (action === 'sign') {
      const connectionId = str(await ctx.getParam('connection', 0));
      if (!connectionId) throw new NodeOperationError('Escolha a conexão com a chave privada');
      const connection = await ctx.getConnection(connectionId);
      privateKey = str(connection.data.privateKey);
      if (!privateKey.trim()) throw new NodeOperationError('A conexão não tem chave privada. Preencha a chave na conexão.');
      privateKey = formatPem(privateKey);
    }
    return eachItem(ctx, async (item, i) => {
      const p = (name: string) => ctx.getParam(name, i);
      const field = str(await p('dataPropertyName'), 'data');
      let result: string;
      if (action === 'generate') {
        const type = str(await p('encodingType'), 'uuid');
        if (type === 'uuid') result = randomUUID();
        else {
          const length = Math.max(0, Math.trunc(num(await p('stringLength'), 32)));
          const raw = randomBytes(length).toString(type as BufferEncoding);
          result = (type === 'base64' ? raw.replace(/\W/g, '') : raw).slice(0, length);
        }
      } else {
        const encoding = str(await p('encoding'), 'hex') as BinaryToTextEncoding;
        const fromFile = (action === 'hash' || action === 'hmac') && bool(await p('binaryData'));
        // Como no n8n: com arquivo, o hash é do conteúdo em bytes, não do texto.
        const value: string | Buffer = fromFile ? getBinaryBuffer(item, str(await p('binaryPropertyName'), 'data') || 'data', i) : str(await p('value'));
        if (action === 'hash' || action === 'hmac') {
          const type = str(await p('type'), 'SHA256');
          if (action === 'hmac') {
            const secret = str(await p('secret'));
            if (!secret) throw new NodeOperationError('Informe o segredo do HMAC');
            result = createHmac(type, secret).update(value).digest(encoding);
          } else result = createHash(type).update(value).digest(encoding);
        } else if (action === 'sign') {
          const sign = createSign(str(await p('algorithm'), 'RSA-SHA256'));
          sign.write(value);
          sign.end();
          try {
            result = sign.sign(privateKey, encoding);
          } catch (err) {
            throw new NodeOperationError(`Não foi possível assinar: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else throw new NodeOperationError(`Ação desconhecida: ${action}`);
      }
      const json: JsonObject = field.includes('.') ? structuredClone(item.json) : { ...item.json };
      setPath(json, field, result);
      // O n8n mantém os arquivos do item na saída do Crypto.
      return item.binary ? { json, binary: item.binary } : { json };
    });
  },
};

// =====================================================================
// HTML
// =====================================================================

export const HTML_PLACEHOLDER = `<!DOCTYPE html>

<html>
<head>
  <meta charset="UTF-8" />
  <title>Meu documento HTML</title>
</head>
<body>
  <div class="container">
    <h1>Este é um título H1</h1>
    <h2>Este é um título H2</h2>
    <p>Este é um parágrafo</p>
  </div>
</body>
</html>

<style>
.container {
  background-color: #ffffff;
  text-align: center;
  padding: 16px;
  border-radius: 8px;
}

h1 {
  color: #ff6d5a;
  font-size: 24px;
  font-weight: bold;
  padding: 8px;
}

h2 {
  color: #909399;
  font-size: 18px;
  font-weight: bold;
  padding: 8px;
}
</style>`;

/** "nome_do_campo" vira "Nome Do Campo", como no n8n. */
export function capitalizeHeader(header: string, capitalize?: boolean): string {
  if (!capitalize) return header;
  return header
    .split('_')
    .filter((w) => w)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

const BLOCK_BREAKS: Record<string, [number, number]> = {
  p: [2, 2],
  pre: [2, 2],
  blockquote: [2, 2],
  h1: [3, 2],
  h2: [3, 2],
  h3: [2, 2],
  h4: [2, 2],
  h5: [2, 2],
  h6: [2, 2],
  ul: [2, 2],
  ol: [2, 2],
  table: [2, 2],
  hr: [2, 2],
  div: [1, 1],
  article: [1, 1],
  aside: [1, 1],
  section: [1, 1],
  header: [1, 1],
  footer: [1, 1],
  main: [1, 1],
  nav: [1, 1],
  form: [1, 1],
  figure: [1, 1],
  figcaption: [1, 1],
  dl: [1, 1],
  dt: [1, 1],
  dd: [1, 1],
  address: [1, 1],
  li: [1, 1],
  tr: [1, 1],
  caption: [1, 1],
};
const SKIPPED_TAGS = new Set(['script', 'style', 'head', 'noscript', 'template', 'svg']);

/**
 * Texto legível de um trecho de HTML, no estilo do html-to-text que o n8n usa (versão 1.2 do
 * nó): blocos separados por linhas, títulos em maiúsculas, links e imagens com o endereço entre
 * colchetes, listas com "*" ou número. Diferente do n8n, não quebra linhas longas em 80 colunas.
 */
export function htmlToText(html: string, skipSelectors = ''): string {
  const $ = cheerio.load(html, null, false);
  for (const selector of skipSelectors.split(',').map((s) => s.trim()).filter(Boolean)) $(selector).remove();
  let out = '';
  let pending = 0;
  let upper = 0;
  let pre = 0;
  const breakTo = (n: number) => {
    pending = Math.max(pending, n);
  };
  const write = (text: string, raw = false) => {
    if (!raw) {
      text = text.replace(/\s+/g, ' ');
      if (upper) text = text.toUpperCase();
    }
    if (!text) return;
    if (pending && out) {
      out = out.replace(/[ \t]+$/, '') + '\n'.repeat(Math.max(0, pending - (out.match(/\n*$/)?.[0].length ?? 0)));
      if (!raw) text = text.replace(/^ /, '');
    } else if (!raw && (out === '' || /[\s]$/.test(out))) text = text.replace(/^ /, '');
    pending = 0;
    out += text;
  };
  const walk = (nodes: AnyNode[], listCtx?: { ordered: boolean; n: number }) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        write((node as unknown as { data: string }).data, pre > 0);
        continue;
      }
      if (node.type !== 'tag' && node.type !== 'root') continue;
      const el = node as Element;
      const tag = el.name?.toLowerCase();
      if (SKIPPED_TAGS.has(tag)) continue;
      if (tag === 'br') {
        out = out.replace(/[ \t]+$/, '') + '\n';
        pending = 0;
        continue;
      }
      if (tag === 'img') {
        const alt = (el.attribs.alt ?? '').trim();
        const src = (el.attribs.src ?? '').trim();
        write(!src ? alt : !alt ? `[${src}]` : `${alt} [${src}]`);
        continue;
      }
      const breaks = BLOCK_BREAKS[tag];
      if (breaks) breakTo(breaks[0]);
      if (tag === 'hr') {
        write('-'.repeat(40), true);
        breakTo(2);
        continue;
      }
      if (/^h[1-6]$/.test(tag)) upper++;
      if (tag === 'pre') pre++;
      if (tag === 'li') {
        const prefix = listCtx?.ordered ? `${++listCtx.n}. ` : ' * ';
        write(prefix, true);
      }
      if (tag === 'td' || tag === 'th') write(' ');
      const children = (el.children ?? []) as AnyNode[];
      if (tag === 'ul' || tag === 'ol') walk(children, { ordered: tag === 'ol', n: Number(el.attribs.start ?? 1) - 1 });
      else if (tag === 'a') {
        const before = out.length;
        walk(children, listCtx);
        const text = out.slice(before).trim();
        const href = (el.attribs.href ?? '').trim();
        if (href && !href.startsWith('#')) {
          const shown = href.replace(/^mailto:/, '');
          write(text ? ` [${shown}]` : `[${shown}]`);
        }
      } else walk(children, listCtx);
      if (/^h[1-6]$/.test(tag)) upper--;
      if (tag === 'pre') pre--;
      if (breaks) breakTo(breaks[1]);
    }
  };
  walk($.root().toArray());
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

type CheerioSelection = ReturnType<cheerio.CheerioAPI>;

function extractValue($el: CheerioSelection, row: JsonObject, trimValues: boolean, cleanUpText: boolean): string | undefined {
  const returnValue = str(row.returnValue, 'text');
  let value: string | undefined;
  if (returnValue === 'attribute') value = $el.attr(str(row.attribute));
  else if (returnValue === 'html') value = $el.html() || undefined;
  else if (returnValue === 'value') {
    const val = $el.val();
    value = val === undefined ? undefined : Array.isArray(val) ? val.join(',') : val;
  } else value = htmlToText($el.html() || '', str(row.skipSelectors));
  if (value === undefined) return value;
  if (trimValues) value = value.trim();
  if (cleanUpText) value = value.replace(/^\s+|\s+$/g, '').replace(/(\r\n|\n|\r)/gm, '').replace(/\s+/g, ' ');
  return value;
}

const tableShow = { operation: ['convertToHtmlTable'] };

export const html: NodeType = {
  description: {
    type: 'html',
    displayName: 'HTML',
    description: 'Gera HTML a partir de um modelo com expressões, extrai dados de HTML com seletores CSS ou monta uma tabela HTML com os itens.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'generateHtmlTemplate',
        options: [
          { name: 'Gerar HTML a partir de modelo', value: 'generateHtmlTemplate' },
          { name: 'Extrair conteúdo do HTML', value: 'extractHtmlContent' },
          { name: 'Converter em tabela HTML', value: 'convertToHtmlTable' },
        ],
      },
      {
        name: 'html',
        displayName: 'Modelo HTML',
        type: 'string',
        default: HTML_PLACEHOLDER,
        multiline: true,
        description: 'Use o modo Expressão para incluir valores com {{ }} (ex.: {{ $json.nome }}). CSS em <style> e scripts são mantidos como texto.',
        showWhen: { operation: ['generateHtmlTemplate'] },
      },
      {
        name: 'sourceData',
        displayName: 'Origem do HTML',
        type: 'options',
        default: 'json',
        options: [
          { name: 'Campo JSON', value: 'json' },
          { name: 'Arquivo do item', value: 'binary' },
        ],
        showWhen: { operation: ['extractHtmlContent'] },
      },
      {
        name: 'dataPropertyName',
        displayName: 'Campo com o HTML',
        type: 'string',
        default: 'data',
        required: true,
        description:
          'Campo JSON: campo do item com o HTML (texto ou lista de textos), aceita caminho com pontos. Arquivo do item: nome do arquivo no item (ex.: data), lido como texto UTF-8.',
        showWhen: { operation: ['extractHtmlContent'] },
      },
      {
        name: 'extractionValues',
        displayName: 'Valores a extrair',
        type: 'list',
        default: [{ key: '', cssSelector: '', returnValue: 'text', attribute: '', skipSelectors: '', returnArray: false }],
        showWhen: { operation: ['extractHtmlContent'] },
        fields: [
          { name: 'key', displayName: 'Nome do campo', type: 'string', default: '', placeholder: 'preco' },
          { name: 'cssSelector', displayName: 'Seletor CSS', type: 'string', default: '', placeholder: '.preco' },
          {
            name: 'returnValue',
            displayName: 'Devolver',
            type: 'options',
            default: 'text',
            options: [
              { name: 'Texto', value: 'text' },
              { name: 'HTML interno', value: 'html' },
              { name: 'Atributo', value: 'attribute' },
              { name: 'Valor (input, select, textarea)', value: 'value' },
            ],
          },
          { name: 'attribute', displayName: 'Atributo', type: 'string', default: '', placeholder: 'href' },
          { name: 'skipSelectors', displayName: 'Ignorar seletores (texto)', type: 'string', default: '', placeholder: 'img, .anuncio' },
          { name: 'returnArray', displayName: 'Devolver lista', type: 'boolean', default: false },
        ],
      },
      {
        name: 'trimValues',
        displayName: 'Tirar espaços das pontas',
        type: 'boolean',
        default: true,
        showWhen: { operation: ['extractHtmlContent'] },
      },
      {
        name: 'cleanUpText',
        displayName: 'Limpar o texto',
        type: 'boolean',
        default: true,
        description: 'Tira quebras de linha e junta espaços repetidos num só.',
        showWhen: { operation: ['extractHtmlContent'] },
      },
      { name: 'capitalize', displayName: 'Cabeçalhos com iniciais maiúsculas', type: 'boolean', default: false, description: 'nome_do_campo vira "Nome Do Campo".', showWhen: tableShow },
      { name: 'customStyling', displayName: 'Estilo próprio', type: 'boolean', default: false, description: 'Ligado, não aplica o estilo padrão da tabela.', showWhen: tableShow },
      { name: 'caption', displayName: 'Legenda', type: 'string', default: '', showWhen: tableShow },
      { name: 'tableAttributes', displayName: 'Atributos da tabela', type: 'string', default: '', placeholder: 'style="padding:10px"', showWhen: tableShow },
      { name: 'headerAttributes', displayName: 'Atributos do cabeçalho', type: 'string', default: '', placeholder: 'style="padding:10px"', showWhen: tableShow },
      { name: 'rowAttributes', displayName: 'Atributos das linhas', type: 'string', default: '', placeholder: 'style="padding:10px"', description: 'Pode usar expressões; vale para cada item.', showWhen: tableShow },
      { name: 'cellAttributes', displayName: 'Atributos das células', type: 'string', default: '', placeholder: 'style="padding:10px"', description: 'Pode usar expressões; vale para cada item.', showWhen: tableShow },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const operation = str(await ctx.getParam('operation', 0), 'generateHtmlTemplate');

    if (operation === 'convertToHtmlTable') {
      if (!input.length) return [[]];
      const opt = async (name: string, i = 0) => str(await ctx.getParam(name, i));
      const custom = bool(await ctx.getParam('customStyling', 0));
      const tableStyle = custom ? '' : "style='border-spacing:0; font-family:helvetica,arial,sans-serif'";
      const headerStyle = custom ? '' : "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee; text-align:left; color:#888; font-weight:normal'";
      const cellStyle = custom ? '' : "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee'";
      const capitalize = bool(await ctx.getParam('capitalize', 0));
      const caption = await opt('caption');
      const headers = [...new Set(input.flatMap((item) => Object.keys(item.json)))];
      let table = `<table ${tableStyle} ${await opt('tableAttributes')}>`;
      if (caption) table += `<caption>${caption}</caption>`;
      table += `<thead ${headerStyle} ${await opt('headerAttributes')}>`;
      table += '<tr>' + headers.map((h) => `<th>${capitalizeHeader(h, capitalize)}</th>`).join('') + '</tr>';
      table += '</thead><tbody>';
      for (let i = 0; i < input.length; i++) {
        const entry = input[i]!.json;
        table += `<tr  ${await opt('rowAttributes', i)}>`;
        const cellAttributes = await opt('cellAttributes', i);
        table += headers
          .map((h) => {
            const v = entry[h];
            // Igual ao n8n: booleanos viram caixa de seleção e o resto vai como texto
            // (campo ausente sai "undefined" e objeto sai "[object Object]").
            const content = typeof v === 'boolean' ? `<input type="checkbox" ${v ? 'checked="checked"' : ''}/>` : String(v);
            return `<td ${cellStyle} ${cellAttributes}>${content}</td>`;
          })
          .join('');
        table += '</tr>';
      }
      table += '</tbody></table>';
      return [[{ json: { table } }]];
    }

    if (operation === 'generateHtmlTemplate') {
      return eachItem(ctx, async (_item, i) => ({ json: { html: str(await ctx.getParam('html', i)) } }));
    }

    if (operation === 'extractHtmlContent') {
      return eachItem(ctx, async (item, i) => {
        const path = str(await ctx.getParam('dataPropertyName', i), 'data') || 'data';
        const fromFile = str(await ctx.getParam('sourceData', i), 'json') === 'binary';
        const source: JsonValue | undefined = fromFile ? getBinaryBuffer(item, path, i).toString('utf8') : getPath(item.json, path);
        if (source === undefined) throw new NodeOperationError(`O item não tem o campo "${path}"`);
        const rows = await ctx.getParam('extractionValues', i);
        const list = (Array.isArray(rows) ? rows : []).filter(isPlainObject);
        const trimValues = bool(await ctx.getParam('trimValues', i));
        const cleanUpText = bool(await ctx.getParam('cleanUpText', i));
        const htmls = Array.isArray(source) ? source : [source];
        return htmls.map((h) => {
          const $ = cheerio.load(str(h));
          const json: JsonObject = {};
          for (const row of list) {
            const key = str(row.key);
            const selection = $(str(row.cssSelector));
            if (bool(row.returnArray)) {
              json[key] = selection.toArray().map((el) => extractValue($(el), row, trimValues, cleanUpText) ?? null);
            } else {
              const value = extractValue(selection, row, trimValues, cleanUpText);
              if (value !== undefined) json[key] = value;
            }
          }
          return { json };
        });
      });
    }
    throw new NodeOperationError(`Operação desconhecida: ${operation}`);
  },
};

// =====================================================================
// Markdown
// =====================================================================

const toHtml = { mode: ['markdownToHtml'] };
const toMd = { mode: ['htmlToMarkdown'] };

/** Opções do showdown que o nó expõe (as do n8n mais usadas): [nome, rótulo, padrão, descrição]. */
const SHOWDOWN_BOOLEANS: [string, string, boolean, string?][] = [
  ['openLinksInNewWindow', 'Abrir links em nova janela', false, 'Coloca target="_blank" nos links.'],
  ['simplifiedAutoLink', 'Transformar URLs em links', false],
  ['excludeTrailingPunctuationFromURLs', 'Tirar pontuação do fim das URLs', false, 'Só com "Transformar URLs em links".'],
  ['simpleLineBreaks', 'Quebra de linha simples vira <br>', false, 'Como no GitHub, sem precisar de dois espaços no fim da linha.'],
  ['tables', 'Suporte a tabelas', false],
  ['strikethrough', 'Suporte a tachado (~~texto~~)', false],
  ['tasklists', 'Listas de tarefas do GitHub', false],
  ['emoji', 'Suporte a emoji (:smile:)', false],
  ['completeHTMLDocument', 'Documento HTML completo', false, 'Inclui <html>, <head> e <body>.'],
  ['noHeaderId', 'Sem ID nos títulos', false],
  ['ghCompatibleHeaderId', 'IDs dos títulos no estilo do GitHub', false],
  ['literalMidWordUnderscores', 'Sublinhado no meio da palavra é literal', false],
  ['literalMidWordAsterisks', 'Asterisco no meio da palavra é literal', false],
  ['parseImgDimensions', 'Ler dimensões das imagens', false],
  ['encodeEmails', 'Codificar e-mails', true, 'Troca os caracteres dos e-mails por entidades HTML.'],
  ['ghCodeBlocks', 'Blocos de código do GitHub (```)', true],
  ['backslashEscapesHTMLTags', 'Barra invertida escapa tags HTML', false],
  ['requireSpaceBeforeHeadingText', 'Exigir espaço depois do #', false],
  ['splitAdjacentBlockquotes', 'Separar citações vizinhas', false],
];

const markdownProperties: PropertyDescription[] = [
  {
    name: 'mode',
    displayName: 'Modo',
    type: 'options',
    default: 'htmlToMarkdown',
    options: [
      { name: 'HTML para Markdown', value: 'htmlToMarkdown' },
      { name: 'Markdown para HTML', value: 'markdownToHtml' },
    ],
  },
  { name: 'html', displayName: 'HTML', type: 'string', default: '', required: true, multiline: true, placeholder: '={{ $json.corpo }}', showWhen: toMd },
  { name: 'markdown', displayName: 'Markdown', type: 'string', default: '', required: true, multiline: true, placeholder: '={{ $json.texto }}', showWhen: toHtml },
  {
    name: 'destinationKey',
    displayName: 'Campo de destino',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Campo onde o resultado é gravado; use pontos para campos dentro de campos (ex.: email.corpo).',
  },
  // HTML para Markdown (node-html-markdown)
  { name: 'bulletMarker', displayName: 'Marcador de lista', type: 'string', default: '*', showWhen: toMd },
  { name: 'codeFence', displayName: 'Cerca dos blocos de código', type: 'string', default: '```', showWhen: toMd },
  { name: 'emDelimiter', displayName: 'Delimitador de ênfase', type: 'string', default: '_', showWhen: toMd },
  { name: 'strongDelimiter', displayName: 'Delimitador de negrito', type: 'string', default: '**', showWhen: toMd },
  {
    name: 'codeBlockStyle',
    displayName: 'Estilo dos blocos de código',
    type: 'options',
    default: 'fence',
    options: [
      { name: 'Cerca (```)', value: 'fence' },
      { name: 'Recuo', value: 'indented' },
    ],
    showWhen: toMd,
  },
  { name: 'ignore', displayName: 'Elementos ignorados', type: 'string', default: '', placeholder: 'h1, p', description: 'Separados por vírgula; o conteúdo deles some.', showWhen: toMd },
  { name: 'blockElements', displayName: 'Tratar como blocos', type: 'string', default: '', placeholder: 'p, div', description: 'Separados por vírgula; ficam entre linhas em branco.', showWhen: toMd },
  { name: 'keepDataImages', displayName: 'Manter imagens com data:', type: 'boolean', default: false, description: 'Imagens embutidas em base64 (podem ser grandes).', showWhen: toMd },
  { name: 'maxConsecutiveNewlines', displayName: 'Máximo de linhas em branco seguidas', type: 'number', default: 3, showWhen: toMd },
  { name: 'useLinkReferenceDefinitions', displayName: 'URLs no fim do texto', type: 'boolean', default: false, description: 'Links viram referências [1] com as URLs listadas no fim.', showWhen: toMd },
  {
    name: 'textReplace',
    displayName: 'Substituições de texto',
    type: 'list',
    default: [],
    description: 'Troca trechos do texto lido do HTML (como no n8n, o padrão é texto: troca a primeira ocorrência).',
    showWhen: toMd,
    fields: [
      { name: 'pattern', displayName: 'Procurar', type: 'string', default: '' },
      { name: 'replacement', displayName: 'Trocar por', type: 'string', default: '' },
    ],
  },
  // Markdown para HTML (showdown)
  ...SHOWDOWN_BOOLEANS.map(([name, displayName, def, description]): PropertyDescription => ({ name, displayName, type: 'boolean', default: def, description, showWhen: toHtml })),
  { name: 'headerLevelStart', displayName: 'Nível inicial dos títulos', type: 'number', default: 1, description: 'Com 2, "# Título" vira <h2>.', showWhen: toHtml },
  { name: 'prefixHeaderId', displayName: 'Prefixo dos IDs dos títulos', type: 'string', default: '', placeholder: 'section', showWhen: toHtml },
];

export const markdown: NodeType = {
  description: {
    type: 'markdown',
    displayName: 'Markdown',
    description: 'Converte texto entre Markdown e HTML.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: markdownProperties,
  },
  async execute(ctx) {
    const mode = str(await ctx.getParam('mode', 0), 'htmlToMarkdown');
    return eachItem(ctx, async (item, i) => {
      const p = (name: string) => ctx.getParam(name, i);
      const destination = str(await p('destinationKey'), 'data');
      let result: string;
      if (mode === 'markdownToHtml') {
        const converter = new showdown.Converter();
        for (const [name] of SHOWDOWN_BOOLEANS) converter.setOption(name, bool(await p(name)));
        converter.setOption('headerLevelStart', num(await p('headerLevelStart'), 1));
        const prefix = str(await p('prefixHeaderId')).trim();
        if (prefix) converter.setOption('prefixHeaderId', prefix);
        result = converter.makeHtml(str(await p('markdown')));
      } else if (mode === 'htmlToMarkdown') {
        const options: { -readonly [K in keyof NodeHtmlMarkdownOptions]?: NodeHtmlMarkdownOptions[K] } = {};
        const text = async (name: string) => str(await p(name));
        const list = async (name: string) => (await text(name)).split(',').map((s) => s.trim()).filter(Boolean);
        for (const name of ['bulletMarker', 'codeFence', 'emDelimiter', 'strongDelimiter'] as const) {
          const v = await text(name);
          if (v) options[name] = v;
        }
        const codeBlockStyle = await text('codeBlockStyle');
        // O n8n manda "fence", que a biblioteca não conhece (e acaba recuando o código); aqui vale o que a opção diz.
        if (codeBlockStyle === 'indented') options.codeBlockStyle = 'indented';
        else if (codeBlockStyle === 'fence') options.codeBlockStyle = 'fenced';
        const ignore = await list('ignore');
        if (ignore.length) options.ignore = ignore;
        const blocks = await list('blockElements');
        if (blocks.length) options.blockElements = blocks;
        if (bool(await p('keepDataImages'))) options.keepDataImages = true;
        if (bool(await p('useLinkReferenceDefinitions'))) options.useLinkReferenceDefinitions = true;
        const maxNl = num(await p('maxConsecutiveNewlines'), 3);
        if (maxNl) options.maxConsecutiveNewlines = maxNl;
        const replaces = await p('textReplace');
        const pairs = (Array.isArray(replaces) ? replaces : []).filter(isPlainObject).filter((r) => str(r.pattern) !== '');
        // O n8n passa o padrão como texto, então vale a troca literal da primeira ocorrência.
        if (pairs.length) options.textReplace = pairs.map((r) => [str(r.pattern) as unknown as RegExp, str(r.replacement)]);
        result = NodeHtmlMarkdown.translate(str(await p('html')), options);
      } else throw new NodeOperationError(`Modo desconhecido: ${mode}`);
      const json = structuredClone(item.json);
      setPath(json, destination, result);
      return { json };
    });
  },
};

// =====================================================================
// XML
// =====================================================================

/** Nomes de tags e atributos que não podem virar campos (proteção do n8n contra __proto__). */
function sanitizeXmlName(name: string): string {
  return FORBIDDEN_KEYS.has(name) ? `_${name}` : name;
}

const toXml = { mode: ['jsonToxml'] };
const toJsonMode = { mode: ['xmlToJson'] };

export const xml: NodeType = {
  description: {
    type: 'xml',
    displayName: 'XML',
    description: 'Converte dados de JSON para XML e de XML para JSON.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'mode',
        displayName: 'Modo',
        type: 'options',
        default: 'xmlToJson',
        options: [
          { name: 'XML para JSON', value: 'xmlToJson' },
          { name: 'JSON para XML', value: 'jsonToxml' },
        ],
      },
      {
        name: 'dataPropertyName',
        displayName: 'Nome do campo',
        type: 'string',
        default: 'data',
        required: true,
        description: 'XML para JSON: campo do item com o XML. JSON para XML: campo onde o XML é gravado.',
      },
      { name: 'attrkey', displayName: 'Chave dos atributos', type: 'string', default: '$', description: 'Nome do campo que guarda os atributos.' },
      { name: 'charkey', displayName: 'Chave do texto', type: 'string', default: '_', description: 'Nome do campo que guarda o texto do elemento.' },
      { name: 'explicitArray', displayName: 'Sempre usar listas', type: 'boolean', default: false, description: 'Ligado, os filhos sempre vêm em lista; desligado, só quando há mais de um.', showWhen: toJsonMode },
      { name: 'explicitRoot', displayName: 'Manter o elemento raiz', type: 'boolean', default: true, showWhen: toJsonMode },
      { name: 'ignoreAttrs', displayName: 'Ignorar atributos', type: 'boolean', default: false, showWhen: toJsonMode },
      {
        name: 'mergeAttrs',
        displayName: 'Juntar atributos com os filhos',
        type: 'boolean',
        default: true,
        description: 'Atributos viram campos do elemento, em vez de ficar na chave dos atributos.',
        showWhen: toJsonMode,
      },
      { name: 'normalize', displayName: 'Normalizar espaços do texto', type: 'boolean', default: false, showWhen: toJsonMode },
      { name: 'normalizeTags', displayName: 'Tags em minúsculas', type: 'boolean', default: false, showWhen: toJsonMode },
      { name: 'trim', displayName: 'Tirar espaços das pontas do texto', type: 'boolean', default: false, showWhen: toJsonMode },
      { name: 'rootName', displayName: 'Nome do elemento raiz', type: 'string', default: 'root', showWhen: toXml },
      { name: 'headless', displayName: 'Sem cabeçalho XML', type: 'boolean', default: false, description: 'Omite o <?xml ...?> do início.', showWhen: toXml },
      { name: 'cdata', displayName: 'Usar CDATA', type: 'boolean', default: false, description: 'Envolve o texto em <![CDATA[ ]]> quando precisaria escapar caracteres.', showWhen: toXml },
      { name: 'allowSurrogateChars', displayName: 'Permitir caracteres substitutos Unicode', type: 'boolean', default: false, showWhen: toXml },
    ],
  },
  async execute(ctx) {
    const p = (name: string) => ctx.getParam(name, 0);
    const mode = str(await p('mode'), 'xmlToJson');
    const field = str(await p('dataPropertyName'), 'data');
    const attrkey = str(await p('attrkey')) || '$';
    const charkey = str(await p('charkey')) || '_';
    if (FORBIDDEN_KEYS.has(attrkey)) throw new NodeOperationError(`A chave dos atributos "${attrkey}" não é permitida`);
    if (FORBIDDEN_KEYS.has(charkey)) throw new NodeOperationError(`A chave do texto "${charkey}" não é permitida`);

    if (mode === 'jsonToxml') {
      const builder = new Builder({
        attrkey,
        charkey,
        rootName: str(await p('rootName')) || 'root',
        headless: bool(await p('headless')),
        cdata: bool(await p('cdata')),
        allowSurrogateChars: bool(await p('allowSurrogateChars')),
      });
      return eachItem(ctx, async (item) => ({ json: { [field]: builder.buildObject(item.json) } }));
    }
    if (mode !== 'xmlToJson') throw new NodeOperationError(`Modo desconhecido: ${mode}`);
    const parserOptions = {
      attrkey,
      charkey,
      explicitArray: bool(await p('explicitArray')),
      explicitRoot: bool(await p('explicitRoot')),
      ignoreAttrs: bool(await p('ignoreAttrs')),
      mergeAttrs: bool(await p('mergeAttrs')),
      normalize: bool(await p('normalize')),
      normalizeTags: bool(await p('normalizeTags')),
      trim: bool(await p('trim')),
      tagNameProcessors: [sanitizeXmlName],
      attrNameProcessors: [sanitizeXmlName],
    };
    return eachItem(ctx, async (item) => {
      const source = item.json[field];
      if (source === undefined) throw new NodeOperationError(`O item não tem o campo "${field}"`);
      try {
        const parsed: unknown = await new Parser(parserOptions).parseStringPromise(str(source));
        const json = toJson(parsed);
        return { json: isPlainObject(json) ? json : { [field]: json } };
      } catch (err) {
        throw new NodeOperationError(`XML inválido: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    });
  },
};

// =====================================================================
// TOTP
// =====================================================================

export const totp: NodeType = {
  description: {
    type: 'totp',
    displayName: 'TOTP',
    description: 'Gera o código de uso único baseado em tempo (o código de 6 dígitos dos apps autenticadores).',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'operation', displayName: 'Operação', type: 'options', default: 'generateSecret', options: [{ name: 'Gerar código', value: 'generateSecret' }] },
      { name: 'connection', displayName: 'Conexão TOTP', type: 'connection', default: '', required: true, connectionTypes: ['totp'], description: 'Conexão com o segredo (base32) e o rótulo "emissor:usuário".' },
      {
        name: 'algorithm',
        displayName: 'Algoritmo',
        type: 'options',
        default: 'SHA1',
        options: ['SHA1', 'SHA224', 'SHA256', 'SHA3-224', 'SHA3-256', 'SHA3-384', 'SHA3-512', 'SHA384', 'SHA512'].map((v) => ({ name: v, value: v })),
        description: 'Algoritmo do HMAC. O padrão dos apps autenticadores é SHA1.',
      },
      { name: 'digits', displayName: 'Dígitos', type: 'number', default: 6 },
      { name: 'period', displayName: 'Validade (segundos)', type: 'number', default: 30 },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const operation = str(await ctx.getParam('operation', 0), 'generateSecret');
    if (operation !== 'generateSecret') throw new NodeOperationError(`Operação desconhecida: ${operation}`);
    const connectionId = str(await ctx.getParam('connection', 0));
    if (!connectionId) throw new NodeOperationError('Escolha a conexão TOTP');
    const connection = await ctx.getConnection(connectionId);
    const secret = str(connection.data.secret).replace(/\s+/g, '');
    const label = str(connection.data.label).trim();
    if (!secret) throw new NodeOperationError('A conexão TOTP não tem segredo');
    if (label && !label.includes(':')) throw new NodeOperationError('Rótulo mal formado: use o formato emissor:usuário');
    const algorithm = str(await ctx.getParam('algorithm', 0)) || 'SHA1';
    const digits = num(await ctx.getParam('digits', 0), 0) || 6;
    const period = num(await ctx.getParam('period', 0), 0) || 30;
    let token: string;
    try {
      const config: ConstructorParameters<typeof OTPAuth.TOTP>[0] = { secret, algorithm, digits, period };
      if (label) {
        config.issuer = label.split(':')[0];
        config.label = label;
      }
      token = new OTPAuth.TOTP(config).generate();
    } catch (err) {
      throw new NodeOperationError(`Não foi possível gerar o código: ${err instanceof Error ? err.message : String(err)}`);
    }
    const secondsRemaining = (period * (1 - ((Date.now() / 1000 / period) % 1))) | 0;
    return [input.map(() => ({ json: { token, secondsRemaining } }))];
  },
};

export const formatNodes: NodeType[] = [dateTime, cryptoNode, html, markdown, xml, totp];
