import { checkIdentifier } from '../database/params.js';
import { DATABASE_CONNECTION_TYPES, type ParamDirection, type ParamType, type ProcedureParam } from '../database/drivers.js';
import type { DatabaseSession, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { isPlainObject } from './paths.js';

const DIRECTIONS = [
  { name: 'Entrada', value: 'in' },
  { name: 'Saída', value: 'out' },
  { name: 'Entrada e saída', value: 'inout' },
];
const TYPES = [
  { name: 'Texto', value: 'text' },
  { name: 'Número inteiro', value: 'int' },
  { name: 'Número decimal', value: 'decimal' },
  { name: 'Data e hora', value: 'date' },
  { name: 'Verdadeiro/falso', value: 'boolean' },
  { name: 'Cursor (Oracle, Postgres)', value: 'cursor' },
];

export const database: NodeType = {
  description: {
    type: 'database',
    displayName: 'Banco de dados',
    description: 'Executa comandos em SQL Server, Oracle ou Postgres. Todo comando fica registrado em Comandos SQL.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'connection', displayName: 'Conexão', type: 'connection', default: '', required: true, connectionTypes: DATABASE_CONNECTION_TYPES },
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'query',
        options: [
          { name: 'Executar SQL (SELECT, UPDATE, DELETE...)', value: 'query' },
          { name: 'Inserir linhas', value: 'insert' },
          { name: 'Executar procedure', value: 'procedure' },
        ],
      },
      {
        name: 'sql',
        displayName: 'SQL',
        type: 'string',
        multiline: true,
        default: '',
        placeholder: 'SELECT * FROM produtos WHERE codigo = :codigo',
        description: 'Use :nome para parâmetros e preencha o valor de cada um abaixo. Evite montar o SQL com expressões: parâmetros protegem contra SQL injection.',
        showWhen: { operation: ['query'] },
      },
      {
        name: 'queryParams',
        displayName: 'Parâmetros',
        type: 'list',
        default: [],
        showWhen: { operation: ['query'] },
        fields: [
          { name: 'name', displayName: 'Nome (sem os dois pontos)', type: 'string', default: '' },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
      },
      { name: 'table', displayName: 'Tabela', type: 'string', default: '', placeholder: 'schema.tabela', showWhen: { operation: ['insert'] } },
      {
        name: 'columnsMode',
        displayName: 'Colunas',
        type: 'options',
        default: 'auto',
        showWhen: { operation: ['insert'] },
        options: [
          { name: 'Todos os campos do item, com o mesmo nome', value: 'auto' },
          { name: 'Escolher coluna e valor', value: 'manual' },
        ],
      },
      {
        name: 'columns',
        displayName: 'Valores',
        type: 'list',
        default: [{ column: '', value: '' }],
        showWhen: { operation: ['insert'], columnsMode: ['manual'] },
        fields: [
          { name: 'column', displayName: 'Coluna', type: 'string', default: '' },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
      },
      { name: 'procedure', displayName: 'Procedure', type: 'string', default: '', placeholder: 'pacote.procedure', showWhen: { operation: ['procedure'] } },
      {
        name: 'procedureParams',
        displayName: 'Parâmetros da procedure',
        type: 'list',
        default: [],
        showWhen: { operation: ['procedure'] },
        description: 'Na ordem da procedure. Os de saída e os cursores voltam no item de saída, pelo nome; linhas devolvidas por SELECT dentro da procedure vêm em "linhas".',
        fields: [
          { name: 'name', displayName: 'Nome', type: 'string', default: '' },
          { name: 'direction', displayName: 'Direção', type: 'options', default: 'in', options: DIRECTIONS },
          { name: 'type', displayName: 'Tipo', type: 'options', default: 'text', options: TYPES },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
      },
      {
        name: 'executeOnce',
        displayName: 'Executar uma vez só',
        type: 'boolean',
        default: false,
        description: 'Desligado: executa uma vez para cada item que chega, com os valores daquele item.',
      },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const connectionId = String((await ctx.getParam('connection', 0)) ?? '');
    if (!connectionId) throw new NodeOperationError('Escolha a conexão do banco');
    const db = await ctx.database(connectionId);
    const executeOnce = (await ctx.getParam('executeOnce', 0)) === true;
    const operation = await ctx.getParam('operation', 0);
    const count = executeOnce ? Math.min(1, Math.max(input.length, 1)) : input.length;
    const out: Item[] = [];

    for (let i = 0; i < count; i++) {
      try {
        if (operation === 'insert') out.push(await insert(ctx.getParam, db, input[i], i));
        else if (operation === 'procedure') out.push(await procedure(ctx.getParam, db, i));
        else out.push(...(await query(ctx.getParam, db, i)));
      } catch (err) {
        throw dbError(err, count > 1 ? i : undefined);
      }
    }
    return [out];
  },
};

type GetParam = (name: string, itemIndex?: number) => Promise<JsonValue>;

async function query(getParam: GetParam, db: DatabaseSession, i: number): Promise<Item[]> {
  const sql = String((await getParam('sql', i)) ?? '').trim();
  if (!sql) throw new NodeOperationError('Escreva o SQL');
  const params: Record<string, JsonValue> = {};
  for (const p of asList(await getParam('queryParams', i))) {
    const name = String(p.name ?? '').trim().replace(/^:/, '');
    if (name) params[name] = p.value ?? null;
  }
  const result = await db.query(sql, params);
  if (result.rows.length) return result.rows.map((json) => ({ json }));
  return [{ json: { linhasAfetadas: result.rowsAffected ?? 0 } }];
}

async function insert(getParam: GetParam, db: DatabaseSession, item: Item | undefined, i: number): Promise<Item> {
  const table = checkIdentifier(String((await getParam('table', i)) ?? ''), 'Nome da tabela');
  let values: JsonObject;
  if ((await getParam('columnsMode', i)) === 'manual') {
    values = {};
    for (const c of asList(await getParam('columns', i))) {
      const column = String(c.column ?? '').trim();
      if (column) values[column] = c.value ?? null;
    }
  } else {
    values = { ...(item?.json ?? {}) };
  }
  const columns = Object.keys(values).map((c) => checkIdentifier(c, 'Nome da coluna'));
  if (!columns.length) throw new NodeOperationError('Nenhuma coluna para inserir');
  const params: Record<string, JsonValue> = {};
  columns.forEach((c, n) => (params[`p${n}`] = values[c]));
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, n) => `:p${n}`).join(', ')})`;
  const result = await db.query(sql, params, 'insert');
  return { json: { ...values, linhasAfetadas: result.rowsAffected ?? 0 } };
}

async function procedure(getParam: GetParam, db: DatabaseSession, i: number): Promise<Item> {
  const name = String((await getParam('procedure', i)) ?? '');
  const params: ProcedureParam[] = asList(await getParam('procedureParams', i))
    .filter((p) => String(p.name ?? '').trim())
    .map((p) => ({
      name: checkIdentifier(String(p.name).replace(/^[:@]/, ''), 'Nome do parâmetro'),
      direction: (String(p.direction ?? 'in') as ParamDirection),
      type: (String(p.type ?? 'text') as ParamType),
      value: coerce(p.value ?? null, String(p.type ?? 'text')),
    }));
  const result = await db.procedure(name, params);
  const json: JsonObject = { ...(result.outputs ?? {}) };
  if (result.rows.length) json.linhas = result.rows;
  if (result.recordsets?.length) json.outrosResultados = result.recordsets;
  if (result.rowsAffected !== null && !result.rows.length) json.linhasAfetadas = result.rowsAffected;
  return { json };
}

/** Os campos da tela chegam como texto; converte conforme o tipo escolhido. */
function coerce(value: JsonValue, type: string): JsonValue {
  if (value === '' && type !== 'text') return null;
  if ((type === 'int' || type === 'decimal') && typeof value === 'string') {
    const n = Number(value.replace(',', '.'));
    if (Number.isNaN(n)) throw new NodeOperationError(`"${value}" não é um número`);
    return n;
  }
  if (type === 'boolean' && typeof value === 'string') return value === 'true' || value === '1';
  return value;
}

function asList(value: JsonValue): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/** Erro do banco com o código do driver, para aparecer no log da execução. */
function dbError(err: unknown, itemIndex?: number): NodeOperationError {
  if (err instanceof NodeOperationError) return err;
  const e = err as { message?: string; code?: string | number; number?: number; errorNum?: number; detail?: string; hint?: string; position?: string };
  const code = e.code ?? e.number ?? e.errorNum ?? null;
  const prefix = itemIndex === undefined ? '' : `Item ${itemIndex}: `;
  return new NodeOperationError(`${prefix}${e.message ?? String(err)}`, {
    codigo: code === null ? null : String(code),
    detalhe: e.detail ?? null,
    dica: e.hint ?? null,
  });
}
