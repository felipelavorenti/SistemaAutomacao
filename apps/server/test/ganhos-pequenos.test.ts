import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NodeRun } from '@sa/engine';
import { buildApp } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';
import { createDb, migrate, one, type Db } from '../src/db/db.js';
import { createRedis, ExecutionQueue } from '../src/executions/queue.js';
import { trimRuns } from '../src/executions/store.js';
import { ensureAdmin } from '../src/lib/auth.js';
import { TriggerManager } from '../src/triggers/manager.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/automacao_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await reachable();

const run = (n: number, bytes = 10): NodeRun =>
  ({ nodeId: `n${n}`, nodeName: `Nó ${n}`, nodeType: 'noOp', input: [[{ json: { texto: 'a'.repeat(bytes) } }]], output: [[{ json: { texto: 'b'.repeat(bytes) } }]] }) as unknown as NodeRun;

describe('Ganhos pequenos de desempenho', () => {
  it('o tamanho de cada passagem é medido uma vez só ao gravar o log', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const runs = Array.from({ length: 20 }, (_, i) => run(i));
      expect(trimRuns(runs)).toEqual(runs);
      expect(stringify).toHaveBeenCalledTimes(20);
    } finally {
      stringify.mockRestore();
    }
  });

  it('a passagem grande demais continua cortada, com o tamanho de antes', () => {
    const big = run(1, 200_000);
    const [cut] = trimRuns([big]);
    expect(cut.input).toEqual([[{ json: { _truncado: true, itens: 1, bytes: Buffer.byteLength(JSON.stringify({ input: big.input, output: big.output })) } }]]);
    expect(cut.output).toEqual([[{ json: { _truncado: true, itens: 1, bytes: expect.any(Number) } }]]);
  });

  it('passado o limite da execução, as passagens seguintes guardam só a contagem', () => {
    // 100 passagens de uns 250 KB cada passam dos 16 MB da execução.
    const runs = Array.from({ length: 100 }, (_, i) => run(i, 120_000));
    const out = trimRuns(runs);
    const kept = out.filter((r) => !JSON.stringify(r.input).includes('_naoGuardado') && !JSON.stringify(r.input).includes('_truncado'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(100);
    expect(out.at(-1)!.input).toEqual([[{ json: { _naoGuardado: true, itens: 1 } }]]);
  });
});

describe.skipIf(!available)('Ganhos pequenos de desempenho: banco', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let triggers: TriggerManager;
  let admin = '';

  const config: Config = {
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    encryptionKey: parseKey('0'.repeat(64)),
    sessionTtlHours: 1,
    executionRetentionDays: 0,
    keepSuccessData: false,
    filesDirs: [],
    workerConcurrency: 1,
    runWorkerInProcess: false,
    secureCookies: false,
    trustProxy: false,
  };

  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@teste.com', password: 'senha-inicial-123' } });
    return `sa_session=${res.cookies.find((c) => c.name === 'sa_session')!.value}`;
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await ensureAdmin(db, { email: 'admin@teste.com', password: 'senha-inicial-123', name: 'Admin' });
    await db.query('UPDATE users SET must_change_password = false');
    const redis = createRedis(REDIS_URL);
    queue = new ExecutionQueue(redis);
    triggers = new TriggerManager({ db, config, queue });
    app = await buildApp({ db, config, queue, triggers });
    admin = await login();
  });

  afterAll(async () => {
    await triggers?.close();
    await queue?.close();
    await app?.close();
    await db?.end();
  });

  it('o último uso do token de API só é regravado depois de um minuto', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/auth/tokens', payload: { name: 'Integração' }, headers: { cookie: admin } });
    expect(created.statusCode).toBe(200);
    const { id, token } = created.json();
    const bearer = { authorization: `Bearer ${token}` };
    const lastUsed = async () => (await one<{ at: Date | null }>(db, 'SELECT last_used_at AS at FROM api_tokens WHERE id = $1', [id]))!.at;
    const call = async () => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer })).statusCode;

    expect(await lastUsed()).toBeNull();
    expect(await call()).toBe(200);
    const first = await lastUsed();
    expect(first).toBeInstanceOf(Date);

    // Chamadas logo em seguida não regravam.
    await new Promise((r) => setTimeout(r, 30));
    expect(await call()).toBe(200);
    expect(await call()).toBe(200);
    expect(await lastUsed()).toEqual(first);

    // Passado um minuto, a próxima chamada grava de novo.
    await db.query("UPDATE api_tokens SET last_used_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    const old = await lastUsed();
    expect(await call()).toBe(200);
    expect((await lastUsed())!.getTime()).toBeGreaterThan(old!.getTime() + 60_000);

    // O token vencido ou revogado continua sem valer (e sem gravar nada).
    await db.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute', last_used_at = NULL WHERE id = $1", [id]);
    expect(await call()).toBe(401);
    expect(await lastUsed()).toBeNull();
  });

  it('a sessão vencida sai da tabela no próximo login, e as que valem ficam', async () => {
    const user = (await one<{ id: string }>(db, 'SELECT id FROM users LIMIT 1'))!;
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('vencida-1', $1, now() - interval '1 hour'), ('vencida-2', $1, now() - interval '3 days')`, [user.id]);
    const before = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM sessions'))!.n;
    const cookie = await login();
    const left = (await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash);
    expect(left).not.toContain('vencida-1');
    expect(left).not.toContain('vencida-2');
    // A sessão do beforeAll e a nova continuam valendo.
    expect(left).toHaveLength(before - 2 + 1);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: admin } })).statusCode).toBe(200);
  });
});
