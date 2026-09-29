import pg from 'pg';
import { migrations } from './migrations.js';

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function one<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await db.query<T>(sql, params);
  return res.rows[0];
}

export async function many<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function transaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await transaction(db, async (client) => {
    // Evita duas instâncias migrando ao mesmo tempo.
    await client.query('SELECT pg_advisory_xact_lock(724519)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      applied.push(m.id);
    }
  });
  return applied;
}
