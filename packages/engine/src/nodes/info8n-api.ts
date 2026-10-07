import type { ConnectionData, NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { callApi } from './api.js';
import { isPlainObject } from './paths.js';
import { bool, num, str } from './values.js';

/**
 * Info8n (API): lista, cria, altera, ativa e executa fluxos e lê execuções pela API REST do próprio
 * Info8n, como o nó "n8n" faz com a API do n8n. Usa um token de API (Minha conta > Tokens de API):
 * o nó enxerga e faz o mesmo que o usuário dono do token.
 */

export const INFO8N_CONNECTION_TYPES = ['info8nApi'];

type Resource = 'workflow' | 'execution' | 'connection';

const RESOURCES = [
  { name: 'Fluxo', value: 'workflow' },
  { name: 'Execução', value: 'execution' },
  { name: 'Conexão', value: 'connection' },
];

const OPERATIONS = [
  { name: 'Listar', value: 'getAll', showWhen: { resource: ['workflow', 'execution', 'connection'] } },
  { name: 'Buscar', value: 'get', showWhen: { resource: ['workflow', 'execution'] } },
  { name: 'Criar', value: 'create', showWhen: { resource: ['workflow', 'connection'] } },
  { name: 'Alterar', value: 'update', showWhen: { resource: ['workflow'] } },
  { name: 'Excluir', value: 'delete', showWhen: { resource: ['workflow', 'connection'] } },
  { name: 'Ativar', value: 'activate', showWhen: { resource: ['workflow'] } },
  { name: 'Desativar', value: 'deactivate', showWhen: { resource: ['workflow'] } },
  { name: 'Executar', value: 'run', showWhen: { resource: ['workflow'] } },
  { name: 'Executar de novo', value: 'retry', showWhen: { resource: ['execution'] } },
  { name: 'Cancelar', value: 'cancel', showWhen: { resource: ['execution'] } },
  { name: 'Tipos de conexão', value: 'getSchema', showWhen: { resource: ['connection'] } },
];

/** Operações de cada recurso. */
const ALLOWED: Record<Resource, string[]> = {
  workflow: ['getAll', 'get', 'create', 'update', 'delete', 'activate', 'deactivate', 'run'],
  execution: ['getAll', 'get', 'retry', 'cancel'],
  connection: ['getAll', 'create', 'delete', 'getSchema'],
};

const show = (resource: Resource[], operation: string[]) => ({ resource, operation });

function parseJsonParam(value: JsonValue, what: string): JsonObject {
  if (isPlainObject(value)) return value as JsonObject;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as JsonValue;
      if (isPlainObject(parsed)) return parsed as JsonObject;
    } catch {
      // cai no erro abaixo
    }
  }
  throw new NodeOperationError(`${what} precisa ser um objeto JSON`);
}

async function api(ctx: NodeExecuteContext, connection: ConnectionData, method: string, route: string, body?: JsonValue, query?: Record<string, string | undefined>): Promise<JsonValue> {
  const base = (str(connection.data.baseUrl).trim() || ctx.publicUrl).replace(/\/+$/, '').replace(/\/api$/, '');
  const url = new URL(`${base}/api${route}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  return callApi({
    service: 'Info8n',
    method,
    url: url.toString(),
    headers: { Authorization: `Bearer ${str(connection.data.apiKey)}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ctx.signal,
  });
}

const asItems = (value: JsonValue): Item[] =>
  Array.isArray(value) ? value.map((v) => ({ json: isPlainObject(v) ? (v as JsonObject) : { value: v } })) : [{ json: isPlainObject(value) ? (value as JsonObject) : { value } }];

async function runOne(ctx: NodeExecuteContext, i: number, connection: ConnectionData): Promise<Item[]> {
  const resource = str(await ctx.getParam('resource', i), 'workflow') as Resource;
  const operation = str(await ctx.getParam('operation', i), 'getAll');
  if (!ALLOWED[resource]?.includes(operation)) throw new NodeOperationError(`O recurso "${resource}" não tem a operação "${operation}"`);
  const id = async (name: string, what: string) => {
    const value = str(await ctx.getParam(name, i)).trim();
    if (!value) throw new NodeOperationError(`Informe o ID ${what}`);
    return encodeURIComponent(value);
  };
  const limitOf = async (): Promise<number | undefined> => (bool(await ctx.getParam('returnAll', i)) ? undefined : Math.max(1, Math.trunc(num(await ctx.getParam('limit', i), 100))));

  if (resource === 'workflow') {
    switch (operation) {
      case 'getAll': {
        const activeOnly = bool(await ctx.getParam('activeWorkflows', i));
        const name = str(await ctx.getParam('nameFilter', i)).trim().toLowerCase();
        let list = (await api(ctx, connection, 'GET', '/workflows')) as JsonObject[];
        if (activeOnly) list = list.filter((w) => w.active === true);
        if (name) list = list.filter((w) => String(w.name ?? '').toLowerCase().includes(name));
        const limit = await limitOf();
        return asItems(limit ? list.slice(0, limit) : list);
      }
      case 'get':
        return asItems(await api(ctx, connection, 'GET', `/workflows/${await id('workflowId', 'do fluxo')}`));
      case 'create':
        return asItems(await api(ctx, connection, 'POST', '/workflows', parseJsonParam(await ctx.getParam('workflowObject', i), 'O fluxo')));
      case 'update': {
        const wfId = await id('workflowId', 'do fluxo');
        const body = parseJsonParam(await ctx.getParam('workflowObject', i), 'O fluxo');
        // Campos que faltarem ficam como estão (o PUT da API exige nome, pasta e definição).
        const current = (await api(ctx, connection, 'GET', `/workflows/${wfId}`)) as JsonObject;
        const merged: JsonObject = {
          name: body.name ?? current.name ?? null,
          folderId: body.folderId ?? current.folder_id ?? null,
          definition: body.definition ?? current.definition ?? null,
        };
        return asItems(await api(ctx, connection, 'PUT', `/workflows/${wfId}`, merged));
      }
      case 'delete': {
        const wfId = await id('workflowId', 'do fluxo');
        await api(ctx, connection, 'DELETE', `/workflows/${wfId}`);
        return [{ json: { success: true, id: decodeURIComponent(wfId) } }];
      }
      case 'activate':
      case 'deactivate':
        return asItems(await api(ctx, connection, 'POST', `/workflows/${await id('workflowId', 'do fluxo')}/${operation}`, {}));
      case 'run': {
        const raw = await ctx.getParam('runInput', i);
        let input: JsonValue | undefined = raw;
        if (raw === '' || raw === null) input = undefined;
        else if (typeof raw === 'string') {
          try {
            input = JSON.parse(raw) as JsonValue;
          } catch {
            throw new NodeOperationError('Os itens de entrada precisam ser JSON (uma lista de objetos)');
          }
        }
        const items = input === undefined ? undefined : (Array.isArray(input) ? input : [input]).map((v) => (isPlainObject(v) && isPlainObject((v as JsonObject).json) ? v : { json: v }));
        return asItems(await api(ctx, connection, 'POST', `/workflows/${await id('workflowId', 'do fluxo')}/run`, items ? { input: items } : {}));
      }
    }
  }

  if (resource === 'execution') {
    switch (operation) {
      case 'getAll': {
        const limit = await limitOf();
        const query = {
          workflowId: str(await ctx.getParam('workflowFilter', i)).trim() || undefined,
          status: str(await ctx.getParam('statusFilter', i)) || undefined,
          limit: String(Math.min(limit ?? 200, 200)),
        };
        const out: JsonObject[] = [];
        // Sem limite: pagina pela data até acabar.
        for (;;) {
          const page = (await api(ctx, connection, 'GET', '/executions', undefined, { ...query, before: out.length ? String(out[out.length - 1]!.created_at) : undefined })) as JsonObject[];
          out.push(...page);
          if (limit !== undefined || page.length < 200 || out.length >= 100_000) break;
        }
        return asItems(limit ? out.slice(0, limit) : out);
      }
      case 'get':
        return asItems(await api(ctx, connection, 'GET', `/executions/${await id('executionId', 'da execução')}`));
      case 'retry':
      case 'cancel':
        return asItems(await api(ctx, connection, 'POST', `/executions/${await id('executionId', 'da execução')}/${operation}`, {}));
    }
  }

  switch (operation) {
    case 'getAll':
      return asItems(await api(ctx, connection, 'GET', '/connections'));
    case 'getSchema': {
      const type = str(await ctx.getParam('connectionType', i)).trim();
      const types = (await api(ctx, connection, 'GET', '/connection-types')) as JsonObject[];
      const found = type ? types.filter((t) => t.type === type) : types;
      if (type && !found.length) throw new NodeOperationError(`O tipo de conexão "${type}" não existe`);
      return asItems(found);
    }
    case 'create': {
      const body: JsonObject = {
        name: str(await ctx.getParam('name', i)),
        type: str(await ctx.getParam('connectionType', i)),
        clientId: str(await ctx.getParam('clientId', i)).trim() || null,
        data: parseJsonParam(await ctx.getParam('data', i), 'Os dados da conexão'),
      };
      return asItems(await api(ctx, connection, 'POST', '/connections', body));
    }
    default: {
      const connId = await id('connectionId', 'da conexão');
      await api(ctx, connection, 'DELETE', `/connections/${connId}`);
      return [{ json: { success: true, id: decodeURIComponent(connId) } }];
    }
  }
}

export const info8nApi: NodeType = {
  description: {
    type: 'info8n',
    displayName: 'Info8n (API)',
    description: 'Lista, cria, altera, ativa e executa fluxos, lê execuções e cria conexões pela API do Info8n, com um token de API.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'connection', displayName: 'Conexão (token da API)', type: 'connection', default: '', required: true, connectionTypes: INFO8N_CONNECTION_TYPES },
      { name: 'resource', displayName: 'Recurso', type: 'options', default: 'workflow', options: RESOURCES },
      { name: 'operation', displayName: 'Operação', type: 'options', default: 'getAll', options: OPERATIONS, description: 'Fluxo: Listar a Executar. Execução: Listar, Buscar, Executar de novo e Cancelar. Conexão: Listar, Criar, Excluir e Tipos de conexão.' },
      { name: 'workflowId', displayName: 'ID do fluxo', type: 'string', default: '', required: true, showWhen: show(['workflow'], ['get', 'update', 'delete', 'activate', 'deactivate', 'run']) },
      {
        name: 'workflowObject',
        displayName: 'Fluxo (JSON)',
        type: 'json',
        default: '{\n  "name": "Novo fluxo",\n  "folderId": "",\n  "definition": { "nodes": [], "connections": [] }\n}',
        description: 'Como no corpo de POST /api/workflows. No Alterar, os campos que faltarem ficam como estão.',
        showWhen: show(['workflow'], ['create', 'update']),
      },
      { name: 'runInput', displayName: 'Itens de entrada (JSON)', type: 'json', default: '', description: 'Opcional: lista de objetos que entram no gatilho manual do fluxo.', showWhen: show(['workflow'], ['run']) },
      { name: 'activeWorkflows', displayName: 'Só os ativos', type: 'boolean', default: false, showWhen: show(['workflow'], ['getAll']) },
      { name: 'nameFilter', displayName: 'Nome contém', type: 'string', default: '', showWhen: show(['workflow'], ['getAll']) },
      { name: 'executionId', displayName: 'ID da execução', type: 'string', default: '', required: true, showWhen: show(['execution'], ['get', 'retry', 'cancel']) },
      { name: 'workflowFilter', displayName: 'Do fluxo (ID)', type: 'string', default: '', showWhen: show(['execution'], ['getAll']) },
      {
        name: 'statusFilter',
        displayName: 'Situação',
        type: 'options',
        default: '',
        options: [
          { name: 'Todas', value: '' },
          { name: 'Sucesso', value: 'success' },
          { name: 'Erro', value: 'error' },
          { name: 'Rodando', value: 'running' },
          { name: 'Na fila', value: 'queued' },
          { name: 'Esperando', value: 'waiting' },
          { name: 'Cancelada', value: 'canceled' },
        ],
        showWhen: show(['execution'], ['getAll']),
      },
      { name: 'returnAll', displayName: 'Trazer todos', type: 'boolean', default: false, showWhen: show(['workflow', 'execution'], ['getAll']) },
      { name: 'limit', displayName: 'Quantidade', type: 'number', default: 100, showWhen: { resource: ['workflow', 'execution'], operation: ['getAll'], returnAll: [false] } },
      { name: 'name', displayName: 'Nome da conexão', type: 'string', default: '', required: true, showWhen: show(['connection'], ['create']) },
      { name: 'connectionType', displayName: 'Tipo de conexão', type: 'string', default: '', placeholder: 'postgres', showWhen: show(['connection'], ['create', 'getSchema']) },
      { name: 'clientId', displayName: 'Cliente (ID)', type: 'string', default: '', description: 'Opcional.', showWhen: show(['connection'], ['create']) },
      { name: 'data', displayName: 'Dados (JSON)', type: 'json', default: '{}', description: 'Campos do tipo de conexão (veja a operação Tipos de conexão).', showWhen: show(['connection'], ['create']) },
      { name: 'connectionId', displayName: 'ID da conexão', type: 'string', default: '', required: true, showWhen: show(['connection'], ['delete']) },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const id = str(await ctx.getParam('connection', i));
      if (!id) throw new NodeOperationError('Escolha a conexão com o token da API');
      const connection = await ctx.getConnection(id);
      if (!INFO8N_CONNECTION_TYPES.includes(connection.type)) throw new NodeOperationError('A conexão escolhida não é do tipo "API do Info8n"');
      out.push(...(await runOne(ctx, i, connection)));
    }
    return [out];
  },
};
