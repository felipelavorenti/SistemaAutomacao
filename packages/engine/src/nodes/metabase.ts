import type { ConnectionData, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { callApi } from './api.js';
import { isPlainObject } from './paths.js';

export const METABASE_CONNECTION_TYPES = ['metabase'];

export const metabase: NodeType = {
  description: {
    type: 'metabase',
    displayName: 'Metabase',
    description: 'Executa uma question do Metabase e devolve um item por linha do resultado.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: 300_000,
    properties: [
      { name: 'connection', displayName: 'Conexão', type: 'connection', default: '', required: true, connectionTypes: METABASE_CONNECTION_TYPES },
      {
        name: 'question',
        displayName: 'Question',
        type: 'string',
        default: '',
        required: true,
        placeholder: '123 ou https://metabase.empresa/question/123-vendas',
        description: 'Número da question ou o link dela no Metabase.',
      },
      {
        name: 'filters',
        displayName: 'Filtros',
        type: 'list',
        default: [],
        description: 'Nome do filtro como aparece na question (ou o nome da variável do SQL) e o valor.',
        fields: [
          { name: 'name', displayName: 'Filtro', type: 'string', default: '' },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
      },
      {
        name: 'executeOnce',
        displayName: 'Executar uma vez só',
        type: 'boolean',
        default: true,
        description: 'Desmarcado, executa a question uma vez para cada item que chegar, com os filtros de cada item.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const once = (await ctx.getParam('executeOnce', 0)) !== false;
    const count = once ? 1 : input.length;
    const output: Item[] = [];
    let session: MetabaseSession | null = null;
    for (let i = 0; i < count; i++) {
      const connectionId = String((await ctx.getParam('connection', i)) ?? '');
      if (!connectionId) throw new NodeOperationError('Escolha a conexão do Metabase');
      if (!session || session.connectionId !== connectionId) session = await openSession(await ctx.getConnection(connectionId), ctx.signal);
      const cardId = questionId(await ctx.getParam('question', i));
      const filters = filterList(await ctx.getParam('filters', i));
      const rows = await runQuestion(session, cardId, filters, ctx.signal);
      for (const row of rows) output.push({ json: row });
    }
    return [output];
  },
};

interface MetabaseSession {
  connectionId: string;
  baseUrl: string;
  headers: Record<string, string>;
}

interface CardParameter {
  id: string;
  type: string;
  target?: JsonValue;
  slug?: string;
  name?: string;
}

/** Autentica com a API key ou com usuário e senha da conexão. */
async function openSession(connection: ConnectionData, signal?: AbortSignal): Promise<MetabaseSession> {
  if (connection.type !== 'metabase') throw new NodeOperationError(`A conexão é do tipo ${connection.type}, não do Metabase`);
  const d = connection.data;
  const baseUrl = String(d.url ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new NodeOperationError('A conexão do Metabase está sem a URL');
  if (d.apiKey) return { connectionId: connection.id, baseUrl, headers: { 'x-api-key': String(d.apiKey) } };
  const login = await callApi({
    service: 'Metabase',
    method: 'POST',
    url: `${baseUrl}/api/session`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: String(d.username ?? ''), password: String(d.password ?? '') }),
    signal,
  });
  const token = isPlainObject(login) ? login.id : null;
  if (typeof token !== 'string') throw new NodeOperationError('O Metabase não devolveu a sessão no login', { body: login });
  return { connectionId: connection.id, baseUrl, headers: { 'X-Metabase-Session': token } };
}

export function questionId(value: JsonValue): number {
  const text = String(value ?? '').trim();
  const match = /^(\d+)$/.exec(text) ?? /\/(?:question|card)\/(\d+)/.exec(text);
  if (!match) throw new NodeOperationError(`Informe o número ou o link da question (recebeu "${text}")`);
  return Number(match[1]);
}

function filterList(value: JsonValue): { name: string; value: JsonValue }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .filter((f) => typeof f.name === 'string' && f.name.trim() !== '')
    .map((f) => ({ name: String(f.name).trim(), value: f.value ?? null }));
}

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Filtros da question: os parâmetros do card ou, em versões antigas, as variáveis do SQL. */
function cardParameters(card: JsonObject): CardParameter[] {
  const params = Array.isArray(card.parameters) ? card.parameters.filter(isPlainObject) : [];
  if (params.length) return params as unknown as CardParameter[];
  const query = isPlainObject(card.dataset_query) ? card.dataset_query : {};
  const native = isPlainObject(query.native) ? query.native : {};
  const tags = isPlainObject(native['template-tags']) ? native['template-tags'] : {};
  return Object.values(tags)
    .filter(isPlainObject)
    .map((tag) => ({
      id: String(tag.id ?? tag.name),
      type: tag.type === 'dimension' ? String(tag['widget-type'] ?? 'category') : tag.type === 'number' ? 'number/=' : 'category',
      target: [tag.type === 'dimension' ? 'dimension' : 'variable', ['template-tag', String(tag.name)]],
      slug: String(tag.name),
      name: String(tag['display-name'] ?? tag.name),
    }));
}

function variableName(target: JsonValue | undefined): string | null {
  // ["variable", ["template-tag", "nome"]] ou ["dimension", ["template-tag", "nome"]]
  if (!Array.isArray(target) || !Array.isArray(target[1]) || target[1][0] !== 'template-tag') return null;
  return typeof target[1][1] === 'string' ? target[1][1] : null;
}

/** Converte o valor para o formato que o Metabase espera para o tipo do filtro. */
function parameterValue(type: string, value: JsonValue): JsonValue {
  const list = Array.isArray(value) ? value : [value];
  const typed = type.startsWith('number') ? list.map((v) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v)) : list;
  if (/^(string|number)\//.test(type) || type === 'id' || Array.isArray(value)) return typed;
  return typed[0] ?? null;
}

async function runQuestion(session: MetabaseSession, cardId: number, filters: { name: string; value: JsonValue }[], signal?: AbortSignal): Promise<JsonObject[]> {
  const base = `${session.baseUrl}/api/card/${cardId}`;
  const parameters: JsonObject[] = [];
  if (filters.length) {
    const card = await callApi({ service: 'Metabase', method: 'GET', url: base, headers: session.headers, signal });
    const available = cardParameters(isPlainObject(card) ? card : {});
    for (const filter of filters) {
      const wanted = normalize(filter.name);
      const param = available.find((p) => [p.slug, p.name, variableName(p.target)].some((n) => n && normalize(n) === wanted));
      if (!param) {
        const names = available.map((p) => p.name ?? p.slug).filter(Boolean);
        throw new NodeOperationError(
          `A question ${cardId} não tem o filtro "${filter.name}"${names.length ? `. Filtros disponíveis: ${names.join(', ')}` : ', e não tem filtros'}`,
        );
      }
      if (filter.value === null || filter.value === '') continue;
      parameters.push({ id: param.id, type: param.type, target: param.target ?? null, value: parameterValue(param.type, filter.value) });
    }
  }
  const body = new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: 'false' });
  const result = await callApi({
    service: 'Metabase',
    method: 'POST',
    url: `${base}/query/json`,
    headers: { ...session.headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  if (Array.isArray(result)) return result.filter(isPlainObject);
  // Quando a consulta falha, o Metabase responde 200/202 com o erro no corpo.
  const error = isPlainObject(result) ? (result.error ?? result.message) : result;
  throw new NodeOperationError(`A question ${cardId} falhou no Metabase: ${typeof error === 'string' ? error : JSON.stringify(error)}`, {
    body: result,
    request: { method: 'POST', url: `${base}/query/json` },
  });
}

/** Testa a conexão buscando o usuário logado. */
export async function testMetabaseConnection(connection: ConnectionData): Promise<void> {
  const session = await openSession(connection);
  await callApi({ service: 'Metabase', method: 'GET', url: `${session.baseUrl}/api/user/current`, headers: session.headers });
}

