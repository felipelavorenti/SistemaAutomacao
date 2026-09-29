import type { ConnectionData, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { callApi } from './api.js';
import { isPlainObject } from './paths.js';

export const CLICKUP_CONNECTION_TYPES = ['clickup'];
export const CLICKUP_API = 'https://api.clickup.com/api/v2';

export const clickup: NodeType = {
  description: {
    type: 'clickup',
    displayName: 'ClickUp',
    description: 'Cria uma tarefa no ClickUp para cada item que chegar e devolve a tarefa criada.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'connection', displayName: 'Conexão', type: 'connection', default: '', required: true, connectionTypes: CLICKUP_CONNECTION_TYPES },
      {
        name: 'list',
        displayName: 'Lista',
        type: 'string',
        default: '',
        required: true,
        placeholder: '901234567 ou o link da lista',
        description: 'ID da lista ou o link dela no ClickUp.',
      },
      { name: 'name', displayName: 'Nome da tarefa', type: 'string', default: '', required: true },
      { name: 'description', displayName: 'Descrição', type: 'string', default: '', multiline: true, description: 'Aceita Markdown.' },
      {
        name: 'assignees',
        displayName: 'Responsáveis',
        type: 'string',
        default: '',
        placeholder: 'ana@empresa.com, 1234567',
        description: 'E-mails ou IDs de usuário do ClickUp, separados por vírgula.',
      },
      {
        name: 'dueDate',
        displayName: 'Prazo',
        type: 'string',
        default: '',
        placeholder: '31/12/2026 18:00',
        description: 'dd/mm/aaaa, dd/mm/aaaa hh:mm ou data ISO. Sem fuso, vale o horário do servidor.',
      },
      {
        name: 'customFields',
        displayName: 'Campos personalizados',
        type: 'list',
        default: [],
        description: 'ID do campo no ClickUp e o valor. Números, listas e objetos podem ir em JSON.',
        fields: [
          { name: 'id', displayName: 'ID do campo', type: 'string', default: '' },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const output: Item[] = [];
    const members = new Map<string, Promise<Map<string, number>>>();
    for (let i = 0; i < input.length; i++) {
      const connectionId = String((await ctx.getParam('connection', i)) ?? '');
      if (!connectionId) throw new NodeOperationError('Escolha a conexão do ClickUp');
      const token = clickupToken(await ctx.getConnection(connectionId));
      const listId = listFrom(await ctx.getParam('list', i));
      const name = String((await ctx.getParam('name', i)) ?? '').trim();
      if (!name) throw new NodeOperationError('Informe o nome da tarefa', { item: i });

      const body: JsonObject = { name };
      const description = String((await ctx.getParam('description', i)) ?? '');
      if (description.trim()) body.markdown_content = description;

      const assignees = splitList(await ctx.getParam('assignees', i));
      if (assignees.length) {
        const emails = assignees.filter((a) => a.includes('@'));
        let byEmail = new Map<string, number>();
        if (emails.length) {
          if (!members.has(connectionId)) members.set(connectionId, teamMembers(token, ctx.signal));
          byEmail = await members.get(connectionId)!;
        }
        body.assignees = assignees.map((a) => {
          if (/^\d+$/.test(a)) return Number(a);
          const id = byEmail.get(a.toLowerCase());
          if (id === undefined) throw new NodeOperationError(`Nenhum usuário do ClickUp com o e-mail ${a}`);
          return id;
        });
      }

      const due = await ctx.getParam('dueDate', i);
      if (due !== null && due !== '') {
        const { ms, hasTime } = parseDue(due);
        body.due_date = ms;
        body.due_date_time = hasTime;
      }

      const fields = customFields(await ctx.getParam('customFields', i));
      if (fields.length) body.custom_fields = fields;

      const task = await callApi({
        service: 'ClickUp',
        method: 'POST',
        url: `${CLICKUP_API}/list/${encodeURIComponent(listId)}/task`,
        headers: { authorization: token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      output.push({ json: isPlainObject(task) ? task : { resposta: task } });
    }
    return [output];
  },
};

function clickupToken(connection: ConnectionData): string {
  if (connection.type !== 'clickup') throw new NodeOperationError(`A conexão é do tipo ${connection.type}, não do ClickUp`);
  const token = String(connection.data.token ?? '');
  if (!token) throw new NodeOperationError('A conexão do ClickUp está sem o token');
  return token;
}

export function listFrom(value: JsonValue): string {
  const text = String(value ?? '').trim();
  // Links de lista: .../v/li/901234567 ou .../li/901234567
  const match = /^([\w-]+)$/.exec(text) ?? /\/li\/([\w-]+)/.exec(text);
  if (!match) throw new NodeOperationError(`Informe o ID ou o link da lista (recebeu "${text}")`);
  return match[1]!;
}

function splitList(value: JsonValue): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
  return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}

/** Converte o prazo para milissegundos; diz também se o prazo tem horário. */
export function parseDue(value: JsonValue): { ms: number; hasTime: boolean } {
  if (typeof value === 'number') return { ms: value, hasTime: true };
  const text = String(value).trim();
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(text);
  if (br) {
    const [, d, m, y, h, min] = br;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h ?? 0), Number(min ?? 0));
    if (date.getDate() !== Number(d) || date.getMonth() !== Number(m) - 1) throw new NodeOperationError(`Prazo inválido: ${text}`);
    return { ms: date.getTime(), hasTime: h !== undefined };
  }
  if (/^\d+$/.test(text)) return { ms: Number(text), hasTime: true };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(text);
  if (Number.isNaN(iso.getTime())) throw new NodeOperationError(`Prazo inválido: ${text}. Use dd/mm/aaaa, dd/mm/aaaa hh:mm ou data ISO`);
  return { ms: iso.getTime(), hasTime: !/^\d{4}-\d{2}-\d{2}$/.test(text) };
}

function customFields(value: JsonValue): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .filter((f) => typeof f.id === 'string' && f.id.trim() !== '')
    .map((f) => ({ id: String(f.id).trim(), value: fieldValue(f.value ?? null) }));
}

function fieldValue(value: JsonValue): JsonValue {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (/^(-?\d+(\.\d+)?|true|false|null|\[.*\]|\{.*\})$/s.test(text)) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return value;
    }
  }
  return value;
}

/** E-mail → ID de todos os membros dos workspaces que o token enxerga. */
async function teamMembers(token: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const result = await callApi({ service: 'ClickUp', method: 'GET', url: `${CLICKUP_API}/team`, headers: { authorization: token }, signal });
  const map = new Map<string, number>();
  const teams = isPlainObject(result) && Array.isArray(result.teams) ? result.teams : [];
  for (const team of teams.filter(isPlainObject)) {
    for (const member of (Array.isArray(team.members) ? team.members : []).filter(isPlainObject)) {
      const user = isPlainObject(member.user) ? member.user : {};
      if (typeof user.email === 'string' && typeof user.id === 'number') map.set(user.email.toLowerCase(), user.id);
    }
  }
  return map;
}

/** Testa o token buscando o usuário dono dele. */
export async function testClickUpConnection(connection: ConnectionData): Promise<void> {
  await callApi({ service: 'ClickUp', method: 'GET', url: `${CLICKUP_API}/user`, headers: { authorization: clickupToken(connection) } });
}
