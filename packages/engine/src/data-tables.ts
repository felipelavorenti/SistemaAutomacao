import { randomUUID } from 'node:crypto';
import { NodeOperationError } from './node-types.js';
import type {
  DataTableColumn,
  DataTableColumnType,
  DataTableCondition,
  DataTableFilter,
  DataTableInfo,
  DataTableQuery,
  DataTableStore,
} from './node-types.js';
import type { JsonObject, JsonValue } from './types.js';

/**
 * Regras das tabelas de dados (nó Data Table), iguais no armazenamento em memória dos testes e no
 * Postgres do servidor: nomes de coluna, conversão de valores e o significado de cada condição.
 */

export const DATA_TABLE_COLUMN_TYPES: DataTableColumnType[] = ['string', 'number', 'boolean', 'date'];
/** Colunas que toda linha tem; não podem ser criadas nem alteradas. */
export const DATA_TABLE_SYSTEM_COLUMNS = ['id', 'createdAt', 'updatedAt'];
export const DATA_TABLE_CONDITIONS = ['eq', 'neq', 'like', 'ilike', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'] as const;
/** Condições que não usam valor. */
export const DATA_TABLE_UNARY_CONDITIONS = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Confere nome e tipo das colunas de uma tabela nova. */
export function validateColumns(columns: DataTableColumn[]): DataTableColumn[] {
  const seen = new Set<string>();
  return columns.map((c) => {
    const name = String(c.name ?? '').trim();
    if (!COLUMN_NAME.test(name)) {
      throw new NodeOperationError(`O nome de coluna "${name}" não vale: use letras, números e _, começando por letra ou _ (até 63 caracteres)`);
    }
    if (DATA_TABLE_SYSTEM_COLUMNS.includes(name)) throw new NodeOperationError(`A coluna "${name}" já existe em toda tabela`);
    if (seen.has(name.toLowerCase())) throw new NodeOperationError(`A coluna "${name}" aparece duas vezes`);
    seen.add(name.toLowerCase());
    if (!DATA_TABLE_COLUMN_TYPES.includes(c.type)) throw new NodeOperationError(`O tipo "${c.type}" da coluna "${name}" não existe (use string, number, boolean ou date)`);
    return { name, type: c.type };
  });
}

/** Converte o valor para o tipo da coluna (vazio e null viram null). */
export function coerceColumnValue(column: DataTableColumn, value: JsonValue | undefined): JsonValue {
  if (value === undefined || value === null) return null;
  const bad = () => new NodeOperationError(`O valor ${JSON.stringify(value)} não serve para a coluna "${column.name}" (${column.type})`);
  switch (column.type) {
    case 'string':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      if (value === '') return null;
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim().replace(',', '.')) : NaN;
      if (!Number.isFinite(n)) throw bad();
      return n;
    }
    case 'boolean':
      if (value === '') return null;
      if (value === true || value === 'true' || value === 1 || value === '1') return true;
      if (value === false || value === 'false' || value === 0 || value === '0') return false;
      throw bad();
    case 'date': {
      if (value === '') return null;
      if (typeof value !== 'string' && typeof value !== 'number') throw bad();
      const t = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(t)) throw bad();
      return new Date(t).toISOString();
    }
  }
}

/** Confere e converte os dados de uma linha; colunas desconhecidas dão erro. */
export function coerceRow(table: DataTableInfo, data: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (DATA_TABLE_SYSTEM_COLUMNS.includes(key)) continue;
    const column = table.columns.find((c) => c.name === key);
    if (!column) {
      throw new NodeOperationError(`A tabela "${table.name}" não tem a coluna "${key}". Colunas: ${table.columns.map((c) => c.name).join(', ') || '(nenhuma)'}`);
    }
    out[key] = coerceColumnValue(column, value);
  }
  return out;
}

/** Tipo de uma coluna do filtro, incluindo as do sistema. */
export function filterColumn(table: DataTableInfo, name: string): DataTableColumn {
  if (name === 'id') return { name, type: 'number' };
  if (name === 'createdAt' || name === 'updatedAt') return { name, type: 'date' };
  const column = table.columns.find((c) => c.name === name);
  if (!column) throw new NodeOperationError(`A tabela "${table.name}" não tem a coluna "${name}" usada no filtro`);
  return column;
}

/** Confere o filtro e converte os valores para o tipo de cada coluna. */
export function normalizeFilter(table: DataTableInfo, filter: DataTableFilter | undefined): DataTableFilter {
  if (!filter) return { type: 'and', conditions: [] };
  return {
    type: filter.type === 'or' ? 'or' : 'and',
    conditions: filter.conditions.map((c) => {
      const column = filterColumn(table, c.column);
      if (!(DATA_TABLE_CONDITIONS as readonly string[]).includes(c.condition)) throw new NodeOperationError(`A condição "${c.condition}" não existe`);
      if (DATA_TABLE_UNARY_CONDITIONS.has(c.condition)) return { column: column.name, condition: c.condition };
      if ((c.condition === 'like' || c.condition === 'ilike') && column.type !== 'string') {
        throw new NodeOperationError(`A condição "${c.condition}" só vale para colunas de texto ("${column.name}" é ${column.type})`);
      }
      if ((c.condition === 'isTrue' || c.condition === 'isFalse') && column.type !== 'boolean') {
        throw new NodeOperationError(`A condição "${c.condition}" só vale para colunas boolean`);
      }
      const value = c.condition === 'like' || c.condition === 'ilike' ? String(c.value ?? '') : coerceColumnValue(column, c.value);
      return { column: column.name, condition: c.condition, value };
    }),
  };
}

/** "%" vale qualquer trecho e "_" um caractere, como no LIKE do SQL. */
function likeToRegExp(pattern: string, insensitive: boolean): RegExp {
  let source = '';
  for (const ch of pattern) source += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${source}$`, insensitive ? 'is' : 's');
}

function compare(a: JsonValue, b: JsonValue, type: DataTableColumnType): number {
  if (type === 'date') return Date.parse(String(a)) - Date.parse(String(b));
  if (type === 'number') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** A linha atende à condição? (Mesma regra do SQL: comparar com vazio nunca é verdade, menos em neq.) */
export function matchesCondition(table: DataTableInfo, row: JsonObject, c: DataTableCondition): boolean {
  const column = filterColumn(table, c.column);
  const value = row[c.column] ?? null;
  switch (c.condition) {
    case 'isEmpty':
      return value === null || value === '';
    case 'isNotEmpty':
      return value !== null && value !== '';
    case 'isTrue':
      return value === true;
    case 'isFalse':
      return value === false;
    case 'eq':
      return c.value === null ? value === null : value !== null && compare(value, c.value!, column.type) === 0;
    case 'neq':
      return c.value === null ? value !== null : value === null || compare(value, c.value!, column.type) !== 0;
    case 'like':
    case 'ilike':
      return value !== null && likeToRegExp(String(c.value ?? ''), c.condition === 'ilike').test(String(value));
    default: {
      if (value === null || c.value === null || c.value === undefined) return false;
      const d = compare(value, c.value, column.type);
      return c.condition === 'gt' ? d > 0 : c.condition === 'gte' ? d >= 0 : c.condition === 'lt' ? d < 0 : d <= 0;
    }
  }
}

export function matchesFilter(table: DataTableInfo, row: JsonObject, filter: DataTableFilter): boolean {
  if (!filter.conditions.length) return true;
  return filter.type === 'or' ? filter.conditions.some((c) => matchesCondition(table, row, c)) : filter.conditions.every((c) => matchesCondition(table, row, c));
}

/** Tabelas guardadas na memória do processo: usadas nos testes e quando a execução não recebe outras. */
export class MemoryDataTableStore implements DataTableStore {
  private tables = new Map<string, DataTableInfo>();
  private rows = new Map<string, JsonObject[]>();
  private nextRowId = new Map<string, number>();

  async list(options: { name?: string; limit?: number } = {}): Promise<DataTableInfo[]> {
    const name = options.name?.toLowerCase();
    const list = [...this.tables.values()].filter((t) => !name || t.name.toLowerCase().includes(name)).sort((a, b) => a.name.localeCompare(b.name));
    return options.limit ? list.slice(0, options.limit) : list;
  }

  async get(idOrName: string): Promise<DataTableInfo> {
    const table = this.tables.get(idOrName) ?? [...this.tables.values()].find((t) => t.name === idOrName);
    if (!table) throw new NodeOperationError(`A tabela de dados "${idOrName}" não existe`);
    return table;
  }

  async create(name: string, columns: DataTableColumn[]): Promise<DataTableInfo> {
    name = name.trim();
    if (!name) throw new NodeOperationError('Informe o nome da tabela');
    if ([...this.tables.values()].some((t) => t.name === name)) throw new NodeOperationError(`Já existe uma tabela chamada "${name}"`);
    const now = new Date().toISOString();
    const table: DataTableInfo = { id: randomUUID(), name, columns: validateColumns(columns), createdAt: now, updatedAt: now };
    this.tables.set(table.id, table);
    this.rows.set(table.id, []);
    this.nextRowId.set(table.id, 1);
    return table;
  }

  async rename(id: string, name: string): Promise<DataTableInfo> {
    const table = await this.get(id);
    name = name.trim();
    if (!name) throw new NodeOperationError('Informe o nome da tabela');
    if ([...this.tables.values()].some((t) => t.name === name && t.id !== table.id)) throw new NodeOperationError(`Já existe uma tabela chamada "${name}"`);
    table.name = name;
    table.updatedAt = new Date().toISOString();
    return table;
  }

  async delete(id: string): Promise<void> {
    const table = await this.get(id);
    this.tables.delete(table.id);
    this.rows.delete(table.id);
  }

  async insertRows(tableId: string, data: JsonObject[]): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const converted = data.map((d) => coerceRow(table, d));
    const now = new Date().toISOString();
    const out = converted.map((values) => {
      const id = this.nextRowId.get(table.id)!;
      this.nextRowId.set(table.id, id + 1);
      const row: JsonObject = { id, ...Object.fromEntries(table.columns.map((c) => [c.name, values[c.name] ?? null])), createdAt: now, updatedAt: now };
      this.rows.get(table.id)!.push(row);
      return row;
    });
    return out.map((r) => ({ ...r }));
  }

  async getRows(tableId: string, query: DataTableQuery): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const filter = normalizeFilter(table, query.filter);
    let list = this.rows.get(table.id)!.filter((r) => matchesFilter(table, r, filter));
    const orderBy = query.orderBy || 'id';
    const column = filterColumn(table, orderBy);
    const dir = query.orderDirection === 'desc' ? -1 : 1;
    list = [...list].sort((a, b) => {
      const x = a[orderBy] ?? null;
      const y = b[orderBy] ?? null;
      // Vazio fica no fim na ordem crescente, como no Postgres.
      if (x === null || y === null) return x === y ? 0 : (x === null ? 1 : -1) * dir;
      return compare(x, y, column.type) * dir || compare(a.id!, b.id!, 'number');
    });
    if (query.limit !== undefined) list = list.slice(0, query.limit);
    return list.map((r) => ({ ...r }));
  }

  async updateRows(tableId: string, filter: DataTableFilter, data: JsonObject): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const f = normalizeFilter(table, filter);
    const values = coerceRow(table, data);
    const now = new Date().toISOString();
    const changed = this.rows.get(table.id)!.filter((r) => matchesFilter(table, r, f));
    for (const row of changed) Object.assign(row, values, { updatedAt: now });
    return changed.map((r) => ({ ...r }));
  }

  async upsertRow(tableId: string, filter: DataTableFilter, data: JsonObject): Promise<JsonObject[]> {
    const updated = await this.updateRows(tableId, filter, data);
    return updated.length ? updated : this.insertRows(tableId, [data]);
  }

  async deleteRows(tableId: string, filter: DataTableFilter, dryRun = false): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const f = normalizeFilter(table, filter);
    const all = this.rows.get(table.id)!;
    const removed = all.filter((r) => matchesFilter(table, r, f));
    if (!dryRun) this.rows.set(table.id, all.filter((r) => !removed.includes(r)));
    return removed.map((r) => ({ ...r }));
  }
}
