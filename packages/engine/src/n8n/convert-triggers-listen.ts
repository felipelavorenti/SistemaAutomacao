import type { JsonObject, JsonValue } from '../types.js';
import { isObject, jsonish, type Converted, type Ctx, type Params } from './import.js';

/**
 * Conversores do importador do n8n para os gatilhos que escutam ou consultam: RSS Feed Trigger,
 * Email Trigger (IMAP), Local File Trigger e SSE Trigger.
 */

const opts = (params: Params, key = 'options'): Params => (isObject(params[key]) ? (params[key] as Params) : {});
/** Valor simples do n8n para o nosso (expressões "={{ }}" passam iguais). */
const v = (value: unknown, fallback: JsonValue): JsonValue => (value === undefined || value === null ? fallback : jsonish(value));
const bool = (value: unknown, fallback: boolean): JsonValue => (value === undefined || value === null ? fallback : typeof value === 'string' && value.startsWith('=') ? value : value === true || value === 'true');

const POLL_ROW_DEFAULTS: JsonObject = { mode: 'everyMinute', hour: 14, minute: 0, dayOfMonth: 1, weekday: '1', value: 2, unit: 'hours', cronExpression: '0 * * * * *' };
const POLL_MODES = new Set(['everyMinute', 'everyHour', 'everyDay', 'everyWeek', 'everyMonth', 'everyX', 'custom']);

/** O fixedCollection pollTimes.item[] do n8n vira a lista de horários daqui. */
export function convertPollTimes(raw: unknown, warn: (m: string) => void): JsonValue[] {
  const rows = isObject(raw) && Array.isArray(raw.item) ? raw.item.filter(isObject) : [];
  if (!rows.length) return [{ ...POLL_ROW_DEFAULTS }];
  const out: JsonValue[] = [];
  for (const row of rows) {
    const mode = String(row.mode ?? 'everyMinute');
    if (!POLL_MODES.has(mode)) {
      warn(`o horário de consulta "${mode}" não existe aqui e ficou de fora`);
      continue;
    }
    const converted: JsonObject = { ...POLL_ROW_DEFAULTS, mode };
    for (const key of ['hour', 'minute', 'dayOfMonth', 'value'] as const) if (row[key] !== undefined) converted[key] = v(row[key], POLL_ROW_DEFAULTS[key]!);
    if (row.weekday !== undefined) converted.weekday = String(row.weekday);
    if (row.unit !== undefined) converted.unit = String(row.unit);
    if (row.cronExpression !== undefined) converted.cronExpression = String(row.cronExpression);
    if (Object.values(converted).some((x) => typeof x === 'string' && x.startsWith('='))) warn('os horários de consulta não aceitam expressões; ajuste o horário');
    out.push(converted);
  }
  return out.length ? out : [{ ...POLL_ROW_DEFAULTS }];
}

// ---------- RSS Feed Trigger ----------

function rssFeedReadTrigger({ params, warn }: Ctx): Converted {
  const o = opts(params);
  return {
    type: 'rssFeedReadTrigger',
    parameters: {
      pollTimes: convertPollTimes(params.pollTimes, warn),
      feedUrl: v(params.feedUrl, 'https://blog.n8n.io/rss/'),
      ignoreSSL: bool(o.ignoreSSL ?? params.ignoreSSL, false),
    },
  };
}

// ---------- Email Trigger (IMAP) ----------

function emailReadImap({ params, warn }: Ctx): Converted {
  const o = opts(params);
  const format = String(params.format ?? 'simple');
  const p: JsonObject = {
    connection: '',
    mailbox: v(params.mailbox, 'INBOX'),
    postProcessAction: v(params.postProcessAction, 'read'),
    format: ['simple', 'resolved', 'raw'].includes(format) ? format : 'simple',
    downloadAttachments: bool(params.downloadAttachments, false),
    dataPropertyAttachmentsPrefixName: v(params.dataPropertyAttachmentsPrefixName, 'attachment_'),
    customEmailConfig: v(o.customEmailConfig, '["UNSEEN"]'),
    trackLastMessageId: bool(o.trackLastMessageId, true),
    forceReconnect: v(o.forceReconnect, 0),
  };
  if (!['simple', 'resolved', 'raw'].includes(format)) warn(`o formato "${format}" não existe aqui; ficou Simples`);
  if (p.postProcessAction !== 'read' && p.postProcessAction !== 'nothing') {
    warn(`a ação "${String(p.postProcessAction)}" depois de ler não existe aqui; ficou "Marcar como lido"`);
    p.postProcessAction = 'read';
  }
  warn('crie uma conexão do tipo IMAP (servidor, porta, usuário, senha, SSL) e escolha no nó: o n8n não exporta senhas');
  if (o.allowUnauthorizedCerts === true) warn('a opção "Ignore SSL Issues" agora fica na conexão IMAP: marque "Aceitar certificado inválido" nela');
  if (format === 'raw') warn('no formato Bruto, "raw" traz o e-mail inteiro (cabeçalhos e corpo) em base64; no n8n trazia só o corpo');
  return { type: 'emailReadImap', parameters: p };
}

// ---------- Local File Trigger ----------

function localFileTrigger({ params, warn }: Ctx): Converted {
  const o = opts(params);
  const triggerOn = String(params.triggerOn ?? 'file') === 'folder' ? 'folder' : 'file';
  const rawPath = typeof params.path === 'string' ? params.path : '';
  const shown = rawPath && !rawPath.startsWith('=') ? ` "${rawPath}"` : '';
  warn(
    `o caminho${shown} precisa estar numa pasta liberada em FILES_DIRS (no Docker, /files, ligada a uma pasta do computador); ajuste se ele apontava para outra pasta do servidor do n8n. Com Docker Desktop no Windows, ligue "Verificar por consulta (polling)"`,
  );
  let ignored = typeof o.ignored === 'string' ? o.ignored : '';
  if (ignored && String(o.ignoreMode ?? 'match') === 'contain') {
    ignored = `**/*${ignored}*{,/**}`;
    warn(`"Ignore Mode: Contain" virou o padrão "${ignored}"; confira`);
  }
  const events = Array.isArray(params.events) ? params.events.map(String) : [];
  const depth = o.depth === undefined || o.depth === null ? '-1' : String(o.depth);
  return {
    type: 'localFileTrigger',
    parameters: {
      triggerOn,
      path: v(params.path, ''),
      events,
      awaitWriteFinish: bool(o.awaitWriteFinish, false),
      followSymlinks: bool(o.followSymlinks, true),
      ignored,
      ignoreInitial: bool(o.ignoreInitial, true),
      depth: ['-1', '0', '1', '2', '3', '4'].includes(depth) ? depth : '-1',
      usePolling: bool(o.usePolling, false),
    },
  };
}

// ---------- SSE Trigger ----------

function sseTrigger({ params }: Ctx): Converted {
  return { type: 'sseTrigger', parameters: { url: v(params.url, '') } };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  rssFeedReadTrigger,
  emailReadImap,
  localFileTrigger,
  sseTrigger,
};
