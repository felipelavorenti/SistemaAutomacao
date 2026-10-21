import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';
import { createDb, migrate, one, type Db } from '../src/db/db.js';
import { createRedis, ExecutionQueue, QUEUE_NAME } from '../src/executions/queue.js';
import { cleanupOldExecutions } from '../src/executions/store.js';
import { startWorker, workerOptions, type WorkerHandle } from '../src/executions/worker.js';
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
// Agendamento que não dispara sozinho durante o teste (1º de janeiro); os disparos são feitos à mão.
const schedule: Node = { id: 's', name: 'Agendamento', type: 'scheduleTrigger', parameters: { mode: 'cron', cron: '0 8 1 1 *' } };

describe.skipIf(!available)('Correções de quebra', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle | null = null;
  let redis: Redis;
  let triggers: TriggerManager;
  /** Conexão com o nome de um worker vivo, como outro processo do Info8n rodando execuções. */
  let otherWorker: Redis;
  let slow: Server;
  let slowBase = '';
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
  const newWorker = (sweepIntervalMs?: number) => startWorker({ db, config, redis: createRedis(REDIS_URL), subscriber: createRedis(REDIS_URL), sweepIntervalMs });

  async function call(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie } });
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

  const status = async (id: string) => (await one<{ status: string; error_message: string | null }>(db, 'SELECT status, error_message FROM executions WHERE id = $1', [id]))!;

  async function createFlow(name: string, definition: ReturnType<typeof flow>) {
    const res = await call(admin, 'POST', '/api/workflows', { name, folderId: folder, definition });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  }

  /** Execução gravada direto no banco, como se um worker estivesse no meio dela. */
  async function insertExecution(
    workflowId: string,
    fields: { mode?: string; status: string; workerId?: string | null; parentId?: string; daysAgo?: number },
  ): Promise<string> {
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO executions (workflow_id, mode, status, definition, worker_id, parent_execution_id, created_at, started_at)
       SELECT id, $2, $3, definition, $4, $5, now() - make_interval(days => $6), now() - make_interval(days => $6) FROM workflows WHERE id = $1
       RETURNING id`,
      [workflowId, fields.mode ?? 'manual', fields.status, fields.workerId ?? null, fields.parentId ?? null, fields.daysAgo ?? 0],
    );
    return row!.id;
  }

  /** Dispara o agendamento de um fluxo como a fila faria, e espera o job terminar. */
  async function fireSchedule(workflowId: string) {
    const job = await queue.queue.add('scheduled', { kind: 'scheduled', workflowId });
    await until(async () => ['completed', 'failed'].includes(await job.getState()), 'o job do agendamento terminar');
  }

  const scheduledRuns = async (workflowId: string) =>
    (await db.query<{ status: string }>(`SELECT status FROM executions WHERE workflow_id = $1 AND mode = 'schedule' ORDER BY created_at`, [workflowId])).rows.map(
      (r) => r.status,
    );

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await ensureAdmin(db, { email: 'admin@teste.com', password: 'senha-inicial-123', name: 'Admin' });
    await db.query('UPDATE users SET must_change_password = false');
    redis = createRedis(REDIS_URL);
    await redis.flushdb();
    queue = new ExecutionQueue(redis);
    otherWorker = new Redis(REDIS_URL, { connectionName: `bull:${Buffer.from(QUEUE_NAME).toString('base64')}:w:outro-worker` });
    await otherWorker.ping();
    worker = newWorker();
    triggers = new TriggerManager({ db, config, queue });
    app = await buildApp({ db, config, queue, triggers });

    // API que demora para responder: deixa a execução em andamento enquanto o teste mexe no worker.
    slow = createServer((_req, res) => {
      setTimeout(() => res.end('{"ok":true}'), 3000);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    slowBase = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@teste.com', password: 'senha-inicial-123' } });
    admin = `sa_session=${login.cookies.find((c) => c.name === 'sa_session')!.value}`;
    folder = (await call(admin, 'POST', '/api/folders', { name: 'Pasta' })).body.id;
  });

  afterAll(async () => {
    await triggers?.close();
    await worker?.close();
    await queue?.close();
    redis?.disconnect();
    otherWorker?.disconnect();
    await app?.close();
    slow?.closeAllConnections();
    slow?.close();
    await db?.end();
  });

  // ---------- Q1: execução presa como "Em execução" depois de reiniciar ----------

  it('na subida, execução de um worker que parou vira erro e roda o fluxo de erro', async () => {
    const errorFlow = await createFlow('Avisa erro', flow([{ id: 'e', name: 'Erro', type: 'errorTrigger' }]));
    const scheduled = await createFlow('Agendado', flow([schedule], [], { errorWorkflowId: errorFlow }));

    const lost = await insertExecution(scheduled, { mode: 'schedule', status: 'running', workerId: 'worker-que-parou' });
    const child = await insertExecution(scheduled, { mode: 'subworkflow', status: 'running', workerId: 'worker-que-parou', parentId: lost });
    // Gravada por uma versão anterior do Info8n, sem worker_id.
    const legacy = await insertExecution(scheduled, { status: 'running', workerId: null });
    const alive = await insertExecution(scheduled, { status: 'running', workerId: 'outro-worker' });
    // Worker sem a conexão da fila (fechando, ou reconectando ao Redis), mas com o aviso de vida em dia.
    const beating = await insertExecution(scheduled, { status: 'running', workerId: 'vivo-pelo-aviso' });
    await redis.set('sa:worker:vivo-pelo-aviso', '1', 'PX', 60_000);

    // Um worker novo subindo (como depois de reiniciar o servidor).
    const restarted = newWorker();
    try {
      await until(async () => (await status(lost)).status === 'error', 'a execução abandonada virar erro');
      expect(await status(lost)).toEqual({ status: 'error', error_message: 'Execução interrompida: o servidor foi reiniciado ou o worker parou no meio dela' });
      expect((await status(child)).status).toBe('error');
      expect((await status(legacy)).status).toBe('error');
      // O outro worker continua conectado: a execução dele segue rodando.
      expect((await status(alive)).status).toBe('running');
      expect((await status(beating)).status).toBe('running');

      const errorRun = await until(
        () => one<{ status: string; input: { json: { execution: { id: string; mode: string } } }[] }>(db, `SELECT status, input FROM executions WHERE workflow_id = $1 AND mode = 'error'`, [errorFlow]),
        'o fluxo de erro rodar',
      );
      expect(errorRun.input[0].json.execution).toMatchObject({ id: lost, mode: 'schedule' });
    } finally {
      await restarted.close();
      await redis.del('sa:worker:vivo-pelo-aviso');
      await db.query(`UPDATE executions SET status = 'success' WHERE id = ANY($1::uuid[])`, [[alive, beating]]);
    }
  });

  it('o worker que ainda rodava não grava por cima de uma execução já encerrada', async () => {
    const wf = await createFlow('Encerrada por fora', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['t', 'h']]));
    const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
    await until(async () => (await status(executionId)).status === 'running', 'a execução começar');
    // Como o cancelamento de uma execução cujo worker parecia parado.
    await db.query(`UPDATE executions SET status = 'canceled', finished_at = now(), error_message = 'Cancelada por fora' WHERE id = $1`, [executionId]);
    const job = (await queue.queue.getJob(executionId))!;
    await until(async () => (await job.getState()) === 'completed', 'o worker terminar a rodada');
    expect(await status(executionId)).toEqual({ status: 'canceled', error_message: 'Cancelada por fora' });
  });

  it('job de agendamento travado (worker morreu no meio) falha em vez de rodar o fluxo de novo', async () => {
    const name = 'teste-travado';
    const q = new Queue(name, { connection: redis });
    // Trava curta, para o teste não esperar os 5 minutos de verdade.
    const opts = (id: string) => ({ ...workerOptions(config, id), lockDuration: 1000, stalledInterval: 300 });
    const connections = [createRedis(REDIS_URL), createRedis(REDIS_URL)];
    let started = 0;
    const dying = new Worker(name, () => (started++, new Promise(() => undefined)), { connection: connections[0], ...opts('morre') });
    const calls: string[] = [];
    let next: Worker | null = null;
    try {
      await q.upsertJobScheduler('wf:travado', { every: 60_000 }, { name: 'scheduled', data: { kind: 'scheduled', workflowId: 'x' } });
      await until(async () => started === 1, 'o primeiro worker pegar o job');
      await dying.close(true); // morre sem terminar nem renovar a trava

      next = new Worker(name, async (job) => void calls.push(job.id!), { connection: connections[1], ...opts('sobe') });
      const reason = await new Promise<string>((resolve) => next!.on('failed', (_job, err) => resolve(err.message)));
      expect(reason).toBe('job started more than allowable limit');
      expect(calls).toEqual([]);
      // O agendamento segue: o próximo horário continua marcado.
      expect(await q.getJobCountByTypes('delayed')).toBe(1);
    } finally {
      await next?.close();
      await q.obliterate({ force: true });
      await q.close();
      connections.forEach((c) => c.disconnect());
    }
  });

  it('execução que perdeu o job volta para a fila (na fila sem job, ou pausada sem a volta)', async () => {
    const sweeper = newWorker(200);
    try {
      const quick = await createFlow('Sem job', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }]));
      // Ficou na fila, mas o job nunca chegou ao Redis (falha entre gravar e enfileirar).
      const queued = await insertExecution(quick, { status: 'queued', daysAgo: 1 });
      await until(async () => (await status(queued)).status === 'success', 'a execução sem job rodar');

      const paused = await createFlow(
        'Espera sem volta',
        flow(
          [
            { id: 't', name: 'Início', type: 'manualTrigger' },
            { id: 'e', name: 'Esperar', type: 'wait', parameters: { resume: 'timeInterval', amount: 2, unit: 'hours' } },
          ],
          [['t', 'e']],
        ),
      );
      const { executionId } = (await call(admin, 'POST', `/api/workflows/${paused}/run`, {})).body;
      await until(async () => (await status(executionId)).status === 'waiting', 'a execução pausar');
      // O job da volta sumiu e a hora já passou (ex.: a volta falhou com o Postgres fora do ar).
      await queue.cancelResume(executionId);
      await db.query(`UPDATE executions SET wait_till = now() - interval '10 minutes' WHERE id = $1`, [executionId]);
      await until(async () => (await status(executionId)).status === 'success', 'a execução pausada voltar');

      // Pausada sem hora para voltar (espera o webhook) não é mexida.
      const webhookWait = await insertExecution(quick, { status: 'waiting', daysAgo: 1 });
      await new Promise((r) => setTimeout(r, 1000));
      expect((await status(webhookWait)).status).toBe('waiting');
      await db.query(`UPDATE executions SET status = 'canceled' WHERE id = $1`, [webhookWait]);
    } finally {
      await sweeper.close();
    }
  });

  it('cancelar uma execução que ninguém está rodando encerra na hora, com os subfluxos', async () => {
    const wf = await createFlow('Sem worker', flow([schedule]));
    const parent = await insertExecution(wf, { status: 'running', workerId: 'worker-sumido' });
    const child = await insertExecution(wf, { mode: 'subworkflow', status: 'running', workerId: 'worker-sumido', parentId: parent });
    const res = await call(admin, 'POST', `/api/executions/${parent}/cancel`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await status(parent)).toEqual({ status: 'canceled', error_message: 'Cancelada; o worker que a rodava tinha parado' });
    expect((await status(child)).status).toBe('canceled');

    // Execução de um worker vivo: só pede o cancelamento, quem roda é que encerra.
    const alive = await insertExecution(wf, { status: 'running', workerId: 'outro-worker' });
    expect((await call(admin, 'POST', `/api/executions/${alive}/cancel`)).status).toBe(200);
    expect((await status(alive)).status).toBe('running');
    await db.query(`UPDATE executions SET status = 'success' WHERE id = $1`, [alive]);

    // O worker_id é interno: não aparece na API.
    expect((await call(admin, 'GET', `/api/executions/${parent}`)).body).not.toHaveProperty('worker_id');
  });

  // ---------- Q4: limpeza em lotes ----------

  it('a limpeza apaga em lotes só as execuções que já terminaram', async () => {
    const wf = await createFlow('Histórico', flow([schedule]));
    const old = await Promise.all(['success', 'error', 'canceled', 'success', 'error'].map((s) => insertExecution(wf, { status: s, daysAgo: 40 })));
    const waiting = await insertExecution(wf, { status: 'waiting', daysAgo: 40 });
    const queued = await insertExecution(wf, { status: 'queued', daysAgo: 40 });
    const recent = await insertExecution(wf, { status: 'success', daysAgo: 2 });
    // Execução repetida a partir de uma antiga: a antiga sai e a nova fica, sem a referência.
    const retry = await one<{ id: string }>(db, `INSERT INTO executions (workflow_id, mode, status, definition, retry_of) SELECT workflow_id, 'retry', 'success', definition, id FROM executions WHERE id = $1 RETURNING id`, [old[0]]);
    for (const daysAgo of [40, 40, 40, 1]) {
      await db.query(
        `INSERT INTO db_commands (at, execution_id, node_name, db_type, operation, sql, duration_ms) VALUES (now() - make_interval(days => $1), $2, 'Banco', 'postgres', 'query', 'SELECT 1', 1)`,
        [daysAgo, old[1]],
      );
    }

    expect(await cleanupOldExecutions(db, 30, 2)).toEqual({ executions: 5, dbCommands: 3 });
    const left = (await db.query<{ id: string; retry_of: string | null }>('SELECT id, retry_of FROM executions WHERE workflow_id = $1', [wf])).rows;
    expect(left.map((r) => r.id).sort()).toEqual([waiting, queued, recent, retry!.id].sort());
    expect(left.find((r) => r.id === retry!.id)?.retry_of).toBeNull();
    expect((await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM db_commands'))!.n).toBe(1);
  });

  // ---------- Q5: agendado que demora mais que o intervalo ----------

  it('com "pular este horário", o agendado não roda enquanto o anterior não terminou', async () => {
    const skip = await createFlow('Pula se rodando', flow([schedule], [], { skipIfRunning: true }));
    const always = await createFlow('Roda sempre', flow([schedule]));
    expect((await call(admin, 'GET', `/api/workflows/${skip}`)).body.definition.settings).toEqual({ skipIfRunning: true });
    for (const id of [skip, always]) expect((await call(admin, 'POST', `/api/workflows/${id}/activate`)).status).toBe(200);

    const previous = await insertExecution(skip, { mode: 'schedule', status: 'running', workerId: 'outro-worker' });
    await insertExecution(always, { mode: 'schedule', status: 'running', workerId: 'outro-worker' });
    await fireSchedule(skip);
    await fireSchedule(always);
    expect(await scheduledRuns(skip)).toEqual(['running']);
    await until(async () => (await scheduledRuns(always)).join() === 'running,success', 'o fluxo sem a opção rodar mesmo assim');

    // Pausada num Wait também conta como em andamento.
    await db.query(`UPDATE executions SET status = 'waiting' WHERE id = $1`, [previous]);
    await fireSchedule(skip);
    expect(await scheduledRuns(skip)).toEqual(['waiting']);

    // A anterior terminou: o próximo horário roda.
    await db.query(`UPDATE executions SET status = 'success' WHERE id = $1`, [previous]);
    await fireSchedule(skip);
    await until(async () => (await scheduledRuns(skip)).join() === 'success,success', 'o próximo horário rodar');

    await db.query(`UPDATE executions SET status = 'success' WHERE workflow_id = $1 AND status = 'running'`, [always]);

    // Execução única nunca é pulada: o fluxo se desativa ao disparar e o horário não voltaria.
    await db.query(`UPDATE executions SET status = 'running', worker_id = 'outro-worker' WHERE id = $1`, [previous]);
    const once = await queue.queue.add('scheduled', { kind: 'scheduled', workflowId: skip, once: Date.now() });
    await until(async () => ['completed', 'failed'].includes(await once.getState()), 'o job da execução única terminar');
    expect(await scheduledRuns(skip)).toEqual(['running', 'success', 'success']);
    expect((await call(admin, 'GET', `/api/workflows/${skip}`)).body.active).toBe(false);
    await db.query(`UPDATE executions SET status = 'success' WHERE id = $1`, [previous]);

    // Dois horários pegos ao mesmo tempo: só um passa.
    const both = await createFlow('Dois de uma vez', flow([schedule, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['s', 'h']], { skipIfRunning: true }));
    expect((await call(admin, 'POST', `/api/workflows/${both}/activate`)).status).toBe(200);
    await Promise.all([queue.queue.add('scheduled', { kind: 'scheduled', workflowId: both }), queue.queue.add('scheduled', { kind: 'scheduled', workflowId: both })]);
    await until(async () => (await scheduledRuns(both)).length === 1, 'um dos dois horários rodar');
    // A execução agendada nasce rodando, já com o worker: se ele parar, a procura de abandonadas a acha.
    expect(await one(db, `SELECT status, worker_id IS NOT NULL AS owned FROM executions WHERE workflow_id = $1`, [both])).toEqual({ status: 'running', owned: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(await scheduledRuns(both)).toHaveLength(1);
    await until(async () => (await scheduledRuns(both)).join() === 'success', 'a execução terminar');
  });

  // ---------- Q1: desligar o servidor no meio de uma execução ----------

  it('desligar o worker no meio marca a execução como interrompida', async () => {
    const wf = await createFlow('Demorado', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['t', 'h']]));
    const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
    await until(async () => (await status(executionId)).status === 'running', 'a execução começar');
    const { worker_id } = (await one<{ worker_id: string }>(db, 'SELECT worker_id FROM executions WHERE id = $1', [executionId]))!;
    expect(await redis.exists(`sa:worker:${worker_id}`)).toBe(1);
    await worker!.close();
    worker = null;
    expect(await status(executionId)).toEqual({ status: 'error', error_message: 'Execução interrompida porque o servidor foi desligado' });
    // Desligado, o worker apaga o aviso de vida: as execuções dele param de contar como em andamento.
    expect(await redis.exists(`sa:worker:${worker_id}`)).toBe(0);
  });
});
