import type { DataTableColumnType, DataTableConditionType, DataTableFilter, DataTableInfo, NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { DATA_TABLE_UNARY_CONDITIONS } from '../data-tables.js';
import { isPlainObject } from './paths.js';
import { bool, num, str } from './values.js';

/**
 * Data Table: lê e grava tabelas simples guardadas no próprio Info8n (menu Tabelas de dados),
 * como o nó Data Table do n8n.
 */

const ROW_OPERATIONS = ['insert', 'get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'];
const TABLE_OPERATIONS = ['create', 'delete', 'list', 'update'];

const CONDITIONS: { name: string; value: DataTableConditionType }[] = [
  { name: 'É igual a', value: 'eq' },
  { name: 'É diferente de', value: 'neq' },
  { name: 'Parece com (com %, diferencia maiúsculas)', value: 'like' },
  { name: 'Parece com (com %, sem diferenciar maiúsculas)', value: 'ilike' },
  { name: 'Maior que', value: 'gt' },
  { name: 'Maior ou igual a', value: 'gte' },
  { name: 'Menor que', value: 'lt' },
  { name: 'Menor ou igual a', value: 'lte' },
  { name: 'Está vazio', value: 'isEmpty' },
  { name: 'Não está vazio', value: 'isNotEmpty' },
  { name: 'É verdadeiro', value: 'isTrue' },
  { name: 'É falso', value: 'isFalse' },
];

const rowShow = (...operations: string[]) => ({ resource: ['row'], operation: operations });
const tableShow = (...operations: string[]) => ({ resource: ['table'], operation: operations });

const asList = (value: JsonValue): JsonObject[] => (Array.isArray(value) ? value.filter(isPlainObject) as JsonObject[] : []);

async function readFilter(ctx: NodeExecuteContext, i: number): Promise<DataTableFilter> {
  const rows = asList(await ctx.getParam('conditions', i));
  return {
    type: str(await ctx.getParam('matchType', i), 'allConditions') === 'anyCondition' ? 'or' : 'and',
    conditions: rows
      .filter((r) => str(r.column).trim())
      .map((r) => {
        const condition = (str(r.condition) || 'eq') as DataTableConditionType;
        return { column: str(r.column).trim(), condition, ...(DATA_TABLE_UNARY_CONDITIONS.has(condition) ? {} : { value: r.value ?? null }) };
      }),
  };
}

/** Dados da linha: do item (colunas com o mesmo nome) ou da lista do nó. */
async function readValues(ctx: NodeExecuteContext, i: number, item: Item, table: DataTableInfo): Promise<JsonObject> {
  if (str(await ctx.getParam('mappingMode', i), 'autoMapInputData') === 'autoMapInputData') {
    const out: JsonObject = {};
    for (const c of table.columns) if (item.json[c.name] !== undefined) out[c.name] = item.json[c.name]!;
    return out;
  }
  const out: JsonObject = {};
  for (const row of asList(await ctx.getParam('values', i))) {
    const column = str(row.column).trim();
    if (column) out[column] = row.value ?? null;
  }
  return out;
}

async function tableOf(ctx: NodeExecuteContext, i: number): Promise<DataTableInfo> {
  const ref = str(await ctx.getParam('dataTable', i)).trim();
  if (!ref) throw new NodeOperationError('Escolha a tabela de dados');
  return ctx.dataTables.get(ref);
}

const needConditions = (filter: DataTableFilter, what: string) => {
  if (!filter.conditions.length) throw new NodeOperationError(`Informe ao menos uma condição para ${what} (para pegar todas as linhas, use a condição "id" "Não está vazio")`);
};

export const dataTable: NodeType = {
  description: {
    type: 'dataTable',
    displayName: 'Data Table',
    description: 'Lê e grava as tabelas de dados guardadas no Info8n (menu Tabelas de dados).',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'resource',
        displayName: 'Recurso',
        type: 'options',
        default: 'row',
        options: [
          { name: 'Linha', value: 'row' },
          { name: 'Tabela', value: 'table' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'insert',
        options: [
          { name: 'Inserir linha', value: 'insert', showWhen: { resource: ['row'] } },
          { name: 'Buscar linhas', value: 'get', showWhen: { resource: ['row'] } },
          { name: 'Atualizar linhas', value: 'update', showWhen: { resource: ['row'] } },
          { name: 'Atualizar ou inserir', value: 'upsert', showWhen: { resource: ['row'] } },
          { name: 'Apagar linhas', value: 'deleteRows', showWhen: { resource: ['row'] } },
          { name: 'Se a linha existe', value: 'rowExists', showWhen: { resource: ['row'] } },
          { name: 'Se a linha não existe', value: 'rowNotExists', showWhen: { resource: ['row'] } },
          { name: 'Criar tabela', value: 'create', showWhen: { resource: ['table'] } },
          { name: 'Listar tabelas', value: 'list', showWhen: { resource: ['table'] } },
          { name: 'Renomear tabela', value: 'update', showWhen: { resource: ['table'] } },
          { name: 'Excluir tabela', value: 'delete', showWhen: { resource: ['table'] } },
        ],
        description: 'Linha: Inserir, Buscar, Atualizar, Atualizar ou inserir, Apagar, Se existe e Se não existe. Tabela: Criar, Listar, Renomear e Excluir.',
      },
      {
        name: 'dataTable',
        displayName: 'Tabela',
        type: 'dataTable',
        default: '',
        required: true,
        description: 'A tabela; numa expressão, o ID ou o nome dela.',
        showWhen: { resource: ['row', 'table'], operation: [...ROW_OPERATIONS, 'delete', 'update'] },
      },
      {
        name: 'mappingMode',
        displayName: 'Dados da linha',
        type: 'options',
        default: 'autoMapInputData',
        options: [
          { name: 'Campos do item com o nome das colunas', value: 'autoMapInputData' },
          { name: 'Informar coluna por coluna', value: 'defineBelow' },
        ],
        showWhen: rowShow('insert', 'update', 'upsert'),
      },
      {
        name: 'values',
        displayName: 'Valores',
        type: 'list',
        default: [],
        fields: [
          { name: 'column', displayName: 'Coluna', type: 'string', default: '' },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
        showWhen: { resource: ['row'], operation: ['insert', 'update', 'upsert'], mappingMode: ['defineBelow'] },
      },
      {
        name: 'matchType',
        displayName: 'Linhas que atendem a',
        type: 'options',
        default: 'allConditions',
        options: [
          { name: 'Todas as condições', value: 'allConditions' },
          { name: 'Qualquer condição', value: 'anyCondition' },
        ],
        showWhen: rowShow('get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'),
      },
      {
        name: 'conditions',
        displayName: 'Condições',
        type: 'list',
        default: [],
        description: 'Colunas da tabela, ou id, createdAt e updatedAt. Em Buscar, sem condição traz todas as linhas.',
        fields: [
          { name: 'column', displayName: 'Coluna', type: 'string', default: '' },
          { name: 'condition', displayName: 'Condição', type: 'options', default: 'eq', options: CONDITIONS },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
        showWhen: rowShow('get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'),
      },
      { name: 'returnAll', displayName: 'Trazer todas', type: 'boolean', default: false, showWhen: { resource: ['row', 'table'], operation: ['get', 'list'] } },
      { name: 'limit', displayName: 'Quantidade', type: 'number', default: 50, showWhen: { resource: ['row', 'table'], operation: ['get', 'list'], returnAll: [false] } },
      { name: 'orderBy', displayName: 'Ordenar por', type: 'string', default: '', placeholder: 'id', description: 'Coluna; vazio ordena por id (ordem de inserção).', showWhen: rowShow('get') },
      {
        name: 'orderDirection',
        displayName: 'Ordem',
        type: 'options',
        default: 'asc',
        options: [
          { name: 'Crescente', value: 'asc' },
          { name: 'Decrescente', value: 'desc' },
        ],
        showWhen: rowShow('get'),
      },
      { name: 'dryRun', displayName: 'Só simular', type: 'boolean', default: false, description: 'Mostra as linhas que seriam apagadas, sem apagar.', showWhen: rowShow('deleteRows') },
      { name: 'tableName', displayName: 'Nome da tabela', type: 'string', default: '', required: true, showWhen: tableShow('create') },
      {
        name: 'tableColumns',
        displayName: 'Colunas',
        type: 'list',
        default: [],
        fields: [
          { name: 'name', displayName: 'Nome', type: 'string', default: '' },
          {
            name: 'type',
            displayName: 'Tipo',
            type: 'options',
            default: 'string',
            options: [
              { name: 'Texto', value: 'string' },
              { name: 'Número', value: 'number' },
              { name: 'Sim/não', value: 'boolean' },
              { name: 'Data', value: 'date' },
            ],
          },
        ],
        showWhen: tableShow('create'),
      },
      { name: 'reuseExisting', displayName: 'Usar a tabela se já existir', type: 'boolean', default: false, showWhen: tableShow('create') },
      { name: 'nameFilter', displayName: 'Nome contém', type: 'string', default: '', showWhen: tableShow('list') },
      { name: 'newName', displayName: 'Nome novo', type: 'string', default: '', required: true, showWhen: tableShow('update') },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const resource = str(await ctx.getParam('resource', 0), 'row');
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i]!;
      const operation = str(await ctx.getParam('operation', i), 'insert');
      const allowed = resource === 'table' ? TABLE_OPERATIONS : ROW_OPERATIONS;
      if (!allowed.includes(operation)) throw new NodeOperationError(`O recurso "${resource === 'table' ? 'Tabela' : 'Linha'}" não tem a operação "${operation}"`);

      if (resource === 'table') {
        if (operation === 'create') {
          const name = str(await ctx.getParam('tableName', i)).trim();
          if (bool(await ctx.getParam('reuseExisting', i))) {
            const existing = (await ctx.dataTables.list({ name })).find((t) => t.name === name);
            if (existing) {
              out.push({ json: existing as unknown as JsonObject });
              continue;
            }
          }
          const columns = asList(await ctx.getParam('tableColumns', i)).map((c) => ({ name: str(c.name).trim(), type: (str(c.type) || 'string') as DataTableColumnType }));
          out.push({ json: (await ctx.dataTables.create(name, columns)) as unknown as JsonObject });
        } else if (operation === 'list') {
          const limit = bool(await ctx.getParam('returnAll', i)) ? undefined : Math.max(1, Math.trunc(num(await ctx.getParam('limit', i), 50)));
          const tables = await ctx.dataTables.list({ name: str(await ctx.getParam('nameFilter', i)).trim() || undefined, limit });
          for (const t of tables) out.push({ json: t as unknown as JsonObject });
        } else if (operation === 'update') {
          const table = await tableOf(ctx, i);
          out.push({ json: (await ctx.dataTables.rename(table.id, str(await ctx.getParam('newName', i)))) as unknown as JsonObject });
        } else {
          const table = await tableOf(ctx, i);
          await ctx.dataTables.delete(table.id);
          out.push({ json: { success: true, id: table.id, name: table.name } });
        }
        continue;
      }

      const table = await tableOf(ctx, i);
      switch (operation) {
        case 'insert':
          for (const row of await ctx.dataTables.insertRows(table.id, [await readValues(ctx, i, item, table)])) out.push({ json: row });
          break;
        case 'get': {
          const limit = bool(await ctx.getParam('returnAll', i)) ? undefined : Math.max(1, Math.trunc(num(await ctx.getParam('limit', i), 50)));
          const rows = await ctx.dataTables.getRows(table.id, {
            filter: await readFilter(ctx, i),
            limit,
            orderBy: str(await ctx.getParam('orderBy', i)).trim() || undefined,
            orderDirection: str(await ctx.getParam('orderDirection', i)) === 'desc' ? 'desc' : 'asc',
          });
          for (const row of rows) out.push({ json: row });
          break;
        }
        case 'update':
        case 'upsert': {
          const filter = await readFilter(ctx, i);
          needConditions(filter, operation === 'update' ? 'atualizar' : 'atualizar ou inserir');
          const values = await readValues(ctx, i, item, table);
          const rows = operation === 'update' ? await ctx.dataTables.updateRows(table.id, filter, values) : await ctx.dataTables.upsertRow(table.id, filter, values);
          for (const row of rows) out.push({ json: row });
          break;
        }
        case 'deleteRows': {
          const filter = await readFilter(ctx, i);
          needConditions(filter, 'apagar');
          for (const row of await ctx.dataTables.deleteRows(table.id, filter, bool(await ctx.getParam('dryRun', i)))) out.push({ json: row });
          break;
        }
        case 'rowExists':
        case 'rowNotExists': {
          const found = await ctx.dataTables.getRows(table.id, { filter: await readFilter(ctx, i), limit: 1 });
          // Como no n8n: o item passa adiante (igual chegou) quando a condição vale.
          if ((found.length > 0) === (operation === 'rowExists')) out.push(item);
          break;
        }
      }
    }
    return [out];
  },
};
