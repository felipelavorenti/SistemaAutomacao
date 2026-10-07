import {
  coerceRow,
  DATA_TABLE_UNARY_CONDITIONS,
  filterColumn,
  NodeOperationError,
  normalizeFilter,
  validateColumns,
  type DataTableColumn,
  type DataTableCondition,
  type DataTableFilter,
  type DataTableInfo,
  type DataTableQuery,
  type DataTableStore,
  type JsonObject,
  type JsonValue,
} from '@sa/engine';
import { many, one, transaction, type Db, type Queryable } from '../db/db.js';

/**
 * Tabelas de dados guardadas no Postgres do Info8n. As regras (nomes, tipos, condições) vêm do motor;
 * aqui o filtro vira SQL sobre o jsonb de cada linha.
 */

interface TableRow {
  id: string;
  name: string;
  columns: DataTableColumn[];
  created_at: Date;
  updated_at: Date;
}

interface DataRow {
  id: string;
  data: JsonObject;
  created_at: Date;
  updated_at: Date;
}

/** Linhas que uma tabela pode ter (protege o banco de um laço que insere sem parar). */
export const MAX_ROWS_PER_TABLE = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toInfo = (r: TableRow): DataTableInfo => ({
  id: r.id,
  name: r.name,
  columns: r.columns,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

function toRow(table: DataTableInfo, r: DataRow): JsonObject {
  return {
    id: Number(r.id),
    ...Object.fromEntries(table.columns.map((c) => [c.name, r.data[c.name] ?? null])),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const CAST: Record<string, string> = { string: 'text', number: 'numeric', boolean: 'boolean', date: 'timestamptz' };

/** Expressão SQL da coluna, já no tipo dela. */
function columnSql(table: DataTableInfo, name: string, params: unknown[]): { sql: string; raw: string | null; type: string } {
  if (name === 'id') return { sql: 'r.id', raw: null, type: 'number' };
  if (name === 'createdAt') return { sql: 'r.created_at', raw: null, type: 'date' };
  if (name === 'updatedAt') return { sql: 'r.updated_at', raw: null, type: 'date' };
  const column = filterColumn(table, name);
  params.push(column.name);
  const raw = `(r.data->>$${params.length}::text)`;
  const sql = column.type === 'string' ? `${raw} COLLATE "C"` : `${raw}::${CAST[column.type]}`;
  return { sql, raw, type: column.type };
}

function conditionSql(table: DataTableInfo, c: DataTableCondition, params: unknown[]): string {
  const col = columnSql(table, c.column, params);
  const param = (value: JsonValue | undefined) => {
    params.push(value);
    return `$${params.length}::${CAST[col.type]}`;
  };
  switch (c.condition) {
    case 'isEmpty':
      return col.raw ? `(${col.raw} IS NULL OR ${col.raw} = '')` : 'false';
    case 'isNotEmpty':
      return col.raw ? `(${col.raw} IS NOT NULL AND ${col.raw} <> '')` : 'true';
    case 'isTrue':
      return `${col.sql} IS TRUE`;
    case 'isFalse':
      return `${col.sql} IS FALSE`;
    case 'eq':
      return c.value === null ? `${col.sql} IS NULL` : `${col.sql} = ${param(c.value)}`;
    case 'neq':
      return c.value === null ? `${col.sql} IS NOT NULL` : `(${col.sql} IS NULL OR ${col.sql} <> ${param(c.value)})`;
    case 'like':
    case 'ilike':
      // ESCAPE '': só % e _ são especiais, como no armazenamento em memória.
      params.push(String(c.value ?? ''));
      return `${col.raw ?? col.sql} ${c.condition === 'like' ? 'LIKE' : 'ILIKE'} $${params.length} ESCAPE ''`;
    default: {
      const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[c.condition];
      return c.value === null || c.value === undefined ? 'false' : `${col.sql} ${op} ${param(c.value)}`;
    }
  }
}

/** WHERE do filtro; os valores entram em `params`. */
export function filterSql(table: DataTableInfo, filter: DataTableFilter | undefined, params: unknown[]): string {
  const f = normalizeFilter(table, filter);
  if (!f.conditions.length) return 'true';
  const parts = f.conditions.map((c) => conditionSql(table, DATA_TABLE_UNARY_CONDITIONS.has(c.condition) ? { column: c.column, condition: c.condition } : c, params));
  return `(${parts.join(f.type === 'or' ? ' OR ' : ' AND ')})`;
}

export class PgDataTableStore implements DataTableStore {
  constructor(
    private db: Db,
    /** Quem cria as tabelas pela tela (vazio quando é um fluxo). */
    private userId: string | null = null,
  ) {}

  async list(options: { name?: string; limit?: number } = {}): Promise<DataTableInfo[]> {
    const rows = await many<TableRow>(
      this.db,
      `SELECT id, name, columns, created_at, updated_at FROM data_tables
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%') ORDER BY name LIMIT $2`,
      [options.name || null, options.limit ?? null],
    );
    return rows.map(toInfo);
  }

  async get(idOrName: string, db: Queryable = this.db, lock = false): Promise<DataTableInfo> {
    const row = await one<TableRow>(
      db,
      `SELECT id, name, columns, created_at, updated_at FROM data_tables WHERE ${UUID.test(idOrName) ? 'id::text = lower($1) OR ' : ''}name = $1
       ORDER BY (name = $1) DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [idOrName],
    );
    if (!row) throw new NodeOperationError(`A tabela de dados "${idOrName}" não existe`);
    return toInfo(row);
  }

  async create(name: string, columns: DataTableColumn[]): Promise<DataTableInfo> {
    name = name.trim();
    if (!name) throw new NodeOperationError('Informe o nome da tabela');
    const valid = validateColumns(columns);
    const row = await one<TableRow>(
      this.db,
      `INSERT INTO data_tables (name, columns, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING RETURNING id, name, columns, created_at, updated_at`,
      [name, JSON.stringify(valid), this.userId],
    );
    if (!row) throw new NodeOperationError(`Já existe uma tabela chamada "${name}"`);
    return toInfo(row);
  }

  async rename(id: string, name: string): Promise<DataTableInfo> {
    const table = await this.get(id);
    name = name.trim();
    if (!name) throw new NodeOperationError('Informe o nome da tabela');
    try {
      const row = await one<TableRow>(this.db, `UPDATE data_tables SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, name, columns, created_at, updated_at`, [
        table.id,
        name,
      ]);
      return toInfo(row!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new NodeOperationError(`Já existe uma tabela chamada "${name}"`);
      throw err;
    }
  }

  /** Troca as colunas: as novas entram vazias, as removidas somem das linhas. O tipo não muda. */
  async setColumns(id: string, columns: DataTableColumn[]): Promise<DataTableInfo> {
    return transaction(this.db, async (tx) => {
      const table = await this.get(id, tx, true);
      const valid = validateColumns(columns);
      for (const c of valid) {
        const before = table.columns.find((b) => b.name === c.name);
        if (before && before.type !== c.type) throw new NodeOperationError(`O tipo da coluna "${c.name}" não pode mudar (${before.type}); crie outra coluna`);
      }
      const removed = table.columns.filter((b) => !valid.some((c) => c.name === b.name)).map((c) => c.name);
      if (removed.length) await tx.query('UPDATE data_table_rows SET data = data - $2::text[] WHERE table_id = $1', [table.id, removed]);
      const row = await one<TableRow>(tx, `UPDATE data_tables SET columns = $2, updated_at = now() WHERE id = $1 RETURNING id, name, columns, created_at, updated_at`, [
        table.id,
        JSON.stringify(valid),
      ]);
      return toInfo(row!);
    });
  }

  async delete(id: string): Promise<void> {
    const table = await this.get(id);
    await this.db.query('DELETE FROM data_tables WHERE id = $1', [table.id]);
  }

  /** Linhas da tabela, ou só as do filtro. */
  async count(id: string, filter?: DataTableFilter): Promise<number> {
    if (filter) {
      const table = await this.get(id);
      const params: unknown[] = [table.id];
      const where = filterSql(table, filter, params);
      const row = await one<{ n: string }>(this.db, `SELECT count(*) AS n FROM data_table_rows r WHERE r.table_id = $1 AND ${where}`, params);
      return Number(row?.n ?? 0);
    }
    const row = await one<{ n: string }>(this.db, 'SELECT count(*) AS n FROM data_table_rows WHERE table_id = $1', [id]);
    return Number(row?.n ?? 0);
  }

  /** Apaga as linhas pelos ids (tela); devolve os ids apagados. */
  async deleteRowIds(tableId: string, ids: number[]): Promise<number[]> {
    const rows = await many<{ id: string }>(this.db, 'DELETE FROM data_table_rows WHERE table_id = $1 AND id = ANY($2::bigint[]) RETURNING id', [tableId, ids]);
    return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
  }

  async insertRows(tableId: string, data: JsonObject[]): Promise<JsonObject[]> {
    if (!data.length) return [];
    return transaction(this.db, async (tx) => {
      // FOR UPDATE: duas execuções inserindo ao mesmo tempo não pegam o mesmo id.
      const table = await this.get(tableId, tx, true);
      const values = data.map((d) => coerceRow(table, d));
      // Contar só quando os ids já usados chegam perto do limite (as linhas nunca passam dos ids).
      const used = await one<{ n: string }>(tx, 'SELECT next_row_id - 1 AS n FROM data_tables WHERE id = $1', [table.id]);
      const total = Number(used?.n ?? 0) + values.length > MAX_ROWS_PER_TABLE ? await this.count(table.id) : 0;
      if (total + values.length > MAX_ROWS_PER_TABLE) {
        throw new NodeOperationError(`A tabela "${table.name}" passaria do limite de ${MAX_ROWS_PER_TABLE.toLocaleString('pt-BR')} linhas`);
      }
      const ids = await one<{ first: string }>(tx, 'UPDATE data_tables SET next_row_id = next_row_id + $2 WHERE id = $1 RETURNING next_row_id - $2 AS first', [
        table.id,
        values.length,
      ]);
      const first = Number(ids!.first);
      const rows = await many<DataRow>(
        tx,
        `INSERT INTO data_table_rows (table_id, id, data)
         SELECT $1, $2::bigint + ord - 1, value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS t(value, ord)
         RETURNING id, data, created_at, updated_at`,
        [table.id, first, JSON.stringify(values)],
      );
      return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => toRow(table, r));
    });
  }

  async getRows(tableId: string, query: DataTableQuery & { offset?: number }): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const params: unknown[] = [table.id];
    const where = filterSql(table, query.filter, params);
    const order = query.orderBy ? columnSql(table, query.orderBy, params).sql : 'r.id';
    const dir = query.orderDirection === 'desc' ? 'DESC' : 'ASC';
    params.push(query.limit ?? null, query.offset ?? 0);
    const rows = await many<DataRow>(
      this.db,
      `SELECT r.id, r.data, r.created_at, r.updated_at FROM data_table_rows r
       WHERE r.table_id = $1 AND ${where} ORDER BY ${order} ${dir}, r.id ${dir} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => toRow(table, r));
  }

  async updateRows(tableId: string, filter: DataTableFilter, data: JsonObject): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const values = coerceRow(table, data);
    const params: unknown[] = [table.id, JSON.stringify(values)];
    const where = filterSql(table, filter, params);
    const rows = await many<DataRow>(
      this.db,
      `UPDATE data_table_rows r SET data = r.data || $2::jsonb, updated_at = now()
       WHERE r.table_id = $1 AND ${where} RETURNING r.id, r.data, r.created_at, r.updated_at`,
      params,
    );
    return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => toRow(table, r));
  }

  async upsertRow(tableId: string, filter: DataTableFilter, data: JsonObject): Promise<JsonObject[]> {
    const updated = await this.updateRows(tableId, filter, data);
    return updated.length ? updated : this.insertRows(tableId, [data]);
  }

  async deleteRows(tableId: string, filter: DataTableFilter, dryRun = false): Promise<JsonObject[]> {
    const table = await this.get(tableId);
    const params: unknown[] = [table.id];
    const where = filterSql(table, filter, params);
    const rows = await many<DataRow>(
      this.db,
      dryRun
        ? `SELECT r.id, r.data, r.created_at, r.updated_at FROM data_table_rows r WHERE r.table_id = $1 AND ${where}`
        : `DELETE FROM data_table_rows r WHERE r.table_id = $1 AND ${where} RETURNING r.id, r.data, r.created_at, r.updated_at`,
      params,
    );
    return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => toRow(table, r));
  }
}
