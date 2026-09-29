import { coerceVariable, endpointVariables, fillJsonTemplate, fillTemplate, TemplateError, type ApiEndpointData } from '../catalog.js';
import type { NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';

export const HTTP_CONNECTION_TYPES = ['httpHeaderAuth', 'httpBearerAuth', 'httpBasicAuth'];

const nameValueFields = [
  { name: 'name', displayName: 'Nome', type: 'string' as const, default: '' },
  { name: 'value', displayName: 'Valor', type: 'string' as const, default: '' },
];

export const httpRequest: NodeType = {
  description: {
    type: 'httpRequest',
    displayName: 'HTTP Request',
    description: 'Chama uma API REST e devolve a resposta como itens.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'source',
        displayName: 'Requisição',
        type: 'options',
        default: 'manual',
        options: [
          { name: 'Montar aqui (URL livre)', value: 'manual' },
          { name: 'API cadastrada (catálogo do ERP)', value: 'catalog' },
        ],
      },
      { name: 'erpClient', displayName: 'Cliente no ERP', type: 'erpClient', default: '', required: true, showWhen: { source: ['catalog'] } },
      { name: 'endpoint', displayName: 'Endpoint', type: 'erpEndpoint', default: '', required: true, showWhen: { source: ['catalog'] } },
      {
        name: 'variables',
        displayName: 'Variáveis',
        type: 'erpVariables',
        default: {},
        showWhen: { source: ['catalog'] },
        description: 'Host, porta e credenciais vêm do cadastro do cliente no ERP.',
      },
      {
        name: 'method',
        displayName: 'Método',
        type: 'options',
        default: 'GET',
        showWhen: { source: ['manual'] },
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })),
      },
      { name: 'url', displayName: 'URL', type: 'string', default: '', required: true, placeholder: 'https://api.exemplo.com/recurso', showWhen: { source: ['manual'] } },
      {
        name: 'connection',
        displayName: 'Autenticação (conexão)',
        type: 'connection',
        default: '',
        connectionTypes: HTTP_CONNECTION_TYPES,
        description: 'Conexão cadastrada com a API key, o token ou o usuário e senha.',
        showWhen: { source: ['manual'] },
      },
      { name: 'queryParameters', displayName: 'Parâmetros de query', type: 'list', default: [], fields: nameValueFields, showWhen: { source: ['manual'] } },
      { name: 'headers', displayName: 'Headers', type: 'list', default: [], fields: nameValueFields, showWhen: { source: ['manual'] } },
      {
        name: 'bodyType',
        displayName: 'Tipo do corpo',
        type: 'options',
        default: 'none',
        showWhen: { source: ['manual'] },
        options: [
          { name: 'Sem corpo', value: 'none' },
          { name: 'JSON', value: 'json' },
          { name: 'Formulário (x-www-form-urlencoded)', value: 'form' },
          { name: 'Texto', value: 'text' },
        ],
      },
      { name: 'jsonBody', displayName: 'Corpo JSON', type: 'json', default: '{}', showWhen: { source: ['manual'], bodyType: ['json'] } },
      {
        name: 'formBody',
        displayName: 'Campos do formulário',
        type: 'list',
        default: [],
        fields: nameValueFields,
        showWhen: { source: ['manual'], bodyType: ['form'] },
      },
      { name: 'textBody', displayName: 'Corpo', type: 'string', default: '', showWhen: { source: ['manual'], bodyType: ['text'] } },
      {
        name: 'fullResponse',
        displayName: 'Incluir status e headers da resposta',
        type: 'boolean',
        default: false,
      },
      {
        name: 'failOnHttpError',
        displayName: 'Falhar quando o status for de erro (4xx ou 5xx)',
        type: 'boolean',
        default: true,
      },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const output: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      output.push(...(await requestForItem(ctx, i)));
    }
    return [output];
  },
};

interface PreparedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
  /** Para o log de erro: de qual endpoint do catálogo veio a chamada. */
  catalog?: { erp: string; endpoint: string; client: string };
}

async function requestForItem(ctx: NodeExecuteContext, i: number): Promise<Item[]> {
  const prepared = (await ctx.getParam('source', i)) === 'catalog' ? await prepareCatalog(ctx, i) : await prepareManual(ctx, i);
  const { method, url, headers, body } = prepared;
  const requestInfo: JsonObject = { method, url: redactUrl(url) };
  if (prepared.catalog) requestInfo.api = prepared.catalog;

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: ctx.signal });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new NodeOperationError(`Falha ao chamar ${method} ${url.origin}${url.pathname}: ${cause}`, { request: requestInfo });
  }

  const responseBody = await readBody(response);
  const responseHeaders: JsonObject = Object.fromEntries(response.headers.entries());

  if (!response.ok && (await ctx.getParam('failOnHttpError', i)) !== false) {
    throw new NodeOperationError(`A API respondeu com status ${response.status} ${response.statusText}`.trim(), {
      statusCode: response.status,
      statusText: response.statusText,
      body: responseBody,
      headers: responseHeaders,
      request: requestInfo,
    });
  }

  if (await ctx.getParam('fullResponse', i)) {
    return [{ json: { statusCode: response.status, headers: responseHeaders, body: responseBody } }];
  }
  return toItems(responseBody);
}

async function prepareManual(ctx: NodeExecuteContext, i: number): Promise<PreparedRequest> {
  const method = String(await ctx.getParam('method', i));
  const rawUrl = String((await ctx.getParam('url', i)) ?? '').trim();
  if (!rawUrl) throw new NodeOperationError('Informe a URL da requisição');
  const url = parseUrl(rawUrl);

  const headers = new Headers();
  for (const { name, value } of pairs(await ctx.getParam('queryParameters', i))) url.searchParams.append(name, value);
  for (const { name, value } of pairs(await ctx.getParam('headers', i))) headers.set(name, value);

  const connectionId = await ctx.getParam('connection', i);
  if (typeof connectionId === 'string' && connectionId) {
    await applyAuth(ctx, connectionId, headers);
  }

  let body: string | undefined;
  const bodyType = await ctx.getParam('bodyType', i);
  if (bodyType === 'json') {
    const raw = await ctx.getParam('jsonBody', i);
    body = typeof raw === 'string' ? normalizeJson(raw) : JSON.stringify(raw);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (bodyType === 'form') {
    const form = new URLSearchParams();
    for (const { name, value } of pairs(await ctx.getParam('formBody', i))) form.append(name, value);
    body = form.toString();
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
  } else if (bodyType === 'text') {
    body = String((await ctx.getParam('textBody', i)) ?? '');
  }
  return { method, url, headers, body };
}

/** Monta a requisição a partir do endpoint cadastrado e do cadastro do cliente no ERP. */
async function prepareCatalog(ctx: NodeExecuteContext, i: number): Promise<PreparedRequest> {
  const erpClientId = String((await ctx.getParam('erpClient', i)) ?? '');
  const endpointId = String((await ctx.getParam('endpoint', i)) ?? '');
  if (!erpClientId) throw new NodeOperationError('Escolha o cliente no ERP');
  if (!endpointId) throw new NodeOperationError('Escolha o endpoint');
  const api: ApiEndpointData = await ctx.getApiEndpoint(erpClientId, endpointId);
  const given = await ctx.getParam('variables', i);
  const provided = given !== null && typeof given === 'object' && !Array.isArray(given) ? given : {};

  try {
    const vars: Record<string, JsonValue | undefined> = { ...api.clientValues };
    for (const variable of endpointVariables(api)) vars[variable.name] = coerceVariable(variable, provided[variable.name]);

    const url = parseUrl(fillTemplate(api.baseUrl.replace(/\/+$/, ''), vars) + fillTemplate(api.path.startsWith('/') ? api.path : `/${api.path}`, vars, encodeURIComponent));
    for (const { name, value } of api.query) if (name) url.searchParams.append(fillTemplate(name, vars), fillTemplate(value, vars));
    const headers = new Headers();
    for (const { name, value } of api.headers) if (name) headers.set(fillTemplate(name, vars), fillTemplate(value, vars));

    if (api.usesAuth) {
      if (api.authType === 'bearer') headers.set('authorization', `Bearer ${String(vars.token ?? '')}`);
      else if (api.authType === 'header' && api.authHeader) headers.set(api.authHeader, String(vars.token ?? ''));
      else if (api.authType === 'basic') {
        const user = String(api.clientValues.usuario ?? '');
        const password = String(api.clientValues.senha ?? '');
        headers.set('authorization', `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`);
      }
    }

    let body: string | undefined;
    if (api.bodyType === 'json' && api.body.trim()) {
      body = JSON.stringify(fillJsonTemplate(api.body, vars));
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else if (api.bodyType === 'form' && api.body.trim()) {
      body = fillTemplate(api.body, vars, encodeURIComponent);
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    } else if (api.bodyType === 'text') {
      body = fillTemplate(api.body, vars);
    }
    return { method: api.method, url, headers, body, catalog: { erp: api.erpName, endpoint: api.endpointName, client: api.clientName } };
  } catch (err) {
    if (err instanceof TemplateError) throw new NodeOperationError(`${api.erpName} · ${api.endpointName}: ${err.message}`);
    throw err;
  }
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new NodeOperationError(`URL inválida: ${raw}`);
  }
}

async function applyAuth(ctx: NodeExecuteContext, connectionId: string, headers: Headers): Promise<void> {
  const connection = await ctx.getConnection(connectionId);
  const d = connection.data;
  switch (connection.type) {
    case 'httpHeaderAuth':
      headers.set(String(d.name), String(d.value));
      break;
    case 'httpBearerAuth':
      headers.set('authorization', `Bearer ${String(d.token)}`);
      break;
    case 'httpBasicAuth':
      headers.set('authorization', `Basic ${Buffer.from(`${String(d.user)}:${String(d.password)}`).toString('base64')}`);
      break;
    default:
      throw new NodeOperationError(`A conexão "${connectionId}" é do tipo ${connection.type}, que não serve para HTTP`);
  }
}

function pairs(value: JsonValue): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v))
    .filter((v) => typeof v.name === 'string' && v.name !== '')
    .map((v) => ({ name: String(v.name), value: v.value === null || v.value === undefined ? '' : String(v.value) }));
}

function normalizeJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    throw new NodeOperationError('O corpo JSON não é um JSON válido', { body: raw });
  }
}

async function readBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (!text) return null;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

/** Arrays de objetos viram um item por elemento, como no n8n. Resposta vazia não gera item: o fluxo para ali, sem erro. */
function toItems(body: JsonValue): Item[] {
  if (body === null || (typeof body === 'string' && !body.trim())) return [];
  if (Array.isArray(body)) {
    return body.map((el) => ({ json: el !== null && typeof el === 'object' && !Array.isArray(el) ? el : { data: el } }));
  }
  if (body !== null && typeof body === 'object') return [{ json: body }];
  return [{ json: { data: body } }];
}

function redactUrl(url: URL): string {
  const copy = new URL(url);
  if (copy.password) copy.password = '***';
  return copy.toString();
}
