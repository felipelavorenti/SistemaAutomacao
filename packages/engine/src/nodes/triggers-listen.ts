import { createRequire } from 'node:module';
import { watch } from 'chokidar';
import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import picomatch from 'picomatch';
import Parser from 'rss-parser';
import { toBinary } from '../binary.js';
import type { NodeExecuteContext, NodeType, PropertyDescription, TriggerContext } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue } from '../types.js';
import { allowedRoots, resolveAllowedPath } from './files-disk.js';

/**
 * Gatilhos que escutam ou consultam algo enquanto o fluxo está ativo, réplicas dos nós do n8n:
 * RSS Feed Trigger (consulta nos horários de "pollTimes"), Email Trigger (IMAP), Local File
 * Trigger e SSE Trigger (escutam). O servidor chama `listen`/`poll`; o `execute` de cada nó só
 * repassa os itens que o gatilho emitiu.
 */

const require = createRequire(import.meta.url);
const libmime = require('libmime') as { decodeWords(value: string): string };

const str = (value: JsonValue | undefined, fallback = ''): string => (value === undefined || value === null ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value));
const bool = (value: JsonValue | undefined, fallback = false): boolean => (value === undefined || value === null || value === '' ? fallback : value === true || value === 'true');
const num = (value: JsonValue | undefined, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const asError = (err: unknown, prefix: string): Error => new Error(`${prefix}: ${errMessage(err)}`);
/** Valor que vira JSON puro (datas viram texto, undefined some). */
const toJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value ?? {})) as JsonObject;

/** Espera um tempo, mas acorda na hora se o sinal for abortado. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Espera entre tentativas de reconexão: 1 s, 2 s, 4 s… até 1 minuto. */
const backoff = (attempt: number, base = 1000) => Math.min(base * 2 ** attempt, 60_000);

/** Execute dos gatilhos que escutam: sem itens do gatilho, não há o que fazer numa execução manual. */
function listenerExecute(displayName: string) {
  return async (ctx: NodeExecuteContext): Promise<Item[][]> => {
    const input = ctx.inputs[0] ?? [];
    if (input.length) return [input];
    throw new NodeOperationError(
      `O ${displayName} só dispara com o fluxo ativo ou com "Escutar teste" no editor. Ative o fluxo, ou clique em "Escutar teste" e provoque o evento.`,
    );
  };
}

// =====================================================================
// Horários de consulta (pollTimes do n8n)
// =====================================================================

const POLL_DEFAULT_ROW: JsonObject = { mode: 'everyMinute', hour: 14, minute: 0, dayOfMonth: 1, weekday: '1', value: 2, unit: 'hours', cronExpression: '0 * * * * *' };

/** Campo "Horários de consulta", com os mesmos modos do n8n. */
export const pollTimesProperty: PropertyDescription = {
  name: 'pollTimes',
  displayName: 'Horários de consulta',
  type: 'list',
  default: [{ ...POLL_DEFAULT_ROW }],
  description: 'Quando o fluxo está ativo, o gatilho consulta nesses horários. Cada linha é um horário; com várias linhas, vale qualquer uma delas.',
  fields: [
    {
      name: 'mode',
      displayName: 'Modo',
      type: 'options',
      default: 'everyMinute',
      options: [
        { name: 'A cada minuto', value: 'everyMinute' },
        { name: 'A cada hora', value: 'everyHour' },
        { name: 'Todo dia', value: 'everyDay' },
        { name: 'Toda semana', value: 'everyWeek' },
        { name: 'Todo mês', value: 'everyMonth' },
        { name: 'A cada X', value: 'everyX' },
        { name: 'Personalizado (cron)', value: 'custom' },
      ],
    },
    { name: 'hour', displayName: 'Hora', type: 'number', default: 14, description: 'De 0 a 23 (Todo dia, Toda semana, Todo mês).', showWhen: { mode: ['everyDay', 'everyWeek', 'everyMonth'] } },
    { name: 'minute', displayName: 'Minuto', type: 'number', default: 0, description: 'De 0 a 59 (A cada hora, Todo dia, Toda semana, Todo mês).', showWhen: { mode: ['everyHour', 'everyDay', 'everyWeek', 'everyMonth'] } },
    { name: 'dayOfMonth', displayName: 'Dia do mês', type: 'number', default: 1, description: 'De 1 a 31 (Todo mês).', showWhen: { mode: ['everyMonth'] } },
    {
      name: 'weekday',
      displayName: 'Dia da semana',
      type: 'options',
      default: '1',
      description: 'Só para Toda semana.',
      options: [
        { name: 'Segunda', value: '1' },
        { name: 'Terça', value: '2' },
        { name: 'Quarta', value: '3' },
        { name: 'Quinta', value: '4' },
        { name: 'Sexta', value: '5' },
        { name: 'Sábado', value: '6' },
        { name: 'Domingo', value: '0' },
      ],
      showWhen: { mode: ['everyWeek'] },
    },
    { name: 'value', displayName: 'Valor (A cada X)', type: 'number', default: 2, description: 'Quantas unidades entre uma consulta e outra.', showWhen: { mode: ['everyX'] } },
    {
      name: 'unit',
      displayName: 'Unidade (A cada X)',
      type: 'options',
      default: 'hours',
      options: [
        { name: 'Minutos', value: 'minutes' },
        { name: 'Horas', value: 'hours' },
      ],
      showWhen: { mode: ['everyX'] },
    },
    {
      name: 'cronExpression',
      displayName: 'Expressão cron',
      type: 'string',
      default: '0 * * * * *',
      placeholder: 'segundo minuto hora dia mês dia-da-semana',
      description: 'Só para Personalizado. 6 campos (com os segundos no começo) ou 5 (sem os segundos).',
      showWhen: { mode: ['custom'] },
    },
  ],
};

const clampInt = (value: JsonValue | undefined, fallback: number, min: number, max: number): number => {
  const n = Math.trunc(num(value, fallback));
  return Math.min(Math.max(n, min), max);
};

/**
 * Converte o campo pollTimes (lista de linhas, ou o formato do n8n { item: [...] }) em expressões
 * cron de 6 campos (segundos primeiro). Como no n8n; o segundo é sempre 0.
 */
export function pollTimesToCrons(raw: JsonValue): string[] {
  let rows: JsonValue[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw && typeof raw === 'object' && Array.isArray((raw as JsonObject).item)) rows = (raw as JsonObject).item as JsonValue[];
  const crons: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as JsonObject;
    const hour = clampInt(r.hour, 14, 0, 23);
    const minute = clampInt(r.minute, 0, 0, 59);
    const dayOfMonth = clampInt(r.dayOfMonth, 1, 1, 31);
    const weekday = clampInt(r.weekday, 1, 0, 7) % 7;
    switch (str(r.mode, 'everyMinute')) {
      case 'everyMinute':
        crons.push('0 * * * * *');
        break;
      case 'everyHour':
        crons.push(`0 ${minute} * * * *`);
        break;
      case 'everyDay':
        crons.push(`0 ${minute} ${hour} * * *`);
        break;
      case 'everyWeek':
        crons.push(`0 ${minute} ${hour} * * ${weekday}`);
        break;
      case 'everyMonth':
        crons.push(`0 ${minute} ${hour} ${dayOfMonth} * *`);
        break;
      case 'everyX': {
        const value = clampInt(r.value, 2, 1, 1000);
        crons.push(str(r.unit, 'hours') === 'minutes' ? `0 */${value} * * * *` : `0 0 */${value} * * *`);
        break;
      }
      case 'custom': {
        const parts = str(r.cronExpression).trim().split(/\s+/).filter(Boolean);
        if (parts.length === 5) crons.push(`0 ${parts.join(' ')}`);
        else if (parts.length === 6) crons.push(parts.join(' '));
        break;
      }
      default:
        break;
    }
  }
  return [...new Set(crons)];
}

// =====================================================================
// RSS Feed Trigger
// =====================================================================

/** Lê o feed e devolve os itens como o rss-parser monta (os mesmos campos do n8n). */
export async function readFeed(feedUrl: string, ignoreSSL = false): Promise<JsonObject[]> {
  if (!feedUrl.trim()) throw new NodeOperationError('Informe a URL do feed');
  if (!/^https?:\/\//i.test(feedUrl.trim())) throw new NodeOperationError(`A URL do feed "${feedUrl}" precisa começar com http:// ou https://`);
  const parser = new Parser({ timeout: 60_000, requestOptions: { rejectUnauthorized: !ignoreSSL } });
  let feed: Awaited<ReturnType<typeof parser.parseURL>>;
  try {
    feed = await parser.parseURL(feedUrl.trim());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      throw new NodeOperationError(`Não foi possível conectar à URL "${feedUrl}". Confira se o endereço está certo e acessível pelo servidor.`);
    }
    throw new NodeOperationError(`Não foi possível ler o feed "${feedUrl}": ${errMessage(err)}`);
  }
  return (feed.items ?? []).map((item) => toJson(item));
}

const dateOf = (item: JsonObject): number => (typeof item.isoDate === 'string' ? Date.parse(item.isoDate) : NaN);

/**
 * Consulta do RSS, igual ao n8n: devolve os itens com data (isoDate) depois da do item mais novo
 * da consulta anterior. Na primeira consulta só guarda a data; no teste devolve o item mais recente.
 */
async function pollRss(ctx: TriggerContext): Promise<Item[] | null> {
  const feedUrl = str(await ctx.getParam('feedUrl'));
  const ignoreSSL = bool(await ctx.getParam('ignoreSSL'));
  const sd = ctx.staticData;
  const items = await readFeed(feedUrl, ignoreSSL);
  if (ctx.testing) return items.length ? [{ json: items[0]! }] : null;

  let dateToCheck = Date.parse(str(sd.lastItemDate ?? sd.lastTimeChecked, ''));
  if (!Number.isFinite(dateToCheck)) dateToCheck = Date.now();
  if (!sd.lastItemDate && sd.lastTimeChecked) sd.lastItemDate = sd.lastTimeChecked;
  delete sd.lastTimeChecked;

  const fresh = items.filter((item) => dateOf(item) > dateToCheck);
  let newest: JsonObject | undefined;
  for (const item of items) if (!newest || dateOf(item) > dateOf(newest)) newest = item;
  if (newest && typeof newest.isoDate === 'string' && Number.isFinite(dateOf(newest))) sd.lastItemDate = newest.isoDate;
  else if (!sd.lastItemDate) sd.lastItemDate = new Date(dateToCheck).toISOString();
  await ctx.saveStaticData();
  return fresh.length ? fresh.map((json) => ({ json })) : null;
}

export const rssFeedReadTrigger: NodeType = {
  description: {
    type: 'rssFeedReadTrigger',
    displayName: 'RSS Feed Trigger',
    description: 'Inicia o fluxo quando aparece um item novo num feed RSS ou Atom (consulta nos horários escolhidos).',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      pollTimesProperty,
      {
        name: 'feedUrl',
        displayName: 'URL do feed',
        type: 'string',
        default: 'https://blog.n8n.io/rss/',
        required: true,
        placeholder: 'https://site.com.br/feed.xml',
        description: 'Endereço do feed RSS ou Atom.',
      },
      {
        name: 'ignoreSSL',
        displayName: 'Ignorar erros de certificado (SSL)',
        type: 'boolean',
        default: false,
        description: 'Aceita sites com certificado vencido ou próprio. Use só com feeds internos de confiança.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    if (input.length) return [input];
    // Execução manual sem o gatilho: mostra o item mais recente do feed ("Fetch test event" do n8n).
    const items = await readFeed(str(await ctx.getParam('feedUrl', 0)), bool(await ctx.getParam('ignoreSSL', 0)));
    if (!items.length) throw new NodeOperationError('O feed não tem nenhum item para mostrar no teste');
    return [[{ json: items[0]! }]];
  },
  poll: pollRss,
};

// =====================================================================
// Email Trigger (IMAP)
// =====================================================================

export interface ImapItemOptions {
  format: 'simple' | 'resolved' | 'raw';
  downloadAttachments: boolean;
  attachmentPrefix: string;
}

/** Cabeçalhos que ficam no primeiro nível do item no formato simples (os outros vão em metadata). */
const TOP_LEVEL_HEADERS = ['cc', 'date', 'from', 'subject', 'to'];

/** Valor de uma linha de cabeçalho ("From: Fulano <f@x>"), desdobrado e com as palavras MIME decodificadas. */
function headerValue(line: string): string {
  const value = line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
  try {
    return libmime.decodeWords(value);
  } catch {
    return value;
  }
}

function attachmentsBinary(parsed: ParsedMail, prefix: string): Record<string, BinaryData> | undefined {
  const binary: Record<string, BinaryData> = {};
  parsed.attachments.forEach((attachment, i) => {
    binary[`${prefix}${i}`] = toBinary(attachment.content, { fileName: attachment.filename || undefined, mimeType: attachment.contentType || undefined });
  });
  return Object.keys(binary).length ? binary : undefined;
}

/**
 * Monta o item de um e-mail (código-fonte completo) nos formatos do Email Trigger (IMAP) V2 do n8n:
 * simple (cabeçalhos principais, textHtml, textPlain e metadata), resolved (saída do mailparser)
 * e raw (o e-mail em base64).
 */
export async function imapMessageToItem(source: Buffer, uid: number, options: ImapItemOptions): Promise<Item> {
  const attributes: JsonObject = { uid };
  if (options.format === 'raw') return { json: { raw: source.toString('base64'), attributes } };
  const parsed = await simpleParser(source, { skipImageLinks: true });
  const prefix = options.attachmentPrefix || 'attachment_';

  if (options.format === 'resolved') {
    const headers: JsonObject = {};
    for (const header of parsed.headerLines) headers[header.key] = header.line;
    const json = toJson({ ...parsed, headers, headerLines: undefined, attachments: undefined });
    json.attributes = attributes;
    const item: Item = { json };
    const binary = attachmentsBinary(parsed, prefix);
    if (binary) item.binary = binary;
    return item;
  }

  const json: JsonObject = { textHtml: typeof parsed.html === 'string' ? parsed.html : '', textPlain: parsed.text ?? '', metadata: {}, attributes };
  const metadata = json.metadata as JsonObject;
  for (const header of parsed.headerLines) {
    // Como o n8n: vale a primeira ocorrência de cada cabeçalho.
    const target = TOP_LEVEL_HEADERS.includes(header.key) ? json : metadata;
    if (target[header.key] === undefined) target[header.key] = headerValue(header.line);
  }
  const item: Item = { json };
  if (options.downloadAttachments) {
    const binary = attachmentsBinary(parsed, prefix);
    if (binary) item.binary = binary;
  }
  return item;
}

const FLAG_CRITERIA: Record<string, SearchObject> = {
  ALL: { all: true },
  ANSWERED: { answered: true },
  UNANSWERED: { answered: false },
  DELETED: { deleted: true },
  UNDELETED: { deleted: false },
  DRAFT: { draft: true },
  UNDRAFT: { draft: false },
  FLAGGED: { flagged: true },
  UNFLAGGED: { flagged: false },
  SEEN: { seen: true },
  UNSEEN: { seen: false },
  NEW: { new: true },
  OLD: { old: true },
  RECENT: { recent: true },
};
const TEXT_CRITERIA: Record<string, keyof SearchObject> = {
  FROM: 'from',
  TO: 'to',
  CC: 'cc',
  BCC: 'bcc',
  SUBJECT: 'subject',
  BODY: 'body',
  TEXT: 'text',
  KEYWORD: 'keyword',
  UNKEYWORD: 'unKeyword',
  UID: 'uid',
  'X-GM-RAW': 'gmraw',
};
const DATE_CRITERIA: Record<string, keyof SearchObject> = {
  BEFORE: 'before',
  ON: 'on',
  SINCE: 'since',
  SENTBEFORE: 'sentBefore',
  SENTON: 'sentOn',
  SENTSINCE: 'sentSince',
};

const badCriteria = (detail: string) =>
  new NodeOperationError(`Critério de busca inválido: ${detail}. Use o formato do n8n, ex.: ["UNSEEN"] ou ["UNSEEN", ["SINCE", "May 20, 2024"]]`);

/** Junta critérios (todos precisam valer); chaves repetidas viram NÃO(OU(NÃO a, NÃO b)). */
function andCriteria(list: SearchObject[]): SearchObject {
  let result: SearchObject = {};
  for (const c of list) {
    const clash = Object.keys(c).some((k) => k in result);
    result = clash ? { not: { or: [{ not: result }, { not: c }] } } : { ...result, ...c };
  }
  return Object.keys(result).length ? result : { all: true };
}

function criterion(raw: unknown): SearchObject {
  if (typeof raw === 'string') {
    if (raw.startsWith('!')) return { not: criterion(raw.slice(1)) };
    const flag = FLAG_CRITERIA[raw.toUpperCase()];
    if (!flag) throw badCriteria(`"${raw}" não é conhecido`);
    return { ...flag };
  }
  if (!Array.isArray(raw) || !raw.length || typeof raw[0] !== 'string') throw badCriteria(JSON.stringify(raw));
  const [rawName, ...args] = raw as [string, ...unknown[]];
  const negate = rawName.startsWith('!');
  const name = (negate ? rawName.slice(1) : rawName).toUpperCase();
  let result: SearchObject;
  if (!args.length) result = criterion(name);
  else if (TEXT_CRITERIA[name]) result = { [TEXT_CRITERIA[name]]: String(args[0]) };
  else if (DATE_CRITERIA[name]) {
    const date = new Date(String(args[0]));
    if (Number.isNaN(date.getTime())) throw badCriteria(`a data "${String(args[0])}" de ${name} não foi entendida`);
    result = { [DATE_CRITERIA[name]]: date };
  } else if (name === 'LARGER' || name === 'SMALLER') {
    const size = Number(args[0]);
    if (!Number.isFinite(size)) throw badCriteria(`${name} precisa de um número`);
    result = { [name.toLowerCase()]: size };
  } else if (name === 'HEADER') result = { header: { [String(args[0])]: args.length > 1 ? String(args[1]) : true } };
  else if (name === 'OR') {
    if (args.length < 2) throw badCriteria('OR precisa de dois critérios');
    result = { or: [criterion(args[0]), criterion(args[1])] };
  } else throw badCriteria(`"${rawName}" não é conhecido`);
  return negate ? { not: result } : result;
}

/** Converte os critérios de busca no formato do n8n (node-imap) para a busca do imapflow. */
export function imapCriteriaToSearch(raw: JsonValue | undefined): SearchObject {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { seen: false };
    try {
      value = JSON.parse(raw);
    } catch {
      throw badCriteria('o texto não é um JSON válido');
    }
  }
  if (value === undefined || value === null) return { seen: false };
  if (!Array.isArray(value)) throw badCriteria('precisa ser uma lista');
  return andCriteria(value.map(criterion));
}

interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  allowUnauthorizedCerts: boolean;
}

function imapSettings(data: JsonObject): ImapSettings {
  const host = str(data.host).trim();
  const user = str(data.user).trim();
  if (!host) throw new NodeOperationError('A conexão IMAP não tem servidor');
  if (!user) throw new NodeOperationError('A conexão IMAP não tem usuário');
  const secure = bool(data.secure, true);
  return { host, port: num(data.port, secure ? 993 : 143) || (secure ? 993 : 143), secure, user, password: str(data.password), allowUnauthorizedCerts: bool(data.allowUnauthorizedCerts) };
}

async function listenImap(ctx: TriggerContext): Promise<() => Promise<void>> {
  const connectionId = str(await ctx.getParam('connection'));
  if (!connectionId) throw new NodeOperationError('Escolha a conexão IMAP');
  const settings = imapSettings((await ctx.getConnection(connectionId)).data);
  const mailbox = str(await ctx.getParam('mailbox'), 'INBOX').trim() || 'INBOX';
  const postProcessAction = str(await ctx.getParam('postProcessAction'), 'read');
  const formatRaw = str(await ctx.getParam('format'), 'simple');
  const format: ImapItemOptions['format'] = formatRaw === 'resolved' || formatRaw === 'raw' ? formatRaw : 'simple';
  const itemOptions: ImapItemOptions = {
    format,
    downloadAttachments: bool(await ctx.getParam('downloadAttachments')),
    attachmentPrefix: str(await ctx.getParam('dataPropertyAttachmentsPrefixName'), 'attachment_') || 'attachment_',
  };
  const criteria = imapCriteriaToSearch(await ctx.getParam('customEmailConfig'));
  const forceReconnectMs = Math.max(num(await ctx.getParam('forceReconnect'), 0), 0) * 60_000;
  const trackLastMessageId = bool(await ctx.getParam('trackLastMessageId'), true);

  const stop = new AbortController();
  let client: ImapFlow | null = null;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();

  /** Uma busca por vez, na ordem em que foram pedidas. */
  const enqueue = (c: ImapFlow) => {
    chain = chain
      .then(() => (stop.signal.aborted || client !== c ? undefined : check(c)))
      .catch((err) => {
        if (!stop.signal.aborted) ctx.emitError(asError(err, 'Email Trigger (IMAP)'));
      });
    return chain;
  };

  const check = async (c: ImapFlow) => {
    const sd = ctx.staticData;
    const query: SearchObject = { ...criteria };
    let last = 0;
    if (trackLastMessageId) {
      const box = c.mailbox;
      const uidValidity = box ? String(box.uidValidity) : '';
      if (str(sd.uidValidity) !== uidValidity) {
        // Caixa recriada no servidor: os UIDs antigos não valem mais.
        delete sd.lastMessageUid;
        sd.uidValidity = uidValidity;
      }
      last = num(sd.lastMessageUid, 0);
      if (last > 0) query.uid = `${last + 1}:*`;
    }
    const found = (await c.search(query, { uid: true })) || [];
    // "n:*" sempre inclui a última mensagem, mesmo com UID menor que n.
    const uids = found.filter((uid) => uid > last).sort((a, b) => a - b);
    if (!uids.length) return;
    const items: Item[] = [];
    for (const uid of uids) {
      if (stop.signal.aborted) return;
      const message = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!message || !message.source) continue;
      items.push(await imapMessageToItem(message.source, uid, itemOptions));
    }
    if (postProcessAction === 'read') await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    if (trackLastMessageId) {
      sd.lastMessageUid = uids[uids.length - 1]!;
      await ctx.saveStaticData();
    }
    if (items.length) await ctx.emit(items);
  };

  const dropClient = async (c: ImapFlow | null) => {
    if (!c) return;
    try {
      await c.logout();
    } catch {
      try {
        c.close();
      } catch {
        // já fechada
      }
    }
  };

  const scheduleReconnect = () => {
    if (stop.signal.aborted) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connect(false), backoff(attempt++, 2000));
  };

  const connect = async (first: boolean): Promise<void> => {
    if (stop.signal.aborted) return;
    clearTimeout(forceTimer);
    const c = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      tls: { rejectUnauthorized: !settings.allowUnauthorizedCerts },
      logger: false,
    });
    client = c;
    c.on('error', (err: unknown) => {
      if (!stop.signal.aborted) ctx.emitError(asError(err, 'Email Trigger (IMAP)'));
    });
    c.on('close', () => {
      if (client !== c) return;
      client = null;
      scheduleReconnect();
    });
    c.on('exists', () => void enqueue(c));
    try {
      await c.connect();
      await c.mailboxOpen(mailbox);
    } catch (err) {
      const error = asError(err, `Não foi possível abrir a caixa "${mailbox}" em ${settings.host}`);
      if (client === c) {
        client = null;
        await dropClient(c);
        if (first && ctx.testing) throw new NodeOperationError(error.message);
        if (!stop.signal.aborted) ctx.emitError(error);
        scheduleReconnect();
      }
      return;
    }
    attempt = 0;
    if (forceReconnectMs > 0) {
      forceTimer = setTimeout(() => {
        if (client !== c) return;
        client = null;
        void dropClient(c).then(() => connect(false));
      }, forceReconnectMs);
    }
    // Mensagens que já estão na caixa e batem com a busca (o imapflow entra em IDLE sozinho depois).
    await enqueue(c);
  };

  const close = async () => {
    if (stop.signal.aborted) return;
    stop.abort();
    ctx.signal.removeEventListener('abort', onAbort);
    clearTimeout(reconnectTimer);
    clearTimeout(forceTimer);
    const c = client;
    client = null;
    await dropClient(c);
  };
  const onAbort = () => void close();
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  await connect(true);
  return close;
}

export const emailReadImap: NodeType = {
  description: {
    type: 'emailReadImap',
    displayName: 'Email Trigger (IMAP)',
    description: 'Inicia o fluxo quando chega um e-mail numa caixa IMAP (Gmail, Outlook, servidor próprio).',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      { name: 'connection', displayName: 'Conexão IMAP', type: 'connection', default: '', required: true, connectionTypes: ['imap'] },
      { name: 'mailbox', displayName: 'Caixa de e-mail', type: 'string', default: 'INBOX', description: 'Pasta vigiada. INBOX é a caixa de entrada; subpastas costumam ser "INBOX/Pasta" ou "INBOX.Pasta".' },
      {
        name: 'postProcessAction',
        displayName: 'Depois de ler',
        type: 'options',
        default: 'read',
        options: [
          { name: 'Marcar como lido', value: 'read' },
          { name: 'Não fazer nada', value: 'nothing' },
        ],
      },
      {
        name: 'format',
        displayName: 'Formato',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'Simples (cabeçalhos principais e texto)', value: 'simple' },
          { name: 'Completo (e-mail interpretado, anexos como arquivos)', value: 'resolved' },
          { name: 'Bruto (e-mail inteiro em base64)', value: 'raw' },
        ],
      },
      { name: 'downloadAttachments', displayName: 'Baixar anexos', type: 'boolean', default: false, showWhen: { format: ['simple'] } },
      {
        name: 'dataPropertyAttachmentsPrefixName',
        displayName: 'Prefixo dos anexos',
        type: 'string',
        default: 'attachment_',
        description: 'Os anexos ficam nos arquivos do item com esse prefixo e o número: attachment_0, attachment_1… (no formato Simples, só com "Baixar anexos").',
        showWhen: { format: ['simple', 'resolved'] },
      },
      {
        name: 'customEmailConfig',
        displayName: 'Critérios de busca',
        type: 'string',
        default: '["UNSEEN"]',
        description:
          'Quais e-mails disparam, em JSON como no n8n. Ex.: ["UNSEEN"] (não lidos), ["ALL"], ["UNSEEN", ["FROM", "nfe@empresa.com"]], ["UNSEEN", ["SINCE", "May 20, 2024"]].',
      },
      {
        name: 'trackLastMessageId',
        displayName: 'Lembrar o último e-mail',
        type: 'boolean',
        default: true,
        description: 'Guarda o número (UID) do último e-mail processado e só pega os que chegarem depois, mesmo se continuarem não lidos.',
      },
      {
        name: 'forceReconnect',
        displayName: 'Reconectar a cada (minutos)',
        type: 'number',
        default: 0,
        description: 'Fecha e abre a conexão nesse intervalo, para servidores que param de avisar e-mails novos. 0: só reconecta quando a conexão cai.',
      },
    ],
  },
  execute: listenerExecute('Email Trigger (IMAP)'),
  listen: listenImap,
};

// =====================================================================
// Local File Trigger
// =====================================================================

const FOLDER_EVENTS = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const;

async function listenLocalFile(ctx: TriggerContext): Promise<() => Promise<void>> {
  const triggerOn = str(await ctx.getParam('triggerOn'), 'file') === 'folder' ? 'folder' : 'file';
  const rawPath = str(await ctx.getParam('path')).trim();
  if (!rawPath) throw new NodeOperationError(triggerOn === 'file' ? 'Informe o arquivo vigiado' : 'Informe a pasta vigiada');
  const target = await resolveAllowedPath(rawPath, ctx.filesDirs, await allowedRoots(ctx.filesDirs));

  let events: string[] = ['change'];
  if (triggerOn === 'folder') {
    const raw = await ctx.getParam('events');
    events = (Array.isArray(raw) ? raw.map((e) => str(e)) : str(raw).split(',').map((e) => e.trim())).filter((e) => (FOLDER_EVENTS as readonly string[]).includes(e));
    if (!events.length) throw new NodeOperationError('Escolha pelo menos um evento da pasta');
  }
  const ignored = str(await ctx.getParam('ignored')).trim();
  const depthRaw = Math.trunc(num(await ctx.getParam('depth'), -1));
  const isIgnored = ignored ? picomatch(ignored, { dot: true }) : null;

  const watcher = watch(target, {
    persistent: true,
    ignored: isIgnored ? (p: string) => isIgnored(p.replace(/\\/g, '/')) : undefined,
    ignoreInitial: bool(await ctx.getParam('ignoreInitial'), true),
    followSymlinks: bool(await ctx.getParam('followSymlinks'), true),
    depth: depthRaw >= 0 ? depthRaw : undefined,
    usePolling: bool(await ctx.getParam('usePolling')),
    awaitWriteFinish: bool(await ctx.getParam('awaitWriteFinish')),
  });
  for (const event of events) {
    watcher.on(event as 'add', (p: string) => {
      ctx.emit([{ json: { event, path: p } }]).catch((err) => ctx.emitError(asError(err, 'Local File Trigger')));
    });
  }
  watcher.on('error', (err) => ctx.emitError(asError(err, `Local File Trigger (${target})`)));

  await new Promise<void>((resolve) => {
    if (ctx.signal.aborted) return resolve();
    watcher.once('ready', () => resolve());
    ctx.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await watcher.close();
  };
  ctx.signal.addEventListener('abort', () => void close(), { once: true });
  if (ctx.signal.aborted) await close();
  return close;
}

export const localFileTrigger: NodeType = {
  description: {
    type: 'localFileTrigger',
    displayName: 'Local File Trigger',
    description: 'Inicia o fluxo quando um arquivo ou pasta do servidor muda (só nas pastas liberadas em FILES_DIRS).',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      {
        name: 'triggerOn',
        displayName: 'Disparar quando',
        type: 'options',
        default: 'file',
        options: [
          { name: 'Um arquivo mudar', value: 'file' },
          { name: 'Algo mudar numa pasta', value: 'folder' },
        ],
      },
      {
        name: 'path',
        displayName: 'Caminho',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/files/entrada',
        description: 'Arquivo ou pasta dentro das pastas liberadas em FILES_DIRS (no Docker, /files). Caminho relativo começa na primeira pasta liberada.',
      },
      {
        name: 'events',
        displayName: 'Eventos',
        type: 'multiOptions',
        default: [],
        required: true,
        options: [
          { name: 'Arquivo adicionado', value: 'add' },
          { name: 'Arquivo alterado', value: 'change' },
          { name: 'Arquivo apagado', value: 'unlink' },
          { name: 'Pasta adicionada', value: 'addDir' },
          { name: 'Pasta apagada', value: 'unlinkDir' },
        ],
        showWhen: { triggerOn: ['folder'] },
      },
      {
        name: 'awaitWriteFinish',
        displayName: 'Esperar o arquivo terminar de ser gravado',
        type: 'boolean',
        default: false,
        description: 'Só dispara quando o tamanho do arquivo para de mudar (bom para arquivos grandes copiados para a pasta).',
      },
      { name: 'followSymlinks', displayName: 'Incluir arquivos ligados (links)', type: 'boolean', default: true, description: 'Segue links simbólicos e vigia também o destino deles.' },
      {
        name: 'ignored',
        displayName: 'Ignorar',
        type: 'string',
        default: '',
        placeholder: '**/*.tmp',
        description: 'Padrão (glob) de caminhos que não disparam, comparado com o caminho completo. Ex.: **/*.tmp, **/.git/**, **/~$*.',
      },
      {
        name: 'ignoreInitial',
        displayName: 'Ignorar o que já existe',
        type: 'boolean',
        default: true,
        description: 'Ao ativar o fluxo, não dispara para os arquivos que já estão na pasta.',
      },
      {
        name: 'depth',
        displayName: 'Profundidade máxima',
        type: 'options',
        default: '-1',
        options: [
          { name: 'Sem limite', value: '-1' },
          { name: 'Só a pasta escolhida', value: '0' },
          { name: '1 nível de subpastas', value: '1' },
          { name: '2 níveis de subpastas', value: '2' },
          { name: '3 níveis de subpastas', value: '3' },
          { name: '4 níveis de subpastas', value: '4' },
        ],
        showWhen: { triggerOn: ['folder'] },
      },
      {
        name: 'usePolling',
        displayName: 'Verificar por consulta (polling)',
        type: 'boolean',
        default: false,
        description:
          'Consulta a pasta várias vezes por segundo em vez de esperar o aviso do sistema. Ligue com Docker Desktop no Windows (ou Mac) e em pastas de rede: nelas o aviso de mudança não chega e o gatilho fica mudo. Gasta mais CPU.',
      },
    ],
  },
  execute: listenerExecute('Local File Trigger'),
  listen: listenLocalFile,
};

// =====================================================================
// SSE Trigger
// =====================================================================

export interface SseMessage {
  event: string;
  data: string;
  id: string;
}

/** Interpreta o fluxo text/event-stream em pedaços (pode cortar no meio de uma linha). */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private eventType = '';
  lastEventId = '';
  retry: number | null = null;

  constructor(private readonly onMessage: (message: SseMessage) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // "\r" no fim do pedaço pode ser o começo de "\r\n": espera o próximo.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.eventType = value;
    else if (field === 'id') {
      if (!value.includes('\0')) this.lastEventId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
  }

  private dispatch(): void {
    const data = this.data;
    const event = this.eventType || 'message';
    this.data = [];
    this.eventType = '';
    if (!data.length) return;
    this.onMessage({ event, data: data.join('\n'), id: this.lastEventId });
  }

  /** Fim da conexão: um evento incompleto é descartado, como manda a especificação. */
  reset(): void {
    this.buffer = '';
    this.data = [];
    this.eventType = '';
  }
}

/** Item de uma mensagem SSE: o JSON do campo data, como no n8n; texto que não é JSON vai em { data }. */
export function sseMessageToItem(data: string): Item {
  try {
    const parsed = JSON.parse(data) as JsonValue;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { json: parsed };
    return { json: { data: parsed } };
  } catch {
    return { json: { data } };
  }
}

async function listenSse(ctx: TriggerContext): Promise<() => Promise<void>> {
  const url = str(await ctx.getParam('url')).trim();
  if (!url) throw new NodeOperationError('Informe a URL do SSE');
  if (!/^https?:\/\//i.test(url)) throw new NodeOperationError(`A URL "${url}" precisa começar com http:// ou https://`);

  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.signal, stop.signal]);
  let firstResult: ((err?: Error) => void) | null = null;
  const firstOpen = new Promise<Error | undefined>((resolve) => (firstResult = resolve));
  const settleFirst = (err?: Error) => {
    firstResult?.(err);
    firstResult = null;
  };

  const loop = async () => {
    let retry = 3000;
    let attempt = 0;
    let lastEventId = '';
    while (!signal.aborted) {
      const parser = new SseParser((message) => {
        if (message.event !== 'message') return;
        ctx.emit([sseMessageToItem(message.data)]).catch((err) => ctx.emitError(asError(err, 'SSE Trigger')));
      });
      parser.lastEventId = lastEventId;
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        const response = await fetch(url, { headers, signal });
        if (response.status === 204) {
          const err = new Error(`o servidor ${url} pediu para não reconectar (HTTP 204)`);
          settleFirst(err);
          ctx.emitError(asError(err, 'SSE Trigger'));
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        const type = response.headers.get('content-type') ?? '';
        if (!type.toLowerCase().includes('text/event-stream')) throw new Error(`a resposta não é um fluxo SSE (content-type "${type}")`);
        if (!response.body) throw new Error('resposta sem corpo');
        settleFirst();
        attempt = 0;
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          parser.push(decoder.decode(chunk, { stream: true }));
          lastEventId = parser.lastEventId;
          if (parser.retry !== null) retry = parser.retry;
        }
        parser.reset();
      } catch (err) {
        if (signal.aborted) break;
        const error = asError(err, `SSE Trigger (${url})`);
        if (firstResult) {
          settleFirst(error);
          if (ctx.testing) return;
        }
        ctx.emitError(error);
      }
      lastEventId = parser.lastEventId;
      if (signal.aborted) break;
      await sleep(Math.max(retry, backoff(attempt++, retry)), signal);
    }
    settleFirst();
  };
  const running = loop();

  const firstError = await firstOpen;
  if (firstError && ctx.testing) {
    stop.abort();
    await running;
    throw new NodeOperationError(firstError.message);
  }
  return async () => {
    stop.abort();
    await running;
  };
}

export const sseTrigger: NodeType = {
  description: {
    type: 'sseTrigger',
    displayName: 'SSE Trigger',
    description: 'Inicia o fluxo a cada mensagem recebida de um endereço Server-Sent Events (SSE).',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      {
        name: 'url',
        displayName: 'URL',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'http://exemplo.com.br/eventos',
        description: 'Endereço que envia os eventos (text/event-stream). Se a conexão cair, o gatilho reconecta sozinho.',
      },
    ],
  },
  execute: listenerExecute('SSE Trigger'),
  listen: listenSse,
};

export const listenTriggerNodes: NodeType[] = [rssFeedReadTrigger, emailReadImap, localFileTrigger, sseTrigger];
