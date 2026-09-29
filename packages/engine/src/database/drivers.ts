import { createHash } from 'node:crypto';
import mssql from 'mssql';
import oracledb from 'oracledb';
import pg from 'pg';
import type { ConnectionData } from '../node-types.js';
import type { JsonObject, JsonValue } from '../types.js';
import { checkIdentifier, compileNamedParams, toDbValue, type Dialect } from './params.js';

export const DATABASE_CONNECTION_TYPES: Dialect[] = ['postgres', 'mssql', 'oracle'];

export type ParamDirection = 'in' | 'out' | 'inout';
export type ParamType = 'text' | 'int' | 'decimal' | 'date' | 'boolean' | 'cursor';

export interface ProcedureParam {
  name: string;
  direction: ParamDirection;
  type: ParamType;
  value: JsonValue;
}

export interface DbResult {
  rows: JsonObject[];
  rowsAffected: number | null;
  /** Parâmetros de saída de procedures (cursores já lidos como listas de linhas). */
  outputs?: JsonObject;
  /** Conjuntos de resultados extras (SQL Server devolve vários). */
  recordsets?: JsonObject[][];
}

export interface DbClient {
  readonly dialect: Dialect;
  query(sql: string, params: Record<string, JsonValue>): Promise<DbResult>;
  procedure(name: string, params: ProcedureParam[]): Promise<DbResult>;
  close(): Promise<void>;
}

const MAX_CURSOR_ROWS = 100_000;

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

function timeoutMs(data: JsonObject): number {
  const seconds = Number(data.queryTimeoutSeconds);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
}

function port(data: JsonObject, fallback: number): number {
  const n = Number(data.port);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Converte o que os drivers devolvem (Date, Buffer, bigint) para JSON. */
export function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJson(v);
    return out;
  }
  return String(value);
}

const rowsToJson = (rows: unknown[] | undefined): JsonObject[] => (rows ?? []).map((r) => toJson(r) as JsonObject);

// ---------- Postgres ----------

class PostgresClient implements DbClient {
  readonly dialect = 'postgres' as const;
  private pool: pg.Pool;

  constructor(data: JsonObject) {
    const ssl = String(data.ssl ?? 'disable');
    this.pool = new pg.Pool({
      host: String(data.host ?? ''),
      port: port(data, 5432),
      database: String(data.database ?? ''),
      user: String(data.user ?? ''),
      password: String(data.password ?? ''),
      ssl: ssl === 'require' ? true : ssl === 'no-verify' ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 15_000,
      statement_timeout: timeoutMs(data),
      application_name: 'sistema-automacao',
    });
    this.pool.on('error', () => undefined);
  }

  async query(sql: string, params: Record<string, JsonValue>): Promise<DbResult> {
    const compiled = compileNamedParams(sql, 'postgres');
    const result = await this.pool.query({ text: compiled.sql, values: compiled.names.map((n) => toDbValue(params[n])) });
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    return { rows: rowsToJson(last.rows), rowsAffected: last.command === 'SELECT' ? null : (last.rowCount ?? null) };
  }

  async procedure(name: string, params: ProcedureParam[]): Promise<DbResult> {
    const proc = checkIdentifier(name, 'Nome da procedure');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const values = params.map((p) => (p.direction === 'out' ? null : toDbValue(p.value)));
      const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
      const result = await client.query({ text: `CALL ${proc}(${placeholders})`, values });
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      const outputs: JsonObject = {};
      for (const p of params) {
        if (p.direction === 'in') continue;
        const value = row[p.name] ?? row[p.name.toLowerCase()];
        if (p.type === 'cursor' && typeof value === 'string') {
          const cursor = await client.query(`FETCH ${MAX_CURSOR_ROWS} FROM "${value.replace(/"/g, '""')}"`);
          outputs[p.name] = rowsToJson(cursor.rows);
        } else {
          outputs[p.name] = toJson(value);
        }
      }
      await client.query('COMMIT');
      return { rows: [], rowsAffected: null, outputs };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

// ---------- SQL Server ----------

const MSSQL_TYPES: Record<Exclude<ParamType, 'cursor'>, () => mssql.ISqlType> = {
  text: () => mssql.NVarChar(mssql.MAX),
  int: () => mssql.BigInt(),
  decimal: () => mssql.Decimal(38, 10),
  date: () => mssql.DateTime2(),
  boolean: () => mssql.Bit(),
};

class SqlServerClient implements DbClient {
  readonly dialect = 'mssql' as const;
  private pool: Promise<mssql.ConnectionPool>;

  constructor(data: JsonObject) {
    const instance = String(data.instance ?? '').trim();
    const config: mssql.config = {
      server: String(data.host ?? ''),
      database: String(data.database ?? '') || undefined,
      user: String(data.user ?? ''),
      password: String(data.password ?? ''),
      requestTimeout: timeoutMs(data),
      connectionTimeout: 15_000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: String(data.encrypt ?? 'false') === 'true',
        trustServerCertificate: String(data.trustServerCertificate ?? 'true') === 'true',
        instanceName: instance || undefined,
        appName: 'sistema-automacao',
      },
    };
    if (!instance) config.port = port(data, 1433);
    const pool = new mssql.ConnectionPool(config);
    pool.on('error', () => undefined);
    this.pool = pool.connect();
    this.pool.catch(() => undefined);
  }

  async query(sql: string, params: Record<string, JsonValue>): Promise<DbResult> {
    const compiled = compileNamedParams(sql, 'mssql');
    const request = (await this.pool).request();
    for (const name of compiled.names) request.input(name, toDbValue(params[name]));
    const result = await request.query(compiled.sql);
    const sets = (result.recordsets as unknown as unknown[][]) ?? [];
    const affected = result.rowsAffected.reduce((a, b) => a + b, 0);
    return {
      rows: rowsToJson(sets[0]),
      rowsAffected: sets.length ? null : affected,
      recordsets: sets.length > 1 ? sets.slice(1).map(rowsToJson) : undefined,
    };
  }

  async procedure(name: string, params: ProcedureParam[]): Promise<DbResult> {
    const proc = checkIdentifier(name, 'Nome da procedure');
    const request = (await this.pool).request();
    for (const p of params) {
      if (p.type === 'cursor') throw new Error('SQL Server não usa parâmetros do tipo cursor; os resultados da procedure já voltam como linhas');
      const type = MSSQL_TYPES[p.type]();
      if (p.direction === 'in') request.input(p.name, type, toDbValue(p.value));
      else request.output(p.name, type, p.direction === 'inout' ? toDbValue(p.value) : null);
    }
    const result = await request.execute(proc);
    const sets = (result.recordsets as unknown as unknown[][]) ?? [];
    return {
      rows: rowsToJson(sets[0]),
      rowsAffected: result.rowsAffected.reduce((a, b) => a + b, 0),
      outputs: toJson(result.output ?? {}) as JsonObject,
      recordsets: sets.length > 1 ? sets.slice(1).map(rowsToJson) : undefined,
    };
  }

  async close(): Promise<void> {
    await (await this.pool.catch(() => null))?.close();
  }
}

// ---------- Oracle ----------

const ORACLE_TYPES: Record<ParamType, oracledb.DbType> = {
  text: oracledb.STRING,
  int: oracledb.NUMBER,
  decimal: oracledb.NUMBER,
  date: oracledb.DATE,
  boolean: oracledb.DB_TYPE_BOOLEAN,
  cursor: oracledb.CURSOR,
};
const ORACLE_DIR: Record<ParamDirection, number> = { in: oracledb.BIND_IN, out: oracledb.BIND_OUT, inout: oracledb.BIND_INOUT };

class OracleClient implements DbClient {
  readonly dialect = 'oracle' as const;
  private pool: Promise<oracledb.Pool>;
  private callTimeout: number;

  constructor(data: JsonObject) {
    const connectString = String(data.connectString ?? '').trim() || `${String(data.host ?? '')}:${port(data, 1521)}/${String(data.serviceName ?? '')}`;
    this.callTimeout = timeoutMs(data);
    this.pool = oracledb.createPool({
      user: String(data.user ?? ''),
      password: String(data.password ?? ''),
      connectString,
      poolMin: 0,
      poolMax: 5,
      poolIncrement: 1,
      poolTimeout: 60,
      connectTimeout: 15,
    });
    this.pool.catch(() => undefined);
  }

  private async withConnection<T>(fn: (c: oracledb.Connection) => Promise<T>): Promise<T> {
    const connection = await (await this.pool).getConnection();
    connection.callTimeout = this.callTimeout;
    try {
      return await fn(connection);
    } finally {
      await connection.close();
    }
  }

  query(sql: string, params: Record<string, JsonValue>): Promise<DbResult> {
    const compiled = compileNamedParams(sql.trim().replace(/;\s*$/, (m) => (/\bend\s*;\s*$/i.test(sql.trim()) ? m : '')), 'oracle');
    const binds = Object.fromEntries(compiled.names.map((n) => [n, toDbValue(params[n])]));
    return this.withConnection(async (c) => {
      const result = await c.execute(compiled.sql, binds as oracledb.BindParameters, { autoCommit: true, maxRows: 0 });
      return { rows: rowsToJson(result.rows as unknown[] | undefined), rowsAffected: result.rows ? null : (result.rowsAffected ?? null) };
    });
  }

  procedure(name: string, params: ProcedureParam[]): Promise<DbResult> {
    const proc = checkIdentifier(name, 'Nome da procedure');
    const binds: Record<string, oracledb.BindParameter> = {};
    for (const p of params) {
      const bind: oracledb.BindParameter = { dir: p.type === 'cursor' ? oracledb.BIND_OUT : ORACLE_DIR[p.direction], type: ORACLE_TYPES[p.type] };
      if (p.direction !== 'out' && p.type !== 'cursor') bind.val = toDbValue(p.value) as oracledb.BindParameter['val'];
      if (p.type === 'text' && p.direction !== 'in') bind.maxSize = 32767;
      binds[p.name] = bind;
    }
    const call = `BEGIN ${proc}(${params.map((p) => `${p.name} => :${p.name}`).join(', ')}); END;`;
    return this.withConnection(async (c) => {
      const result = await c.execute(call, binds, { autoCommit: true });
      const outBinds = (result.outBinds ?? {}) as Record<string, unknown>;
      const outputs: JsonObject = {};
      for (const p of params) {
        if (p.direction === 'in' && p.type !== 'cursor') continue;
        const value = outBinds[p.name];
        if (p.type === 'cursor' && value) {
          const rs = value as oracledb.ResultSet<unknown>;
          outputs[p.name] = rowsToJson(await rs.getRows(MAX_CURSOR_ROWS));
          await rs.close();
        } else {
          outputs[p.name] = toJson(value);
        }
      }
      return { rows: [], rowsAffected: null, outputs };
    });
  }

  async close(): Promise<void> {
    await (await this.pool.catch(() => null))?.close(0);
  }
}

export function createDbClient(connection: ConnectionData): DbClient {
  switch (connection.type) {
    case 'postgres':
      return new PostgresClient(connection.data);
    case 'mssql':
      return new SqlServerClient(connection.data);
    case 'oracle':
      return new OracleClient(connection.data);
    default:
      throw new Error(`A conexão escolhida não é de banco de dados (${connection.type})`);
  }
}

/**
 * Guarda um pool por conexão cadastrada. Se os dados da conexão mudarem, o pool
 * antigo é fechado; pools parados por 10 minutos também são fechados.
 */
export class DatabasePools {
  private pools = new Map<string, { key: string; client: DbClient; lastUsed: number }>();
  private timer: NodeJS.Timeout;

  constructor(private idleMs = 10 * 60_000) {
    this.timer = setInterval(() => void this.closeIdle(), 60_000);
    this.timer.unref();
  }

  get(connection: ConnectionData): DbClient {
    const key = createHash('sha256').update(JSON.stringify([connection.type, connection.data])).digest('hex');
    const current = this.pools.get(connection.id);
    if (current && current.key === key) {
      current.lastUsed = Date.now();
      return current.client;
    }
    if (current) void current.client.close().catch(() => undefined);
    const client = createDbClient(connection);
    this.pools.set(connection.id, { key, client, lastUsed: Date.now() });
    return client;
  }

  private async closeIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.pools) {
      if (now - entry.lastUsed < this.idleMs) continue;
      this.pools.delete(id);
      await entry.client.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    const all = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(all.map((e) => e.client.close().catch(() => undefined)));
  }
}

/** Abre uma conexão, roda um SELECT simples e fecha. Usado pelo botão "Testar conexão". */
export async function testDatabaseConnection(connection: ConnectionData): Promise<void> {
  const client = createDbClient(connection);
  try {
    await client.query(client.dialect === 'oracle' ? 'SELECT 1 AS ok FROM dual' : 'SELECT 1 AS ok', {});
  } finally {
    await client.close().catch(() => undefined);
  }
}
