import { coerceVariable, endpointVariables, fillJsonTemplate, fillTemplate, TemplateError, type ApiEndpointData } from '../catalog.js';
import type { NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue } from '../types.js';
import { getBinary, mimeTypeFromFileName, toBinary } from '../binary.js';

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
          { name: 'Formulário multipart (form-data, aceita arquivos)', value: 'multipart' },
          { name: 'Arquivo (binário)', value: 'binary' },
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
        name: 'multipartBody',
        displayName: 'Campos do formulário',
        type: 'list',
        default: [],
        description: 'Cada linha é um campo de texto ou um arquivo do item. No arquivo, o valor é o nome do arquivo no item (ex.: data).',
        fields: [
          {
            name: 'parameterType',
            displayName: 'Tipo',
            type: 'options',
            default: 'formData',
            options: [
              { name: 'Texto', value: 'formData' },
              { name: 'Arquivo do item', value: 'formBinaryData' },
            ],
          },
          { name: 'name', displayName: 'Nome', type: 'string', default: '' },
          { name: 'value', displayName: 'Valor (ou nome do arquivo no item)', type: 'string', default: '' },
        ],
        showWhen: { source: ['manual'], bodyType: ['multipart'] },
      },
      {
        name: 'inputDataFieldName',
        displayName: 'Arquivo do item',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Nome do arquivo no item que vai como corpo da requisição (ex.: data). O Content-Type vem do arquivo, a menos que um header o defina.',
        showWhen: { source: ['manual'], bodyType: ['binary'] },
      },
      {
        name: 'responseFormat',
        displayName: 'Formato da resposta',
        type: 'options',
        default: 'autodetect',
        options: [
          { name: 'Automático (pelo Content-Type)', value: 'autodetect' },
          { name: 'JSON', value: 'json' },
          { name: 'Texto', value: 'text' },
          { name: 'Arquivo', value: 'file' },
        ],
        description: 'No automático, JSON vira itens, texto vai para um campo e PDF, imagem, zip e outros tipos binários viram arquivo do item.',
      },
      {
        name: 'outputPropertyName',
        displayName: 'Propriedade de saída',
        type: 'string',
        default: 'data',
        description: 'Onde fica o arquivo (ou o texto) da resposta no item.',
        showWhen: { responseFormat: ['autodetect', 'text', 'file'] },
      },
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
  body?: string | Uint8Array<ArrayBuffer> | FormData;
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

  const raw = Buffer.from(await response.arrayBuffer());
  const responseHeaders: JsonObject = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok && (await ctx.getParam('failOnHttpError', i)) !== false) {
    throw new NodeOperationError(`A API respondeu com status ${response.status} ${response.statusText}`.trim(), {
      statusCode: response.status,
      statusText: response.statusText,
      body: isBinaryContentType(contentType) ? `(arquivo de ${raw.length} bytes, ${contentType})` : parseBody(raw.toString('utf8'), contentType),
      headers: responseHeaders,
      request: requestInfo,
    });
  }

  const format = String((await ctx.getParam('responseFormat', i)) || 'autodetect');
  const property = String((await ctx.getParam('outputPropertyName', i)) ?? '').trim() || 'data';
  const full = Boolean(await ctx.getParam('fullResponse', i));
  const head = { statusCode: response.status, headers: responseHeaders };

  // Arquivo: pedido no formato ou, no automático, quando o Content-Type não é texto nem JSON.
  if (format === 'file' || (format === 'autodetect' && raw.length > 0 && isBinaryContentType(contentType))) {
    const binary = responseFile(raw, response, url);
    return [{ json: full ? head : {}, binary: { [property]: binary } }];
  }

  const text = raw.toString('utf8');
  if (format === 'text') {
    if (full) return [{ json: { ...head, body: text } }];
    return text ? [{ json: { [property]: text } }] : [];
  }
  let responseBody: JsonValue;
  if (format === 'json') {
    try {
      responseBody = text.trim() ? (JSON.parse(text) as JsonValue) : null;
    } catch {
      throw new NodeOperationError('A resposta não é um JSON válido. Mude o formato da resposta para Texto ou Automático.', { body: text.slice(0, 2000), request: requestInfo });
    }
  } else responseBody = text ? parseBody(text, contentType) : null;

  if (full) return [{ json: { ...head, body: responseBody } }];
  return toItems(responseBody, property);
}

/**
 * Conteúdo que não é texto: o automático devolve como arquivo. Texto, JSON, XML, JavaScript,
 * CSV, YAML e formulário continuam texto; sem Content-Type, também.
 */
export function isBinaryContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (!type) return false;
  if (type.startsWith('text/')) return false;
  if (/json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|csv|graphql/.test(type)) return false;
  return true;
}

/** Monta o arquivo da resposta: nome do Content-Disposition ou do fim da URL, tipo do Content-Type. */
function responseFile(raw: Buffer, response: Response, requestUrl: URL): BinaryData {
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const fileName = fileNameFromDisposition(response.headers.get('content-disposition')) ?? fileNameFromUrl(response.url || requestUrl.toString());
  return toBinary(raw, { fileName, mimeType: contentType || mimeTypeFromFileName(fileName) || 'application/octet-stream' });
}

export function fileNameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2]!.trim().replace(/^"|"$/g, '')) || undefined;
    } catch {
      /* cai no filename simples */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
  return name ? name.replace(/^.*[\\/]/, '') : undefined;
}

function fileNameFromUrl(raw: string): string | undefined {
  try {
    const last = new URL(raw).pathname.split('/').pop() ?? '';
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
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

  let body: PreparedRequest['body'];
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
  } else if (bodyType === 'binary') {
    const item = ctx.inputs[0]?.[i] ?? { json: {} };
    const property = String((await ctx.getParam('inputDataFieldName', i)) ?? '').trim() || 'data';
    const file = getBinary(item, property, i);
    body = Buffer.from(file.data, 'base64');
    if (!headers.has('content-type')) headers.set('content-type', file.mimeType || 'application/octet-stream');
  } else if (bodyType === 'multipart') {
    const item = ctx.inputs[0]?.[i] ?? { json: {} };
    const form = new FormData();
    for (const row of rows(await ctx.getParam('multipartBody', i))) {
      const name = row.name === undefined || row.name === null ? '' : String(row.name);
      if (!name) continue;
      const value = row.value === undefined || row.value === null ? '' : String(row.value);
      if (row.parameterType === 'formBinaryData') {
        const file = getBinary(item, value.trim() || 'data', i);
        const blob = new Blob([Buffer.from(file.data, 'base64')], { type: file.mimeType || 'application/octet-stream' });
        form.append(name, blob, file.fileName || name);
      } else form.append(name, value);
    }
    body = form;
    // O fetch põe o Content-Type com o boundary; um multipart informado à mão ficaria sem ele.
    if (/multipart\/form-data/i.test(headers.get('content-type') ?? '')) headers.delete('content-type');
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

function rows(value: JsonValue): JsonObject[] {
  return Array.isArray(value) ? value.filter((v): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v)) : [];
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

function parseBody(text: string, type: string): JsonValue {
  if (!text) return null;
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
function toItems(body: JsonValue, property = 'data'): Item[] {
  if (body === null || (typeof body === 'string' && !body.trim())) return [];
  if (Array.isArray(body)) {
    return body.map((el) => ({ json: el !== null && typeof el === 'object' && !Array.isArray(el) ? el : { [property]: el } }));
  }
  if (body !== null && typeof body === 'object') return [{ json: body }];
  return [{ json: { [property]: body } }];
}

function redactUrl(url: URL): string {
  const copy = new URL(url);
  if (copy.password) copy.password = '***';
  return copy.toString();
}
