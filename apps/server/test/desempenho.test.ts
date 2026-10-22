import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';
import { createDb, migrate, one, type Db } from '../src/db/db.js';
import { createRedis, ExecutionQueue } from '../src/executions/queue.js';
import { startWorker, type WorkerHandle } from '../src/executions/worker.js';
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

type Node = { id: string; name: string; type: string; parameters?: Record<string, unknown> };
const flow = (nodes: Node[], links: [string, string][] = [], settings?: Record<string, unknown>) => ({
  nodes: nodes.map((n, i) => ({ position: { x: i * 200, y: 0 }, parameters: {}, ...n })),
  connections: links.map(([from, to]) => ({ from, fromOutput: 0, to, toInput: 0 })),
  ...(settings ? { settings } : {}),
});
const start: Node = { id: 't', name: 'Início', type: 'manualTrigger' };
const nothing: Node = { id: 'n', name: 'Nada', type: 'noOp' };

describe.skipIf(!available)('Desempenho: a execução não guarda cópia do fluxo', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle | null = null;
  let redis: Redis;
  let triggers: TriggerManager;
  let admin = '';
  let folder = '';

  const config: Config = {
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    encryptionKey: parseKey('0'.repeat(64)),
    sessionTtlHours: 1,
    executionRetentionDays: 0,
    keepSuccessData: true,
    filesDirs: [],
    workerConcurrency: 4,
    runWorkerInProcess: true,
    secureCookies: false,
    trustProxy: false,
  };

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie: admin } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }

  async function until<T>(check: () => Promise<T | undefined | null | false>, what: string): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Esperei e não aconteceu: ${what}`);
  }

  async function createFlow(name: string, definition: ReturnType<typeof flow>) {
    const res = await call('POST', '/api/workflows', { name, folderId: folder, definition });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  }

  /** Executa o fluxo salvo e espera terminar com sucesso. */
  async function run(workflowId: string, payload: unknown = {}) {
    const res = await call('POST', `/api/workflows/${workflowId}/run`, payload);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body.executionId as string;
    await until(async () => (await one<{ status: string }>(db, `SELECT status FROM executions WHERE id = $1 AND status IN ('success', 'error')`, [id]))?.status, 'a execução terminar');
    return id;
  }

  /** O que está gravado na execução: a cópia do fluxo (null quando não há) e a versão. */
  const stored = async (id: string) =>
    (await one<{ copy: { nodes: { id: string }[] } | null; workflow_version: number | null; status: string }>(
      db,
      'SELECT definition AS copy, workflow_version, status FROM executions WHERE id = $1',
      [id],
    ))!;

  const shown = async (id: string) => {
    const res = await call('GET', `/api/executions/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.definition.nodes as { id: string }[]).map((n) => n.id);
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await ensureAdmin(db, { email: 'admin@teste.com', password: 'senha-inicial-123', name: 'Admin' });
    await db.query('UPDATE users SET must_change_password = false');
    redis = createRedis(REDIS_URL);
    await redis.flushdb();
    queue = new ExecutionQueue(redis);
    worker = startWorker({ db, config, redis: createRedis(REDIS_URL), subscriber: createRedis(REDIS_URL) });
    triggers = new TriggerManager({ db, config, queue });
    app = await buildApp({ db, config, queue, triggers });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@teste.com', password: 'senha-inicial-123' } });
    admin = `sa_session=${login.cookies.find((c) => c.name === 'sa_session')!.value}`;
    folder = (await call('POST', '/api/folders', { name: 'Pasta' })).body.id;
  });

  afterAll(async () => {
    await triggers?.close();
    await worker?.close();
    await queue?.close();
    redis?.disconnect();
    await app?.close();
    await db?.end();
  });

  it('a execução de uma versão salva não guarda cópia, e a tela mostra a versão que rodou', async () => {
    const v1 = flow([start]);
    const wf = await createFlow('Fluxo', v1);
    const first = await run(wf);
    expect(await stored(first)).toEqual({ copy: null, workflow_version: 1, status: 'success' });
    expect(await shown(first)).toEqual(['t']);

    // Salvar uma versão nova não muda o que a execução antiga mostra.
    const saved = await call('PUT', `/api/workflows/${wf}`, { name: 'Fluxo', folderId: folder, definition: flow([start, nothing], [['t', 'n']]), baseVersion: 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await shown(first)).toEqual(['t']);

    const second = await run(wf);
    expect(await stored(second)).toEqual({ copy: null, workflow_version: 2, status: 'success' });
    expect(await shown(second)).toEqual(['t', 'n']);

    // Executar de novo roda a versão da execução original, não a atual.
    const retry = await call('POST', `/api/executions/${first}/retry`, {});
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const retryId = retry.body.executionId as string;
    await until(async () => (await stored(retryId)).status === 'success', 'a nova execução terminar');
    expect(await stored(retryId)).toEqual({ copy: null, workflow_version: 1, status: 'success' });
    expect(await shown(retryId)).toEqual(['t']);
  });

  it('o teste do editor com o fluxo ainda não salvo guarda o que rodou', async () => {
    const wf = await createFlow('Em edição', flow([start]));
    const draft = flow([start, nothing], [['t', 'n']]);
    const id = await run(wf, { definition: draft });
    const row = await stored(id);
    expect(row.workflow_version).toBeNull();
    expect(row.copy?.nodes.map((n) => n.id)).toEqual(['t', 'n']);
    expect(await shown(id)).toEqual(['t', 'n']);
  });

  it('o subfluxo chamado por Execute Workflow também não guarda cópia', async () => {
    const child = await createFlow('Filho', flow([{ id: 'r', name: 'Recebe', type: 'executeWorkflowTrigger' }, nothing], [['r', 'n']]));
    const parent = await createFlow(
      'Pai',
      flow([start, { id: 'x', name: 'Chama', type: 'executeWorkflow', parameters: { workflowId: child } }], [['t', 'x']]),
    );
    const id = await run(parent);
    expect((await stored(id)).status).toBe('success');
    const kids = (await db.query<{ id: string }>('SELECT id FROM executions WHERE parent_execution_id = $1', [id])).rows;
    expect(kids).toHaveLength(1);
    expect(await stored(kids[0].id)).toEqual({ copy: null, workflow_version: 1, status: 'success' });
    expect(await shown(kids[0].id)).toEqual(['r', 'n']);
  });

  it('a execução antiga, que guardou a cópia, continua abrindo com ela', async () => {
    const wf = await createFlow('Antigo', flow([start]));
    const old = (await one<{ id: string }>(
      db,
      `INSERT INTO executions (workflow_id, workflow_version, mode, status, definition) VALUES ($1, 1, 'manual', 'success', $2::jsonb) RETURNING id`,
      [wf, JSON.stringify(flow([start, nothing], [['t', 'n']]))],
    ))!.id;
    expect(await shown(old)).toEqual(['t', 'n']);
  });

  it('o worker acha a definição da versão ao encerrar a execução abandonada e rodar o fluxo de erro', async () => {
    const errorFlow = await createFlow('Avisa erro', flow([{ id: 'e', name: 'Erro', type: 'errorTrigger' }]));
    const wf = await createFlow('Agendado', flow([{ id: 's', name: 'Agendamento', type: 'scheduleTrigger', parameters: { mode: 'cron', cron: '0 8 1 1 *' } }], [], { errorWorkflowId: errorFlow }));
    // Sem cópia do fluxo e de um worker que não existe mais.
    const lost = (await one<{ id: string }>(
      db,
      `INSERT INTO executions (workflow_id, workflow_version, mode, status, definition, worker_id, started_at)
       VALUES ($1, 1, 'schedule', 'running', NULL, 'worker-que-parou', now()) RETURNING id`,
      [wf],
    ))!.id;
    const restarted = startWorker({ db, config, redis: createRedis(REDIS_URL), subscriber: createRedis(REDIS_URL) });
    try {
      await until(async () => (await stored(lost)).status === 'error', 'a execução abandonada virar erro');
      const errorRun = await until(() => one<{ status: string }>(db, `SELECT status FROM executions WHERE workflow_id = $1 AND mode = 'error'`, [errorFlow]), 'o fluxo de erro rodar');
      expect(errorRun.status).toBeDefined();
    } finally {
      await restarted.close();
    }
  });
});
