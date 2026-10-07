import { randomUUID } from 'node:crypto';
import { parseTemplate, TemplateSyntaxError } from '../expressions/template.js';
import type { Connection, JsonObject, JsonValue, NodeInstance, NodeSettings, WorkflowDefinition } from '../types.js';

/**
 * Converte fluxos exportados do n8n para o formato da plataforma.
 *
 * Os nós equivalentes viram os nossos; os sem equivalente viram o nó
 * "Nó do n8n não convertido", que guarda o original e impede ativar o fluxo
 * até alguém substituí-lo. Tudo o que precisa de revisão volta em `warnings`.
 */

export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string; name?: string }>;
  disabled?: boolean;
  notes?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  continueOnFail?: boolean;
  onError?: string;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
}

interface N8nTarget {
  node: string;
  type?: string;
  index?: number;
}

export interface N8nWorkflow {
  id?: string | number;
  name?: string;
  active?: boolean;
  nodes: N8nNode[];
  connections?: Record<string, { main?: (N8nTarget[] | null)[] }>;
  settings?: { timezone?: string };
}

export interface ImportWarning {
  /** Nome do nó no fluxo importado, quando o aviso é de um nó. */
  node?: string;
  message: string;
}

export interface ConvertedWorkflow {
  n8nId: string | null;
  name: string;
  /** Se o fluxo estava ativo no n8n (aqui ele entra desativado). */
  wasActive: boolean;
  definition: WorkflowDefinition;
  warnings: ImportWarning[];
}

export interface ConvertOptions {
  /** ID do fluxo aqui, para o ID que ele tinha no n8n (subfluxos do Execute Workflow). */
  workflowId?: (n8nId: string) => string | undefined;
  /** Fuso dos agendamentos quando o fluxo do n8n não informa. */
  defaultTimezone?: string;
}

/**
 * No n8n o nó é um quadrado de 100 px e os nós ficam a uns 200 px um do outro; aqui o nó tem
 * pelo menos 190 px de largura. Espaçar na horizontal evita que o fluxo importado nasça sobreposto.
 */
const N8N_X_SPACING = 1.6;

export const UNSUPPORTED_NODE_TYPE = 'n8nUnsupported';

/** Aceita um fluxo, uma lista de fluxos ou o formato { data: [...] } da API do n8n. */
export function readN8nExport(json: unknown): N8nWorkflow[] {
  const list = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.data) ? json.data : isObject(json) && Array.isArray(json.workflows) ? json.workflows : [json];
  const workflows = list.filter((w): w is N8nWorkflow => isObject(w) && Array.isArray(w.nodes));
  if (!workflows.length) throw new Error('O arquivo não parece um fluxo exportado do n8n (faltam os nós)');
  return workflows;
}

export type Params = Record<string, unknown>;

export interface Converted {
  type: string;
  parameters: JsonObject;
  settings?: NodeSettings;
  /** Troca o índice das saídas do n8n pelos nossos (ex.: Split In Batches antigo). */
  outputMap?: (index: number) => number | null;
}

export interface Ctx {
  node: N8nNode;
  params: Params;
  warn: (message: string) => void;
  options: ConvertOptions;
  timezone: string;
}

export function convertN8nWorkflow(workflow: N8nWorkflow, options: ConvertOptions = {}): ConvertedWorkflow {
  const warnings: ImportWarning[] = [];
  const nodes: NodeInstance[] = [];
  const byName = new Map<string, { id: string; outputMap?: Converted['outputMap']; unsupported: boolean }>();
  const timezone = workflow.settings?.timezone || options.defaultTimezone || 'America/Sao_Paulo';
  const usedNames = new Set<string>();
  let notes = 0;

  for (const node of workflow.nodes) {
    const shortType = node.type.replace(/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./, '');
    if (shortType === 'stickyNote') {
      notes++;
      continue;
    }
    const warn = (message: string) => warnings.push({ node: node.name, message });
    const ctx: Ctx = { node, params: node.parameters ?? {}, warn, options, timezone };
    let converted: Converted | null;
    try {
      converted = convertNode(shortType, ctx);
    } catch (err) {
      warn(`não foi possível converter (${err instanceof Error ? err.message : String(err)})`);
      converted = null;
    }
    if (!converted) {
      converted = unsupported(node, shortType);
      warn(/trigger$/i.test(shortType) || shortType === 'webhook' ? `o gatilho "${shortType}" do n8n não existe aqui; use o manual ou o agendamento` : `o nó "${shortType}" do n8n não tem equivalente aqui; substitua-o`);
    }

    const settings: NodeSettings = { ...converted.settings };
    if (node.retryOnFail) {
      settings.retryOnFail = true;
      settings.maxTries = node.maxTries ?? 3;
      settings.waitBetweenTriesMs = node.waitBetweenTries ?? 1000;
    }
    if (node.continueOnFail || node.onError === 'continueRegularOutput') settings.continueOnFail = true;
    if (node.onError === 'continueErrorOutput') {
      settings.continueOnFail = true;
      warn('no n8n o erro saía por uma saída própria; aqui o item de erro segue pela saída normal');
    }
    if (node.alwaysOutputData) warn('a opção "Always Output Data" do n8n não existe aqui');
    if (node.executeOnce && converted.type !== 'database') warn('a opção "Execute Once" do n8n não existe neste nó; ele roda para cada item como antes do ajuste');

    const name = uniqueName(node.name, usedNames);
    const id = node.id && /^[\w-]{1,64}$/.test(node.id) && !nodes.some((n) => n.id === node.id) ? node.id : randomUUID();
    const instance: NodeInstance = {
      id,
      name,
      type: converted.type,
      position: { x: Math.round((node.position?.[0] ?? 0) * N8N_X_SPACING), y: Math.round(node.position?.[1] ?? 0) },
      parameters: converted.parameters,
    };
    if (Object.keys(settings).length) instance.settings = settings;
    if (node.disabled) instance.disabled = true;
    if (node.notes) instance.notes = node.notes;
    if (node.credentials && Object.keys(node.credentials).length) {
      const names = Object.values(node.credentials).map((c) => c.name ?? c.id ?? '?');
      warn(`recadastre a credencial ${names.map((n) => `"${n}"`).join(', ')} como conexão e escolha no nó (o n8n não exporta senhas)`);
    }
    for (const token of incompatibleTokens(converted.parameters)) warn(token);
    nodes.push(instance);
    byName.set(node.name, { id, outputMap: converted.outputMap, unsupported: converted.type === UNSUPPORTED_NODE_TYPE });
  }

  const connections: Connection[] = [];
  for (const [fromName, outputs] of Object.entries(workflow.connections ?? {})) {
    const from = byName.get(fromName);
    if (!from) continue;
    (outputs.main ?? []).forEach((targets, n8nIndex) => {
      for (const target of targets ?? []) {
        const to = byName.get(target.node);
        if (!to) continue;
        let fromOutput = from.outputMap ? from.outputMap(n8nIndex) : n8nIndex;
        if (from.unsupported && n8nIndex > 0) {
          warnings.push({ node: fromName, message: `a ligação da saída ${n8nIndex + 1} para "${target.node}" foi removida; refaça ao substituir o nó` });
          fromOutput = null;
        }
        if (fromOutput === null) continue;
        connections.push({ from: from.id, fromOutput, to: to.id, toInput: target.index ?? 0 });
      }
    });
  }
  if (notes) warnings.push({ message: `${notes} nota(s) do canvas do n8n não foram importadas` });

  return {
    n8nId: workflow.id === undefined || workflow.id === null ? null : String(workflow.id),
    name: workflow.name?.trim() || 'Fluxo importado do n8n',
    wasActive: workflow.active === true,
    definition: { nodes, connections },
    warnings,
  };
}

function convertNode(type: string, ctx: Ctx): Converted | null {
  switch (type) {
    case 'manualTrigger':
      return { type: 'manualTrigger', parameters: {} };
    case 'executeWorkflowTrigger':
      return { type: 'executeWorkflowTrigger', parameters: {} };
    case 'scheduleTrigger':
      return scheduleTrigger(ctx);
    case 'cron':
      return cronTrigger(ctx);
    case 'httpRequest':
      return httpRequest(ctx);
    case 'code':
      return codeNode(ctx);
    case 'function':
    case 'functionItem':
      return legacyFunction(type, ctx);
    case 'executeWorkflow':
      return executeWorkflow(ctx);
    case 'splitOut':
      return splitOut(ctx);
    case 'aggregate':
      return aggregate(ctx);
    case 'merge':
      return merge(ctx);
    case 'if':
      return ifNode(ctx);
    case 'filter':
      ctx.warn('o nó Filter virou um If; os itens que passam saem por "verdadeiro"');
      return ifNode(ctx);
    case 'splitInBatches':
      return splitInBatches(ctx);
    case 'stopAndError':
      return stopAndError(ctx);
    case 'noOp':
      ctx.warn('o nó No Operation virou um Code que repassa os itens');
      return { type: 'code', parameters: { language: 'javaScript', mode: 'all', jsCode: 'return $input.all();' } };
    case 'set':
      return setNode(ctx);
    case 'postgres':
      return database(ctx, 'postgres');
    case 'microsoftSql':
      return database(ctx, 'mssql');
    case 'oracleDatabase':
      return database(ctx, 'oracle');
    case 'clickUp':
      return clickUp(ctx);
    case 'gmail':
      return gmail(ctx);
    default:
      return null;
  }
}

function unsupported(node: N8nNode, shortType: string): Converted {
  return {
    type: UNSUPPORTED_NODE_TYPE,
    parameters: {
      n8nType: node.type,
      n8nParameters: JSON.stringify(node.parameters ?? {}, null, 2),
      reason: `O nó "${shortType}" do n8n não tem equivalente aqui.`,
    },
  };
}

// ---------- Gatilhos ----------

const WEEKDAYS = ['0', '1', '2', '3', '4', '5', '6'];

function scheduleTrigger({ params, warn, timezone }: Ctx): Converted {
  const rule = isObject(params.rule) ? params.rule : {};
  const intervals = Array.isArray(rule.interval) ? rule.interval.filter(isObject) : [{}];
  if (intervals.length > 1) warn(`o n8n tinha ${intervals.length} regras de horário; só a primeira foi importada`);
  const r = intervals[0] ?? {};
  const field = String(r.field ?? 'days');
  const n = (key: string, fallback: number) => {
    const v = Number(r[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const at = (key: string, fallback: number) => {
    const v = Number(r[key]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const every = (value: number, unit: string) => (value > 1 ? `*/${value}` : unit);
  const cron = (expr: string): Converted => ({ type: 'scheduleTrigger', parameters: { mode: 'cron', cron: expr, timezone } });

  const hhmmss = (h: number, m: number, sec = 0) => [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
  const time = () => hhmmss(at('triggerAtHour', 0), at('triggerAtMinute', 0));
  const schedule = (parameters: Converted['parameters']): Converted => ({ type: 'scheduleTrigger', parameters: { ...parameters, timezone } });

  switch (field) {
    case 'seconds':
      return schedule({ mode: 'interval', intervalMinutes: n('secondsInterval', 30), intervalUnit: 'seconds' });
    case 'minutes':
      return schedule({ mode: 'interval', intervalMinutes: n('minutesInterval', 5), intervalUnit: 'minutes' });
    case 'hours':
      return cron(`${at('triggerAtMinute', 0)} ${every(n('hoursInterval', 1), '*')} * * *`);
    case 'days':
      if (n('daysInterval', 1) === 1) return schedule({ mode: 'daily', time: time() });
      return cron(`${at('triggerAtMinute', 0)} ${at('triggerAtHour', 0)} ${every(n('daysInterval', 1), '*')} * *`);
    case 'weeks': {
      if (n('weeksInterval', 1) > 1) warn('o agendamento "a cada N semanas" virou toda semana; ajuste se precisar');
      const days = Array.isArray(r.triggerAtDay) && r.triggerAtDay.length ? r.triggerAtDay.map(String).filter((d) => WEEKDAYS.includes(d)) : ['0'];
      return schedule({ mode: 'weekly', weekdays: days, time: time() });
    }
    case 'months':
      if (n('monthsInterval', 1) === 1) return schedule({ mode: 'monthly', dayOfMonth: n('triggerAtDayOfMonth', 1), time: time() });
      return cron(`${at('triggerAtMinute', 0)} ${at('triggerAtHour', 0)} ${n('triggerAtDayOfMonth', 1)} ${every(n('monthsInterval', 1), '*')} *`);
    case 'cronExpression':
      return cron(String(r.expression ?? '').trim());
    default:
      warn(`tipo de agendamento "${field}" desconhecido; ficou todo dia às 8h`);
      return schedule({ mode: 'daily', time: '08:00:00' });
  }
}

function cronTrigger({ params, warn, timezone }: Ctx): Converted {
  const times = isObject(params.triggerTimes) && Array.isArray(params.triggerTimes.item) ? params.triggerTimes.item.filter(isObject) : [];
  if (times.length > 1) warn(`o nó Cron tinha ${times.length} horários; só o primeiro foi importado`);
  const t = times[0] ?? { mode: 'everyDay' };
  const h = Number(t.hour ?? 14);
  const m = Number(t.minute ?? 0);
  const cron = (expr: string): Converted => ({ type: 'scheduleTrigger', parameters: { mode: 'cron', cron: expr, timezone } });
  const schedule = (parameters: Converted['parameters']): Converted => ({ type: 'scheduleTrigger', parameters: { ...parameters, timezone } });
  const time = [h, m, 0].map((v) => String(v).padStart(2, '0')).join(':');
  switch (t.mode) {
    case 'everyMinute':
      return schedule({ mode: 'interval', intervalMinutes: 1, intervalUnit: 'minutes' });
    case 'everyHour':
      return cron(`${m} * * * *`);
    case 'everyDay':
      return schedule({ mode: 'daily', time });
    case 'everyWeek':
      return schedule({ mode: 'weekly', weekdays: [String(Number(t.weekday ?? 1))], time });
    case 'everyMonth':
      return schedule({ mode: 'monthly', dayOfMonth: Number(t.dayOfMonth ?? 1), time });
    case 'everyX':
      return t.unit === 'hours'
        ? schedule({ mode: 'interval', intervalMinutes: Number(t.value ?? 1), intervalUnit: 'hours' })
        : schedule({ mode: 'interval', intervalMinutes: Number(t.value ?? 1), intervalUnit: 'minutes' });
    case 'custom':
      return cron(String(t.cronExpression ?? '').trim());
    default:
      warn('horário do nó Cron não reconhecido; ficou todo dia às 8h');
      return schedule({ mode: 'daily', time: '08:00:00' });
  }
}

// ---------- HTTP ----------

function pairsOf(value: unknown): { name: string; value: string }[] {
  const list = isObject(value) ? (value.parameters ?? value.parameter) : value;
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((p) => ({ name: String(p.name ?? ''), value: p.value === undefined || p.value === null ? '' : String(p.value) }));
}

function httpRequest(ctx: Ctx): Converted {
  const { params, warn } = ctx;
  const version = ctx.node.typeVersion ?? 1;
  const out: JsonObject = { source: 'manual', url: String(params.url ?? '') };
  const settings: NodeSettings = {};

  if (version < 3) {
    // Versões 1 e 2 do nó (fluxos antigos). Com "JSON Parameters" ligado, query, headers e corpo vêm como texto JSON.
    const legacyOpts = isObject(params.options) ? params.options : {};
    const contentType = String(legacyOpts.bodyContentType ?? 'json');
    out.method = String(params.requestMethod ?? 'GET');
    if (params.jsonParameters) {
      out.queryParameters = jsonToPairs(params.queryParametersJson, 'os parâmetros de query', warn);
      out.headers = jsonToPairs(params.headerParametersJson, 'os headers', warn);
      const raw = typeof params.bodyParametersJson === 'string' ? params.bodyParametersJson : '';
      if (raw.trim() && raw.trim() !== '=' && contentType === 'form-urlencoded') {
        out.bodyType = 'form';
        out.formBody = jsonToPairs(raw, 'o corpo', warn);
      } else if (raw.trim() && raw.trim() !== '=' && contentType === 'raw') {
        out.bodyType = 'text';
        out.textBody = raw;
      } else if (raw.trim() && raw.trim() !== '=') {
        out.bodyType = 'json';
        out.jsonBody = raw;
      }
    } else {
      out.queryParameters = pairsOf(params.queryParametersUi);
      out.headers = pairsOf(params.headerParametersUi);
      const body = pairsOf(params.bodyParametersUi);
      if (body.length && contentType === 'form-urlencoded') {
        out.bodyType = 'form';
        out.formBody = body;
      } else if (body.length) {
        out.bodyType = 'json';
        out.jsonBody = pairsToJsonBody(body);
      }
    }
    if (contentType === 'raw' && legacyOpts.bodyContentCustomMimeType) {
      out.headers = [...((out.headers as JsonObject[] | undefined) ?? []), { name: 'content-type', value: String(legacyOpts.bodyContentCustomMimeType) }];
    }
    if (contentType === 'multipart-form-data') warn('o corpo multipart do n8n não existe aqui');
    if (legacyOpts.fullResponse) out.fullResponse = true;
    warn('HTTP Request de versão antiga do n8n: confira método, corpo e autenticação');
  } else {
    out.method = String(params.method ?? 'GET');
    if (params.sendQuery) {
      if (params.specifyQuery === 'json') warn('a query estava em JSON no n8n; passe os parâmetros para a lista');
      out.queryParameters = pairsOf(params.queryParameters);
    }
    if (params.sendHeaders) {
      if (params.specifyHeaders === 'json') warn('os headers estavam em JSON no n8n; passe-os para a lista');
      out.headers = pairsOf(params.headerParameters);
    }
    if (params.sendBody) {
      const contentType = String(params.contentType ?? 'json');
      if (contentType === 'json') {
        out.bodyType = 'json';
        out.jsonBody = params.specifyBody === 'json' ? String(params.jsonBody ?? '{}') : pairsToJsonBody(pairsOf(params.bodyParameters));
      } else if (contentType === 'form-urlencoded') {
        out.bodyType = 'form';
        out.formBody = pairsOf(params.bodyParameters);
      } else if (contentType === 'raw') {
        out.bodyType = 'text';
        out.textBody = String(params.body ?? '');
        if (params.rawContentType) out.headers = [...((out.headers as JsonObject[] | undefined) ?? []), { name: 'content-type', value: String(params.rawContentType) }];
      } else {
        warn(`o corpo "${contentType}" (arquivo ou multipart) não existe aqui`);
      }
    }
  }
  if (params.authentication && params.authentication !== 'none') warn('a autenticação vinha de uma credencial do n8n; escolha a conexão no campo Conexão');

  const opts = isObject(params.options) ? params.options : {};
  if (typeof opts.timeout === 'number') settings.timeoutMs = opts.timeout;
  const response = isObject(opts.response) && isObject(opts.response.response) ? opts.response.response : {};
  if (response.fullResponse) out.fullResponse = true;
  if (response.neverError) out.failOnHttpError = false;
  if (isObject(opts.pagination)) warn('a paginação automática do n8n não existe aqui; use um Loop');
  if (isObject(opts.batching)) warn('o envio em lotes do n8n não foi importado');
  return { type: 'httpRequest', parameters: out, settings };
}

/**
 * Texto JSON do n8n (headers, query ou corpo com "JSON Parameters") em pares nome/valor.
 * Aceita {{ }} dentro das aspas ou soltos; cada valor com {{ }} vira uma expressão.
 */
function jsonToPairs(value: unknown, what: string, warn: (message: string) => void): { name: string; value: string }[] {
  if (isObject(value)) return Object.entries(value).map(([name, v]) => ({ name, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  if (typeof value !== 'string') return [];
  const text = (value.startsWith('=') ? value.slice(1) : value).trim();
  if (!text) return [];
  const exprs: string[] = [];
  const marked = text.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => `__SA_EXPR_${exprs.push(expr.trim()) - 1}__`);
  const attempts = [marked, marked.replace(/(^|[^"\w])(__SA_EXPR_\d+__)(?=[^"\w]|$)/g, '$1"$2"')];
  for (const attempt of attempts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (!isObject(parsed)) break;
    return Object.entries(parsed).map(([name, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      const restored = raw.replace(/__SA_EXPR_(\d+)__/g, (_, n: string) => `{{ ${exprs[Number(n)]} }}`);
      return { name, value: restored === raw ? raw : `=${restored}` };
    });
  }
  warn(`não deu para ler ${what} em JSON do n8n; preencha a lista à mão a partir de: ${value}`);
  return [];
}

/** Pares nome/valor do n8n viram o corpo JSON; valores com {{ }} viram uma expressão. */
function pairsToJsonBody(pairs: { name: string; value: string }[]): string {
  if (!pairs.some((p) => p.value.startsWith('='))) {
    return JSON.stringify(Object.fromEntries(pairs.filter((p) => p.name).map((p) => [p.name, p.value])), null, 2);
  }
  const fields = pairs.filter((p) => p.name).map((p) => `${JSON.stringify(p.name)}: ${valueToJs(p.value)}`);
  return `={{ ({ ${fields.join(', ')} }) }}`;
}

/** Um valor do n8n (fixo ou "={{ ... }}") como código JavaScript. */
function valueToJs(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value ?? null);
  if (!value.startsWith('=')) return JSON.stringify(value);
  let parts;
  try {
    parts = parseTemplate(value.slice(1));
  } catch (err) {
    if (err instanceof TemplateSyntaxError) return JSON.stringify(value);
    throw err;
  }
  if (parts.length === 1 && parts[0]!.kind === 'code') return `(${parts[0]!.value})`;
  if (!parts.length) return '""';
  return parts.map((p) => (p.kind === 'text' ? JSON.stringify(p.value) : `${AS_TEXT}(${p.value})`)).join(' + ');
}

/** Como o n8n junta texto e {{ }}: objetos viram JSON e vazio vira "". */
const AS_TEXT = "((v) => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))";

// ---------- Código ----------

function codeNode({ params, warn }: Ctx): Converted {
  const mode = params.mode === 'runOnceForEachItem' ? 'each' : 'all';
  const language = String(params.language ?? 'javaScript');
  if (language === 'python' || language === 'pythonNative') {
    const code = String(params.pythonCode ?? '');
    if (language === 'pythonNative') warn('o código era do Python nativo do n8n (_items/_item); adapte para _input.all() e _json');
    if (code.includes('.to_py(')) warn('o código usa .to_py(); aqui os itens já são dicionários do Python, então remova o .to_py()');
    if (/^\s*(import|from)\s+(pandas|numpy|requests)\b/m.test(code)) warn('o código importa uma biblioteca que não existe aqui (só a biblioteca padrão do Python)');
    return { type: 'code', parameters: { language: 'python', mode, pythonCode: code } };
  }
  const code = String(params.jsCode ?? '');
  if (/\brequire\s*\(/.test(code)) warn('o código usa require(), que não existe aqui');
  return { type: 'code', parameters: { language: 'javaScript', mode, jsCode: code } };
}

function legacyFunction(type: string, { params, warn }: Ctx): Converted {
  warn(`o nó ${type === 'function' ? 'Function' : 'Function Item'} (antigo) virou Code; confira o resultado`);
  if (type === 'function') {
    const code = String(params.functionCode ?? 'return items;');
    return { type: 'code', parameters: { language: 'javaScript', mode: 'all', jsCode: `const items = $input.all();\n${code}` } };
  }
  const code = String(params.functionCode ?? 'return item;');
  return { type: 'code', parameters: { language: 'javaScript', mode: 'each', jsCode: `const item = $json;\n${code}` } };
}

/** O nó Set (Edit Fields) vira o nó Edit Fields daqui, com os mesmos campos. */
function setNode({ params, node }: Ctx): Converted {
  const version = node.typeVersion ?? 1;
  const opts = isObject(params.options) ? params.options : {};
  const common: JsonObject = { dotNotation: opts.dotNotation !== false, ignoreConversionErrors: opts.ignoreConversionErrors === true };
  const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

  if (version >= 3) {
    const include = ['selected', 'except'].includes(String(params.include)) ? String(params.include) : 'all';
    const others: JsonObject = {
      includeOtherFields: params.includeOtherFields === true || (version < 3.3 && params.include !== undefined && params.include !== 'none'),
      include,
      includeFields: text(params.includeFields),
      excludeFields: text(params.excludeFields),
    };
    if (params.mode === 'raw') return { type: 'editFields', parameters: { mode: 'raw', jsonOutput: text(params.jsonOutput ?? '{}'), ...others, ...common } };
    const assignments: JsonObject[] = [];
    const list = isObject(params.assignments) && Array.isArray(params.assignments.assignments) ? params.assignments.assignments.filter(isObject) : [];
    for (const a of list) assignments.push({ name: text(a.name), type: String(a.type ?? 'string'), value: text(a.value) });
    // Versões 3.0 a 3.2 usavam "fields".
    const fields = isObject(params.fields) && Array.isArray(params.fields.values) ? params.fields.values.filter(isObject) : [];
    for (const f of fields) {
      const kind = String(f.type ?? 'stringValue').replace(/Value$/, '');
      assignments.push({ name: text(f.name), type: kind, value: text(f[`${kind}Value`]) });
    }
    return { type: 'editFields', parameters: { mode: 'manual', assignments, ...others, ...common } };
  }

  const values = isObject(params.values) ? params.values : {};
  const assignments: JsonObject[] = [];
  for (const kind of ['string', 'number', 'boolean']) {
    for (const v of Array.isArray(values[kind]) ? values[kind].filter(isObject) : []) assignments.push({ name: text(v.name), type: kind, value: text(v.value) });
  }
  return { type: 'editFields', parameters: { mode: 'manual', assignments, includeOtherFields: params.keepOnlySet !== true, include: 'all', ...common } };
}

// ---------- Fluxo ----------

function rlValue(value: unknown): unknown {
  return isObject(value) && '__rl' in value ? value.value : value;
}

function executeWorkflow({ params, warn, options }: Ctx): Converted {
  const source = String(params.source ?? 'database');
  if (source !== 'database') warn(`o subfluxo vinha de "${source}" no n8n; escolha o fluxo aqui`);
  const raw = rlValue(params.workflowId);
  let workflowId = '';
  if (typeof raw === 'string' && raw.startsWith('=')) {
    workflowId = raw;
    warn('o fluxo chamado vem de uma expressão com o ID do n8n; troque pelo ID do fluxo aqui');
  } else if (raw !== undefined && raw !== null && raw !== '') {
    const mapped = options.workflowId?.(String(raw));
    if (mapped) workflowId = mapped;
    else warn(`o subfluxo ${String(raw)} do n8n ainda não foi importado; importe-o e escolha o fluxo aqui`);
  }
  const opts = isObject(params.options) ? params.options : {};
  if (opts.waitForSubWorkflow === false) warn('no n8n este nó não esperava o subfluxo terminar; aqui ele sempre espera');
  return { type: 'executeWorkflow', parameters: { workflowId, mode: params.mode === 'each' ? 'each' : 'once' } };
}

export function splitOut({ params, warn }: Ctx): Converted {
  const fields = String(params.fieldToSplitOut ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.length > 1) warn(`o n8n separava ${fields.length} campos juntos; só "${fields[0]}" foi importado`);
  const include = String(params.include ?? 'noOtherFields');
  if (include === 'selectedOtherFields') warn('a escolha de quais outros campos manter não foi importada; todos foram mantidos');
  const opts = isObject(params.options) ? params.options : {};
  return {
    type: 'splitOut',
    parameters: { field: fields[0] ?? '', include: include === 'noOtherFields' ? 'none' : 'all', destination: String(opts.destinationFieldName ?? '') },
  };
}

export function aggregate({ params }: Ctx): Converted {
  if (params.aggregate === 'aggregateAllItemData') {
    return { type: 'aggregate', parameters: { mode: 'all', destination: String(params.destinationFieldName ?? 'data') } };
  }
  const list = isObject(params.fieldsToAggregate) && Array.isArray(params.fieldsToAggregate.fieldToAggregate) ? params.fieldsToAggregate.fieldToAggregate.filter(isObject) : [];
  return {
    type: 'aggregate',
    parameters: {
      mode: 'fields',
      fields: list.map((f) => ({ field: String(f.fieldToAggregate ?? ''), outputName: f.renameField ? String(f.outputFieldName ?? '') : '' })),
    },
  };
}

function merge({ params, warn, node }: Ctx): Converted | null {
  const version = node.typeVersion ?? 1;
  const mode = String(params.mode ?? 'append');
  if (version >= 3 || ['combine', 'chooseBranch', 'combineBySql'].includes(mode)) {
    if (mode === 'append') return { type: 'merge', parameters: { mode: 'append' } };
    if (mode === 'chooseBranch') {
      const input = Number(params.useDataOfInput ?? 1) === 2 ? 'input2' : 'input1';
      return { type: 'merge', parameters: { mode: 'choose', output: input } };
    }
    if (mode === 'combine' || mode === 'combineByFields' || mode === 'combineByPosition') {
      const by = mode === 'combine' ? String(params.combineBy ?? 'combineByFields') : mode;
      if (by === 'combineByPosition') return { type: 'merge', parameters: { mode: 'position' } };
      if (by === 'combineByFields') {
        let field1 = '';
        let field2 = '';
        const advanced = isObject(params.mergeByFields) && Array.isArray(params.mergeByFields.values) ? params.mergeByFields.values.filter(isObject) : [];
        if (params.advanced && advanced.length) {
          field1 = String(advanced[0]!.field1 ?? '');
          field2 = String(advanced[0]!.field2 ?? '');
          if (advanced.length > 1) warn('o n8n combinava por mais de um campo; só o primeiro par foi importado');
        } else {
          field1 = field2 = String(params.fieldsToMatchString ?? '').split(',')[0]!.trim();
        }
        const join = String(params.joinMode ?? 'keepMatches');
        if (!['keepMatches', 'enrichInput1'].includes(join)) warn(`o modo "${join}" do n8n não existe aqui; ficou "só os itens que combinam"`);
        return { type: 'merge', parameters: { mode: 'fields', field1, field2, join: join === 'enrichInput1' ? 'left' : 'inner' } };
      }
    }
    return null;
  }
  // Merge v1/v2
  switch (mode) {
    case 'append':
      return { type: 'merge', parameters: { mode: 'append' } };
    case 'mergeByIndex':
      return { type: 'merge', parameters: { mode: 'position' } };
    case 'mergeByKey':
    case 'keepKeyMatches':
      return { type: 'merge', parameters: { mode: 'fields', field1: String(params.propertyName1 ?? ''), field2: String(params.propertyName2 ?? ''), join: 'inner' } };
    case 'passThrough':
      return { type: 'merge', parameters: { mode: 'choose', output: params.output === 'input2' ? 'input2' : 'input1' } };
    default:
      return null;
  }
}

const IF_V2_OPERATIONS: Record<string, string> = {
  equals: 'equals',
  notEquals: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  after: 'gt',
  afterOrEquals: 'gte',
  before: 'lt',
  beforeOrEquals: 'lte',
  empty: 'isEmpty',
  notEmpty: 'isNotEmpty',
  exists: 'isNotEmpty',
  notExists: 'isEmpty',
  true: 'isTrue',
  false: 'isFalse',
  regex: 'regex',
};

const IF_V1_OPERATIONS: Record<string, string> = {
  equal: 'equals',
  notEqual: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  larger: 'gt',
  largerEqual: 'gte',
  smaller: 'lt',
  smallerEqual: 'lte',
  after: 'gt',
  before: 'lt',
  isEmpty: 'isEmpty',
  isNotEmpty: 'isNotEmpty',
  regex: 'regex',
};

export function ifNode({ params, warn }: Ctx): Converted {
  const conditions: JsonObject[] = [];
  let combinator = 'and';
  const v2 = isObject(params.conditions) && Array.isArray(params.conditions.conditions);
  if (v2) {
    const block = params.conditions as Params;
    combinator = block.combinator === 'or' ? 'or' : 'and';
    if (params.combinator) combinator = params.combinator === 'or' ? 'or' : 'and';
    for (const c of (block.conditions as unknown[]).filter(isObject)) {
      const op = isObject(c.operator) ? String(c.operator.operation ?? 'equals') : 'equals';
      const mapped = IF_V2_OPERATIONS[op];
      if (!mapped) warn(`a condição "${op}" não existe aqui; ficou "é igual a"`);
      if (op === 'exists' || op === 'notExists') warn(`a condição "${op}" virou "${op === 'exists' ? 'não está vazio' : 'está vazio'}"`);
      conditions.push({ left: jsonish(c.leftValue), operator: mapped ?? 'equals', right: jsonish(c.rightValue) });
    }
  } else if (isObject(params.conditions)) {
    combinator = params.combineOperation === 'any' ? 'or' : 'and';
    for (const kind of ['boolean', 'number', 'string', 'dateTime']) {
      const list = Array.isArray(params.conditions[kind]) ? params.conditions[kind].filter(isObject) : [];
      for (const c of list) {
        const op = String(c.operation ?? 'equal');
        let mapped = IF_V1_OPERATIONS[op];
        if (!mapped) {
          warn(`a condição "${op}" não existe aqui; ficou "é igual a"`);
          mapped = 'equals';
        }
        conditions.push({ left: jsonish(c.value1), operator: mapped, right: jsonish(c.value2) });
      }
    }
  }
  if (!conditions.length) conditions.push({ left: '', operator: 'equals', right: '' });
  return { type: 'if', parameters: { combinator, conditions } };
}

export function jsonish(value: unknown): JsonValue {
  if (value === undefined) return '';
  return (typeof value === 'object' && value !== null ? JSON.stringify(value) : value) as JsonValue;
}

function splitInBatches({ params, warn, node }: Ctx): Converted {
  const batchSize = Number(params.batchSize ?? (node.typeVersion && node.typeVersion >= 3 ? 1 : 10)) || 1;
  if ((node.typeVersion ?? 1) >= 3) return { type: 'loop', parameters: { batchSize } };
  warn('Split In Batches antigo: o ramo de cada lote foi ligado na saída "loop"; confira como o fluxo detecta o fim');
  return { type: 'loop', parameters: { batchSize }, outputMap: (i) => (i === 0 ? 1 : null) };
}

function stopAndError({ params }: Ctx): Converted {
  if (params.errorType === 'errorObject') {
    return { type: 'stopAndError', parameters: { errorType: 'object', errorObject: String(params.errorObject ?? '{}') } };
  }
  return { type: 'stopAndError', parameters: { errorType: 'message', message: String(params.errorMessage ?? '') } };
}

// ---------- Bancos ----------

function database(ctx: Ctx, dialect: 'postgres' | 'mssql' | 'oracle'): Converted | null {
  const { params, warn, node } = ctx;
  const operation = String(params.operation ?? (dialect === 'oracle' ? 'execute' : 'executeQuery'));
  const base: JsonObject = { connection: '', executeOnce: node.executeOnce === true };
  warn('escolha a conexão do banco (as credenciais do n8n não vêm na exportação)');

  if (operation === 'executeQuery' || operation === 'execute') {
    const sqlRaw = String(params.query ?? params.statement ?? '');
    const { sql, queryParams } = positionalToNamed(sqlRaw, params, dialect, warn);
    return { type: 'database', parameters: { ...base, operation: 'query', sql, queryParams } };
  }
  if (operation === 'insert') {
    const schema = rlValue(params.schema);
    const tableName = String(rlValue(params.table) ?? '');
    const table = schema && schema !== 'public' && dialect === 'postgres' ? `${String(schema)}.${tableName}` : tableName;
    if (isObject(params.columns)) {
      // Postgres v2: mapeamento automático ou coluna por coluna.
      const columns = params.columns;
      if (columns.mappingMode === 'defineBelow' && isObject(columns.value)) {
        return {
          type: 'database',
          parameters: { ...base, operation: 'insert', table, columnsMode: 'manual', columns: Object.entries(columns.value).map(([column, value]) => ({ column, value: jsonish(value) })) },
        };
      }
      return { type: 'database', parameters: { ...base, operation: 'insert', table, columnsMode: 'auto' } };
    }
    const names = String(params.columns ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (!names.length) return { type: 'database', parameters: { ...base, operation: 'insert', table, columnsMode: 'auto' } };
    return {
      type: 'database',
      parameters: { ...base, operation: 'insert', table, columnsMode: 'manual', columns: names.map((c) => ({ column: c, value: `={{ $json[${JSON.stringify(c)}] }}` })) },
    };
  }
  warn(`a operação "${operation}" do n8n não existe no nó Banco de dados; escreva o SQL`);
  return { type: 'database', parameters: { ...base, operation: 'query', sql: `-- Operação "${operation}" do n8n: escreva o SQL equivalente\n`, queryParams: [] } };
}

/** $1, $2 do Postgres no n8n viram :p1, :p2, com os valores que o n8n mandava. */
function positionalToNamed(sql: string, params: Params, dialect: string, warn: (m: string) => void): { sql: string; queryParams: JsonObject[] } {
  const opts = isObject(params.options) ? params.options : {};
  const replacement = opts.queryReplacement ?? (isObject(params.additionalFields) ? params.additionalFields.queryParams : undefined);
  if (dialect !== 'postgres' || !/\$\d+/.test(sql)) {
    if (replacement) warn('os parâmetros da consulta do n8n não foram importados; use :nome no SQL e preencha a lista');
    if (/\{\{/.test(sql)) warn('o SQL monta valores com {{ }}; prefira parâmetros :nome para evitar SQL injection');
    return { sql, queryParams: [] };
  }
  const count = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const converted = sql.replace(/\$(\d+)/g, (_, n: string) => `:p${n}`);
  const values: string[] = [];
  if (typeof replacement === 'string' && replacement.startsWith('=')) {
    const parts = (() => {
      try {
        return parseTemplate(replacement.slice(1));
      } catch {
        return [];
      }
    })();
    const single = parts.length === 1 && parts[0]!.kind === 'code' ? parts[0]!.value : null;
    for (let i = 0; i < count; i++) {
      values.push(single ? `={{ (() => { const v = (${single}); return Array.isArray(v) ? v[${i}] : String(v).split(',')[${i}]?.trim(); })() }}` : '');
    }
    if (!single) warn('os valores da consulta vinham de uma lista com texto e {{ }}; confira cada parâmetro');
  } else if (typeof replacement === 'string') {
    replacement.split(',').forEach((v) => values.push(v.trim()));
  }
  if (!replacement) warn('o SQL usa $1, $2... mas o n8n não informava os valores; preencha os parâmetros');
  const queryParams = Array.from({ length: count }, (_, i) => ({ name: `p${i + 1}`, value: values[i] ?? '' }));
  return { sql: converted, queryParams };
}

// ---------- ClickUp ----------

function clickUp({ params, warn }: Ctx): Converted | null {
  const resource = String(params.resource ?? 'task');
  const operation = String(params.operation ?? 'create');
  if (resource !== 'task' || operation !== 'create') return null;
  const extra = isObject(params.additionalFields) ? params.additionalFields : {};
  const assignees = Array.isArray(extra.assignees) ? extra.assignees.map(String).join(', ') : String(extra.assignees ?? '');
  warn('escolha a conexão do ClickUp');
  if (extra.customFieldsJson) warn('os campos personalizados vinham em JSON no n8n; passe-os para a lista');
  if (extra.tags || extra.status || extra.priority) warn('status, prioridade e tags do n8n não foram importados');
  return {
    type: 'clickup',
    parameters: {
      connection: '',
      list: String(params.list ?? ''),
      name: String(params.name ?? ''),
      description: String(extra.markdownContent ?? extra.content ?? ''),
      assignees,
      dueDate: String(extra.dueDate ?? ''),
      customFields: [],
    },
  };
}

// ---------- Gmail ----------

const GMAIL_OPERATIONS: Record<string, string> = {
  'message.send': 'send',
  'message.reply': 'reply',
  'message.get': 'get',
  'message.getAll': 'search',
  'message.markAsRead': 'markRead',
  'message.markAsUnread': 'markUnread',
  'message.addLabels': 'addLabels',
  'message.removeLabels': 'removeLabels',
  'message.delete': 'trash',
  'draft.create': 'createDraft',
  'draft.delete': 'deleteDraft',
  'draft.getAll': 'searchDrafts',
};

function gmail({ node, params, warn }: Ctx): Converted | null {
  if ((node.typeVersion ?? 1) < 2) return null;
  const resource = String(params.resource ?? 'message');
  const operation = GMAIL_OPERATIONS[`${resource}.${String(params.operation ?? 'send')}`];
  if (!operation) return null;
  const options = isObject(params.options) ? params.options : {};
  const filters = isObject(params.filters) ? params.filters : {};
  const text = (value: unknown) => (value === undefined || value === null ? '' : Array.isArray(value) ? value.map(String).join(', ') : String(value));
  warn('escolha a conexão do Gmail');
  if (operation === 'trash') warn('no n8n o e-mail era apagado de vez; aqui ele vai para a lixeira');
  if (isObject(options.attachmentsUi)) warn('os anexos do n8n vinham de dados binários; passe o conteúdo em base64 para a lista de anexos');
  if (operation === 'search' && (filters.readStatus || filters.sender || filters.receivedAfter || filters.receivedBefore)) {
    warn('os filtros de lido, remetente e datas do n8n não foram importados; escreva-os na busca (ex.: is:unread from:x after:2026/01/31)');
  }
  const parameters: JsonObject = {
    connection: '',
    operation,
    messageId: text(params.messageId),
    draftId: text(params.messageId ?? params.draftId),
    to: text(params.sendTo ?? options.sendTo),
    cc: text(options.ccList),
    bcc: text(options.bccList),
    subject: text(params.subject),
    bodyType: params.emailType === 'html' ? 'html' : 'text',
    body: text(params.message),
    senderName: text(options.senderName),
    replyTo: text(options.replyTo),
    attachments: [],
    replyAll: options.replyToSenderOnly === false,
    replyToMessageId: '',
    query: text(filters.q),
    labelFilter: text(filters.labelIds),
    includeSpamTrash: filters.includeSpamTrash === true,
    limit: params.returnAll === true ? 500 : Number(params.limit ?? 50),
    downloadAttachments: options.downloadAttachments === true || filters.downloadAttachments === true,
    labels: text(params.labelIds),
  };
  if (operation === 'createDraft' && options.threadId) warn('o rascunho do n8n ia para uma conversa (threadId); informe o ID de um e-mail dela em "Em resposta ao e-mail"');
  return { type: 'gmail', parameters };
}

// ---------- Expressões ----------

const SUPPORTED_VARS = new Set(['$json', '$node', '$input', '$execution', '$vars', '$itemIndex']);
const N8N_METHODS =
  /\.(isEmpty|isNotEmpty|toDateTime|toNumber|toInt|toFloat|toBoolean|extractEmail|extractDomain|extractUrl|removeTags|toTitleCase|toSentenceCase|toSnakeCase|base64Encode|base64Decode|urlEncode|urlDecode|pluck|compact|average|chunk|isEven|isOdd|toFormat|diffTo|beginningOf|endOfMonth|toJsonString|parseJson|toISO)\(/g;

/** Aponta o que as expressões e o código usam do n8n e não existe aqui. */
function incompatibleTokens(parameters: JsonObject): string[] {
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/\$[A-Za-z_]\w*/g)) if (!SUPPORTED_VARS.has(m[0])) found.add(m[0]);
    for (const m of text.matchAll(/\b(DateTime|Duration|Interval)\./g)) found.add(m[1]!);
    for (const m of text.matchAll(N8N_METHODS)) found.add(`.${m[1]}()`);
  };
  const walk = (value: JsonValue, key?: string) => {
    if (typeof value === 'string') {
      if (value.startsWith('=')) scan(value);
      else if (key === 'jsCode') scan(value);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  for (const [key, value] of Object.entries(parameters)) if (key !== 'n8nParameters') walk(value, key);
  if (!found.size) return [];
  return [`usa ${[...found].join(', ')}, que não existe aqui; ajuste a expressão ou o código`];
}

// ---------- Utilitários ----------

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name.trim() || 'Nó';
  for (let i = 2; used.has(candidate); i++) candidate = `${name} ${i}`;
  used.add(candidate);
  return candidate;
}

export function isObject(value: unknown): value is Params {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
