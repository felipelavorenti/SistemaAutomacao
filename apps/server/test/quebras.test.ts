import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';
import { createDb, migrate, one, type Db } from '../src/db/db.js';
import { ExecutionEvents } from '../src/executions/events.js';
import { CANCEL_CHANNEL, createRedis, ExecutionQueue, QUEUE_NAME } from '../src/executions/queue.js';
import { cleanupOldExecutions } from '../src/executions/store.js';
import { joblessMs, startWorker, workerOptions, type WorkerHandle } from '../src/executions/worker.js';
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
    fields: { mode?: string; status: string; workerId?: string | null; parentId?: string; daysAgo?: number; notStarted?: boolean },
  ): Promise<string> {
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO executions (workflow_id, mode, status, definition, worker_id, parent_execution_id, created_at, queued_at, started_at)
       SELECT id, $2, $3, definition, $4, $5, now() - make_interval(days => $6), now() - make_interval(days => $6),
         CASE WHEN NOT $7 THEN now() - make_interval(days => $6) END
       FROM workflows WHERE id = $1
       RETURNING id`,
      [workflowId, fields.mode ?? 'manual', fields.status, fields.workerId ?? null, fields.parentId ?? null, fields.daysAgo ?? 0, fields.notStarted ?? false],
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
    const errorFlow = await createFlow('Avisa fila', flow([{ id: 'e', name: 'Erro', type: 'errorTrigger' }]));
    const sweeper = newWorker(200);
    const listener = createRedis(REDIS_URL);
    const events = new ExecutionEvents(listener);
    try {
      const quick = await createFlow('Sem job', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }], [], { errorWorkflowId: errorFlow }));
      const queuedAgo = (id: string, minutes: number) => db.query(`UPDATE executions SET queued_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);
      // Nenhum job dela chegou à fila (quem a criou parou antes de pô-la na fila): vira erro, porque quem
      // pediu pode ter tentado de novo.
      const neverQueued = await insertExecution(quick, { mode: 'webhook', status: 'queued', notStarted: true });
      await queuedAgo(neverQueued, 5);
      // Voltou de uma pausa (webhook aceito) há pouco, criada há um dia, e o job da volta não chegou ao Redis: roda.
      const resumed = await insertExecution(quick, { status: 'queued', daysAgo: 1 });
      await queuedAgo(resumed, 5);
      // Na fila sem job há mais de 1 hora (de uma versão anterior, por exemplo): vira erro, não roda tão tarde.
      const old = await insertExecution(quick, { mode: 'webhook', status: 'queued', daysAgo: 1 });
      // Gravada antes da coluna queued_at: vale a created_at.
      const legacy = await insertExecution(quick, { status: 'queued', daysAgo: 1 });
      await db.query(`UPDATE executions SET queued_at = NULL WHERE id = $1`, [legacy]);
      const sub = await events.subscribe(old);
      const subNever = await events.subscribe(neverQueued);
      await until(async () => (await status(resumed)).status === 'success', 'a execução retomada sem job rodar');
      const message = 'Execução interrompida: ficou mais de 1 hora na fila sem o job que a rodaria';
      await until(async () => (await status(old)).status === 'error', 'a execução antiga virar erro');
      expect(await status(old)).toEqual({ status: 'error', error_message: message });
      await until(async () => (await status(legacy)).status === 'error', 'a execução sem queued_at virar erro');
      expect(await status(legacy)).toEqual({ status: 'error', error_message: message });
      const neverMessage = 'Execução interrompida: o job dela não chegou à fila (o servidor parou antes de pô-la na fila, ou o Redis perdeu o job)';
      await until(async () => (await status(neverQueued)).status === 'error', 'a execução sem job nenhum virar erro');
      expect(await status(neverQueued)).toEqual({ status: 'error', error_message: neverMessage });
      // Quem esperava a resposta do webhook fica sabendo, e o fluxo de erro roda.
      expect(await sub.next((e) => e.type === 'finished', 2000)).toMatchObject({ type: 'finished', status: 'error', error: message });
      expect(await subNever.next((e) => e.type === 'finished', 2000)).toMatchObject({ type: 'finished', status: 'error', error: neverMessage });
      await sub.close();
      await subNever.close();
      const errorRuns = await until(async () => {
        const rows = (await db.query<{ input: { json: { execution: { id: string } } }[] }>(`SELECT input FROM executions WHERE workflow_id = $1 AND mode = 'error'`, [errorFlow])).rows;
        return rows.length === 2 && rows;
      }, 'o fluxo de erro rodar para as duas');
      expect(errorRuns.map((r) => r.input[0].json.execution.id).sort()).toEqual([old, neverQueued].sort());

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
      const { wait_till } = (await one<{ wait_till: Date }>(db, 'SELECT wait_till FROM executions WHERE id = $1', [executionId]))!;
      // O worker grava a pausa antes de pôr o job da volta na fila.
      await until(() => queue.queue.getJob(`resume-${executionId}-${wait_till.getTime()}`), 'o job da volta');
      await queue.cancelResume(executionId, wait_till);
      await db.query(`UPDATE executions SET wait_till = now() - interval '10 minutes' WHERE id = $1`, [executionId]);
      await until(async () => (await status(executionId)).status === 'success', 'a execução pausada voltar');

      // Pausada sem hora para voltar (espera o webhook) não é mexida.
      const webhookWait = await insertExecution(quick, { status: 'waiting', daysAgo: 1 });
      await new Promise((r) => setTimeout(r, 1000));
      expect((await status(webhookWait)).status).toBe('waiting');
      await db.query(`UPDATE executions SET status = 'canceled' WHERE id = $1`, [webhookWait]);
    } finally {
      listener.disconnect();
      await sweeper.close();
    }
  });

  it('job que falhou antes de a execução começar (banco fora do ar) não perde a execução: ela roda depois', async () => {
    const wf = await createFlow('Banco caiu', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }]));
    // Só um worker, cujo banco falha na hora de pegar a execução (como numa reinicialização do Postgres).
    await worker!.close();
    let outage = true;
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === 'query') {
          return (sql: unknown, ...rest: unknown[]) =>
            outage && typeof sql === 'string' && sql.includes("SET status = 'running'")
              ? Promise.reject(new Error('Connection terminated unexpectedly'))
              : (target.query as (...a: unknown[]) => unknown).call(target, sql, ...rest);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    worker = startWorker({ db: flaky, config, redis: createRedis(REDIS_URL), subscriber: createRedis(REDIS_URL), sweepIntervalMs: 200 });
    try {
      const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
      const job = await until(() => queue.queue.getJob(executionId), 'o job entrar na fila');
      await until(async () => (await job.getState()) === 'failed', 'o job falhar');
      outage = false;
      // Não vira erro: nada dela rodou, e quem pediu ouviu que ela foi aceita.
      expect(await status(executionId)).toEqual({ status: 'queued', error_message: null });
      // Passados os minutos de folga, a procura de execuções sem job a põe de novo na fila. Vale mesmo que
      // ela já estivesse na fila havia mais de 1 hora (atrás de outras): conta a partir da falha do job.
      await db.query(`UPDATE executions SET queued_at = now() - interval '2 hours' WHERE id = $1`, [executionId]);
      await until(async () => (await status(executionId)).status === 'success', 'a execução rodar');
    } finally {
      await worker.close();
      worker = newWorker();
    }
  });

  it('dois Waits com o mesmo limite "Numa data e hora": a segunda pausa também volta na hora', async () => {
    const at = new Date(Date.now() + 1500).toISOString();
    const approval = (id: string, name: string): Node => ({
      id,
      name,
      type: 'wait',
      parameters: { resume: 'webhook', limitWaitTime: true, limitType: 'atSpecifiedTime', maxDateAndTime: at },
    });
    const wf = await createFlow(
      'Mesmo limite',
      flow(
        [{ id: 't', name: 'Início', type: 'manualTrigger' }, approval('a', 'Aprovação 1'), approval('b', 'Aprovação 2')],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
    );
    const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
    await until(async () => (await status(executionId)).status === 'waiting', 'a primeira pausa');
    // Na hora, o job da primeira pausa a retoma; a segunda pausa, com a mesma hora já vencida, volta no mesmo job.
    await until(async () => (await status(executionId)).status === 'success', 'as duas pausas voltarem');
  });

  it('cancelar uma execução que ninguém está rodando encerra na hora, com os subfluxos', async () => {
    const wf = await createFlow('Sem worker', flow([schedule]));
    const parent = await insertExecution(wf, { status: 'running', workerId: 'worker-sumido' });
    const child = await insertExecution(wf, { mode: 'subworkflow', status: 'running', workerId: 'worker-sumido', parentId: parent });
    // Quem chamou por webhook e espera a resposta fica sabendo do cancelamento (o worker parado não avisaria).
    const listener = createRedis(REDIS_URL);
    const events = new ExecutionEvents(listener);
    try {
      const sub = await events.subscribe(parent);
      const res = await call(admin, 'POST', `/api/executions/${parent}/cancel`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await sub.next((e) => e.type === 'finished', 2000)).toMatchObject({ type: 'finished', status: 'canceled' });
      await sub.close();
      expect(await status(parent)).toEqual({ status: 'canceled', error_message: 'Cancelada; o worker que a rodava tinha parado' });
      expect((await status(child)).status).toBe('canceled');

      // Na fila: o worker não vai pegá-la, então o aviso também sai do cancelamento.
      const queued = await insertExecution(wf, { status: 'queued', notStarted: true });
      const subQueued = await events.subscribe(queued);
      expect((await call(admin, 'POST', `/api/executions/${queued}/cancel`)).status).toBe(200);
      expect(await subQueued.next((e) => e.type === 'finished', 2000)).toMatchObject({ type: 'finished', status: 'canceled' });
      await subQueued.close();

      // Um worker a pega no instante do cancelamento: o pedido de cancelar vai para ele.
      const claimed = await insertExecution(wf, { status: 'queued', notStarted: true });
      const cancels: string[] = [];
      const cancelListener = createRedis(REDIS_URL);
      await cancelListener.subscribe(CANCEL_CHANNEL);
      cancelListener.on('message', (_channel, executionId) => cancels.push(executionId));
      const query = db.query.bind(db);
      db.query = (async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === 'string' && sql.includes("'Cancelada antes de começar'")) {
          await query(`UPDATE executions SET status = 'running', worker_id = 'outro-worker' WHERE id = $1`, [claimed]);
        }
        return (query as (...a: unknown[]) => unknown)(sql, ...rest);
      }) as typeof db.query;
      try {
        expect((await call(admin, 'POST', `/api/executions/${claimed}/cancel`)).status).toBe(200);
      } finally {
        db.query = query;
      }
      await until(async () => cancels.includes(claimed), 'o pedido de cancelar chegar ao worker');
      cancelListener.disconnect();
      await db.query(`UPDATE executions SET status = 'canceled' WHERE id = $1`, [claimed]);

      // Esperando, e uma volta da pausa a tira da espera no instante do cancelamento: ela é cancelada na fila.
      const resuming = await insertExecution(wf, { status: 'waiting' });
      db.query = (async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === 'string' && sql.includes("'Cancelada enquanto esperava'")) {
          await query(`UPDATE executions SET status = 'queued' WHERE id = $1`, [resuming]);
        }
        return (query as (...a: unknown[]) => unknown)(sql, ...rest);
      }) as typeof db.query;
      try {
        expect((await call(admin, 'POST', `/api/executions/${resuming}/cancel`)).status).toBe(200);
      } finally {
        db.query = query;
      }
      expect(await status(resuming)).toEqual({ status: 'canceled', error_message: 'Cancelada antes de começar' });
    } finally {
      listener.disconnect();
    }

    // Execução de um worker vivo: só pede o cancelamento, quem roda é que encerra. O pedido fica gravado
    // nela e nos subfluxos que ela está rodando.
    const alive = await insertExecution(wf, { status: 'running', workerId: 'outro-worker' });
    const aliveChild = await insertExecution(wf, { mode: 'subworkflow', status: 'running', workerId: 'outro-worker', parentId: alive });
    expect((await call(admin, 'POST', `/api/executions/${alive}/cancel`)).status).toBe(200);
    expect((await status(alive)).status).toBe('running');
    const flags = await db.query<{ id: string; cancel_requested: boolean }>('SELECT id, cancel_requested FROM executions WHERE id = ANY($1::uuid[])', [[alive, aliveChild]]);
    expect(flags.rows.every((r) => r.cancel_requested)).toBe(true);
    await db.query(`UPDATE executions SET status = 'success' WHERE id = ANY($1::uuid[])`, [[alive, aliveChild]]);

    // O worker_id é interno: não aparece na API.
    expect((await call(admin, 'GET', `/api/executions/${parent}`)).body).not.toHaveProperty('worker_id');
  });

  it('cancelar enquanto ela roda, com o aviso chegando depois do último nó: ela fica cancelada, não esperando', async () => {
    const wf = await createFlow(
      'Aprovação rápida',
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'w', name: 'Aprovação', type: 'wait', parameters: { resume: 'webhook', limitWaitTime: true, resumeAmount: 2, resumeUnit: 'hours' } },
        ],
        [['t', 'w']],
      ),
    );
    // O cancelamento chega entre o fim dos nós e a gravação da pausa: o aviso pelo Redis já não para nada.
    const query = db.query.bind(db);
    let cancel: Promise<{ status: number }> | null = null;
    db.query = (async (sql: unknown, ...rest: unknown[]) => {
      if (!cancel && typeof sql === 'string' && sql.includes('RETURNING status') && sql.includes('cancel_requested THEN')) {
        const id = (rest[0] as string[])[0];
        const owner = await query<{ workflow_id: string }>('SELECT workflow_id FROM executions WHERE id = $1', [id]);
        if (owner.rows[0]?.workflow_id === wf) {
          cancel = call(admin, 'POST', `/api/executions/${id}/cancel`);
          await cancel;
        }
      }
      return (query as (...a: unknown[]) => unknown)(sql, ...rest);
    }) as typeof db.query;
    let target = '';
    try {
      target = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body.executionId;
      await until(async () => !['queued', 'running'].includes((await status(target)).status), 'a execução terminar');
    } finally {
      db.query = query;
    }
    expect((await cancel!).status).toBe(200);
    expect(await status(target)).toEqual({ status: 'canceled', error_message: 'Execução cancelada' });
    const row = (await one<{ wait_till: Date | null; resume_state: Buffer | null }>(db, 'SELECT wait_till, resume_state FROM executions WHERE id = $1', [target]))!;
    expect(row).toEqual({ wait_till: null, resume_state: null });
    expect(await queue.queue.getJobs(['delayed'])).not.toContainEqual(expect.objectContaining({ data: expect.objectContaining({ executionId: target }) }));
  });

  it('worker de outra máquina que caiu: a conexão parada há muito tempo não conta como viva; com um nó segurando o processador, conta', async () => {
    const probe = new ExecutionQueue(redis);
    // Como o CLIENT LIST mostra: a conexão de uma máquina que caiu sem avisar fica na lista, parada.
    probe.queue.getWorkers = async () => [
      { rawname: 'bull:x:w:caiu', idle: '900' },
      { rawname: 'bull:x:w:ativo', idle: '2' },
      { rawname: 'bull:x:w:ocupado', idle: '900' },
      { rawname: 'bull:x:w:travado', idle: '900' },
    ];
    await redis.set('sa:worker:ocupado', '1', 'PX', 60_000); // todas as vagas ocupadas, mas o aviso de vida em dia
    // Um nó segura o processador há mais de 1 minuto: só o aviso com o prazo da trava do job está em dia.
    await redis.set('sa:worker-held:travado', '1', 'PX', 60_000);
    // Processo que morreu (a conexão fechou): o aviso longo sozinho não conta.
    await redis.set('sa:worker-held:morto', '1', 'PX', 60_000);
    try {
      const live = await probe.liveWorkers(['caiu', 'ativo', 'ocupado', 'sumido', 'travado', 'morto']);
      expect([...live!.ids].sort()).toEqual(['ativo', 'ocupado', 'travado']);
    } finally {
      await redis.del('sa:worker:ocupado', 'sa:worker-held:travado', 'sa:worker-held:morto');
      await probe.close();
    }
  });

  it('pedido de cancelar que se perdeu no Redis: o worker o acha no banco', async () => {
    const wf = await createFlow('Aviso perdido', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['t', 'h']]));
    await worker!.close();
    worker = startWorker({ db, config, redis: createRedis(REDIS_URL), subscriber: createRedis(REDIS_URL), cancelCheckIntervalMs: 200 });
    try {
      const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
      await until(async () => (await status(executionId)).status === 'running', 'a execução começar');
      // A rota grava o pedido e avisa pelo Redis; o aviso não chegou (o worker estava reconectando ao Redis).
      await db.query('UPDATE executions SET cancel_requested = true WHERE id = $1', [executionId]);
      await until(async () => (await status(executionId)).status !== 'running', 'o worker achar o pedido');
      expect(await status(executionId)).toEqual({ status: 'canceled', error_message: 'Execução cancelada' });

      // Desligando antes da conferência: a execução fica cancelada, não interrompida pelo desligamento.
      await worker.close();
      worker = newWorker();
      const second = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body.executionId;
      await until(async () => (await status(second)).status === 'running', 'a segunda execução começar');
      await db.query('UPDATE executions SET cancel_requested = true WHERE id = $1', [second]);
      await worker.close();
      worker = null;
      expect(await status(second)).toEqual({ status: 'canceled', error_message: 'Execução cancelada' });
    } finally {
      await worker?.close();
      worker = newWorker();
    }
  });

  it('execução que não chegou à fila vira erro na hora (quem pediu recebe o erro e pode tentar de novo)', async () => {
    const wf = await createFlow('Redis fora', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }]));
    const original = queue.enqueueRun;
    queue.enqueueRun = async () => {
      throw new Error('Redis fora do ar');
    };
    try {
      expect((await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).status).toBe(500);
    } finally {
      queue.enqueueRun = original;
    }
    const row = await one<{ status: string; error_message: string }>(db, 'SELECT status, error_message FROM executions WHERE workflow_id = $1', [wf]);
    expect(row).toEqual({ status: 'error', error_message: 'Não foi possível pôr a execução na fila: Redis fora do ar' });
  });

  it('duas esperas seguidas: a segunda pausa tem o seu job da volta, e o job de uma pausa antiga não faz nada', async () => {
    const wf = await createFlow(
      'Duas esperas',
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'a', name: 'Espera 1', type: 'wait', parameters: { resume: 'timeInterval', amount: 2, unit: 'hours' } },
          { id: 'b', name: 'Espera 2', type: 'wait', parameters: { resume: 'timeInterval', amount: 3, unit: 'hours' } },
        ],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
    );
    const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
    const waitTill = async () => (await one<{ status: string; wait_till: Date | null }>(db, 'SELECT status, wait_till FROM executions WHERE id = $1', [executionId]))!;
    const first = await until(async () => {
      const r = await waitTill();
      return r.status === 'waiting' && r.wait_till;
    }, 'a primeira pausa');
    // A volta da primeira pausa roda; a execução chega à segunda espera dentro desse mesmo job. O job
    // entra na fila logo depois de a pausa ser gravada.
    await (await until(() => queue.queue.getJob(`resume-${executionId}-${first.getTime()}`), 'o job da volta da primeira pausa')).promote();
    const second = await until(async () => {
      const r = await waitTill();
      return r.status === 'waiting' && r.wait_till && r.wait_till.getTime() !== first.getTime() && r.wait_till;
    }, 'a segunda pausa');
    const job = await until(() => queue.queue.getJob(`resume-${executionId}-${second.getTime()}`), 'o job da volta da segunda pausa');
    expect(await job.getState()).toBe('delayed');

    // Um job que sobrou da primeira pausa (hora antiga) não tira a execução da segunda espera.
    const stale = await queue.queue.add('resume', { kind: 'resume', executionId, at: first.getTime() });
    await until(async () => (await stale.getState()) === 'completed', 'o job antigo rodar');
    expect((await waitTill()).status).toBe('waiting');

    await job.promote();
    await until(async () => (await waitTill()).status === 'success', 'a execução terminar');
  });

  it('cancelada com o worker ainda vivo, mas ele para antes de encerrá-la: fica cancelada, sem fluxo de erro', async () => {
    const errorFlow = await createFlow('Avisa cancelada', flow([{ id: 'e', name: 'Erro', type: 'errorTrigger' }]));
    const wf = await createFlow('Worker vai cair', flow([schedule], [], { errorWorkflowId: errorFlow }));
    // O worker acabou de cair: o aviso de vida ainda vale, então o cancelamento só fica pedido.
    await redis.set('sa:worker:vai-cair', '1', 'PX', 60_000);
    const parent = await insertExecution(wf, { mode: 'schedule', status: 'running', workerId: 'vai-cair' });
    const child = await insertExecution(wf, { mode: 'subworkflow', status: 'running', workerId: 'vai-cair', parentId: parent });
    // Sem o pedido de cancelar: continua virando erro, com o fluxo de erro.
    const other = await insertExecution(wf, { mode: 'schedule', status: 'running', workerId: 'vai-cair' });
    const listener = createRedis(REDIS_URL);
    const events = new ExecutionEvents(listener);
    const sweeper = newWorker(200);
    try {
      const sub = await events.subscribe(parent);
      expect((await call(admin, 'POST', `/api/executions/${parent}/cancel`)).status).toBe(200);
      expect((await status(parent)).status).toBe('running');
      // O aviso de vida vence (o worker não o renova mais): a procura nota a parada.
      await redis.del('sa:worker:vai-cair');
      const message = 'Cancelada; o worker que a rodava tinha parado';
      await until(async () => (await status(parent)).status === 'canceled', 'a execução cancelada ser encerrada');
      expect(await status(parent)).toEqual({ status: 'canceled', error_message: message });
      expect(await status(child)).toEqual({ status: 'canceled', error_message: message });
      expect(await sub.next((e) => e.type === 'finished', 2000)).toMatchObject({ type: 'finished', status: 'canceled', error: message });
      await sub.close();
      await until(async () => (await status(other)).status === 'error', 'a outra execução virar erro');
      const errorRuns = async () =>
        (await db.query<{ input: { json: { execution: { id: string } } }[] }>(`SELECT input FROM executions WHERE workflow_id = $1 AND mode = 'error'`, [errorFlow])).rows;
      await until(async () => (await errorRuns()).length > 0, 'o fluxo de erro rodar para a que virou erro');
      await new Promise((r) => setTimeout(r, 500));
      expect((await errorRuns()).map((r) => r.input[0].json.execution.id)).toEqual([other]);
    } finally {
      listener.disconnect();
      await sweeper.close();
    }
  });

  it('cancelada no instante em que o servidor começa a desligar: fica cancelada, não interrompida', async () => {
    const wf = await createFlow('Cancela e desliga', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['t', 'h']]));
    await worker!.close();
    // O servidor começa a desligar logo depois de o worker receber o pedido de cancelar, antes de a execução gravar o fim.
    const subscriber = createRedis(REDIS_URL);
    const handle = startWorker({ db, config, redis: createRedis(REDIS_URL), subscriber });
    worker = handle;
    let closing: Promise<void> | null = null;
    subscriber.on('message', (channel) => {
      if (channel === CANCEL_CHANNEL) closing ??= handle.close();
    });
    const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
    await until(async () => (await status(executionId)).status === 'running', 'a execução começar');
    expect((await call(admin, 'POST', `/api/executions/${executionId}/cancel`)).status).toBe(200);
    await until(async () => closing !== null, 'o worker começar a desligar');
    await closing;
    worker = newWorker();
    expect(await status(executionId)).toEqual({ status: 'canceled', error_message: 'Execução cancelada' });
  });

  it('desligando com o banco travado: o worker não pega job novo e não fica preso na conferência dos cancelamentos', async () => {
    const slowFlow = await createFlow('Roda ao desligar', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['t', 'h']]));
    const quick = await createFlow('Chega ao desligar', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }]));
    const running = (await call(admin, 'POST', `/api/workflows/${slowFlow}/run`, {})).body.executionId;
    await until(async () => (await status(running)).status === 'running', 'a execução começar');
    // A última conferência dos pedidos de cancelar não volta (o banco travou).
    const query = db.query.bind(db);
    let hung = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    db.query = (async (sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT id FROM executions WHERE id = ANY') && sql.includes('cancel_requested')) {
        hung = true;
        await released;
      }
      return (query as (...a: unknown[]) => unknown)(sql, ...rest);
    }) as typeof db.query;
    let arrived = '';
    try {
      const closing = worker!.close();
      worker = null;
      await until(async () => hung, 'o worker começar a conferir os cancelamentos');
      // Um pedido chega enquanto o worker desliga: fica na fila para o próximo worker.
      arrived = (await call(admin, 'POST', `/api/workflows/${quick}/run`, {})).body.executionId;
      await closing;
    } finally {
      release();
      db.query = query;
    }
    expect((await status(running)).status).not.toBe('running');
    expect((await status(arrived)).status).toBe('queued');
    worker = newWorker();
    await until(async () => (await status(arrived)).status === 'success', 'o próximo worker rodar a que chegou');
  });

  it('cancelar a execução no meio de um Execute Workflow "uma vez para cada item" não deixa os outros subfluxos rodando', async () => {
    const child = await createFlow('Filho rápido', flow([{ id: 'r', name: 'Recebe', type: 'executeWorkflowTrigger' }, { id: 'n', name: 'Nada', type: 'noOp' }], [['r', 'n']]));
    const parent = await createFlow(
      'Pai em laço',
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'c', name: 'Itens', type: 'code', parameters: { mode: 'all', jsCode: 'return Array.from({ length: 300 }, (_, i) => ({ json: { i } }));' } },
          { id: 'x', name: 'Para cada', type: 'executeWorkflow', parameters: { workflowId: child, mode: 'each' } },
        ],
        [
          ['t', 'c'],
          ['c', 'x'],
        ],
      ),
    );
    const children = async () => (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM executions WHERE workflow_id = $1', [child]))!.n;
    // O 10º subfluxo fica preso entre a conferência do cancelamento e o registro dele: o cancelamento chega aí.
    const query = db.query.bind(db);
    let lookups = 0;
    let held = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    db.query = (async (sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT id, name, folder_id, version, definition FROM workflows') && (rest[0] as string[])[0] === child && ++lookups === 10) {
        held = true;
        await released;
      }
      return (query as (...a: unknown[]) => unknown)(sql, ...rest);
    }) as typeof db.query;
    let executionId = '';
    try {
      executionId = (await call(admin, 'POST', `/api/workflows/${parent}/run`, {})).body.executionId;
      await until(async () => held, 'o 10º subfluxo ficar preso antes do registro');
      expect((await call(admin, 'POST', `/api/executions/${executionId}/cancel`)).status).toBe(200);
      await until(async () => (await status(executionId)).status === 'canceled', 'a execução ser cancelada');
    } finally {
      release();
      db.query = query;
    }
    // O subfluxo que estava sendo registrado na hora é cancelado, e nenhum outro começa.
    await until(async () => (await children()) === 10, 'o subfluxo preso ser registrado');
    const late = async () =>
      (await db.query<{ status: string }>(`SELECT c.status FROM executions c, executions p WHERE c.workflow_id = $1 AND p.id = $2 AND c.created_at > p.finished_at`, [child, executionId])).rows;
    await until(async () => (await late()).every((r) => r.status !== 'running'), 'o subfluxo preso terminar');
    expect(await late()).toEqual([{ status: 'canceled' }]);
    await new Promise((r) => setTimeout(r, 500));
    expect(await children()).toBe(10);
  });

  it('pausa que volta antes de a rodada anterior terminar de avisar: a rodada nova continua cancelável', async () => {
    const wf = await createFlow(
      'Volta rápida',
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'w', name: 'Aprovação', type: 'wait', parameters: { resume: 'webhook' } },
          { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } },
        ],
        [
          ['t', 'w'],
          ['w', 'h'],
        ],
      ),
    );
    // O aviso da pausa demora (Redis lento): a volta pela URL chega e roda neste mesmo worker antes de ele terminar.
    await worker!.close();
    const slowRedis = createRedis(REDIS_URL);
    const originalCall = slowRedis.call.bind(slowRedis) as (...args: unknown[]) => Promise<unknown>;
    let slowPubsub = true;
    slowRedis.call = (async (...args: unknown[]) => {
      if (slowPubsub && args[0] === 'PUBSUB') await new Promise((r) => setTimeout(r, 1000));
      return originalCall(...args);
    }) as typeof slowRedis.call;
    worker = startWorker({ db, config, redis: slowRedis, subscriber: createRedis(REDIS_URL) });
    try {
      const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
      await until(async () => (await status(executionId)).status === 'waiting', 'a execução pausar');
      expect((await app.inject({ method: 'GET', url: `/webhook-waiting/${executionId}` })).statusCode).toBe(200);
      await until(async () => (await status(executionId)).status === 'running', 'a volta começar a rodar');
      // A rodada da pausa termina de avisar e sai; a rodada nova ainda está no nó demorado.
      await new Promise((r) => setTimeout(r, 1200));
      slowPubsub = false;
      expect((await call(admin, 'POST', `/api/executions/${executionId}/cancel`)).status).toBe(200);
      await until(async () => (await status(executionId)).status !== 'running', 'a execução terminar');
      expect(await status(executionId)).toEqual({ status: 'canceled', error_message: 'Execução cancelada' });
    } finally {
      await worker.close();
      worker = newWorker();
    }
  });

  it('execução na fila que perdeu o job: só conta para a 1 hora o tempo em que ficou sem job', () => {
    const min = 60_000;
    const t0 = Date.parse('2026-10-21T10:00:00Z');
    // Falhou ao entrar, voltou para a fila 3 minutos depois, esperou a vez 55 minutos e falhou de novo.
    const failures = [
      { added: t0 + 3 * min, failed: t0 + 58 * min },
      { added: t0, failed: t0 + 1000 },
    ];
    expect(joblessMs(failures, t0, t0 + 61 * min)).toBe(3 * min - 1000 + 3 * min);
    // Sem falha guardada: desde a entrada na fila.
    expect(joblessMs([], t0, t0 + 61 * min)).toBe(61 * min);
  });

  it('uma queda do banco com mais de 1000 jobs esperando não apaga as falhas que a procura usa', async () => {
    const probeRedis = createRedis(REDIS_URL.replace(/\/\d+$/, '/14'));
    await probeRedis.flushdb();
    const probe = new ExecutionQueue(probeRedis);
    const ids = Array.from({ length: 1100 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const id of ids) await probe.enqueueRun(id);
    // Cada job falha ao pegar a execução, como com o Postgres reiniciando.
    const connection = createRedis(REDIS_URL.replace(/\/\d+$/, '/14'));
    const failing = new Worker(
      QUEUE_NAME,
      async () => {
        throw new Error('Connection terminated unexpectedly');
      },
      { connection, concurrency: 50 },
    );
    try {
      await until(async () => (await probe.queue.getJobCountByTypes('wait', 'active')) === 0, 'todos os jobs falharem');
      const failed = await probe.failedJobs();
      expect(failed.size).toBe(1100);
      expect(failed.has(ids[0])).toBe(true);
    } finally {
      await failing.close();
      connection.disconnect();
      await probe.queue.obliterate({ force: true });
      await probe.close();
      probeRedis.disconnect();
    }
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
    // Segura a gravação das duas (LOCK em SHARE deixa ler, não inserir): sem a trava por fluxo, as duas
    // conferências passariam antes de qualquer uma gravar.
    const holder = await db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE executions IN SHARE MODE');
      await Promise.all([queue.queue.add('scheduled', { kind: 'scheduled', workflowId: both }), queue.queue.add('scheduled', { kind: 'scheduled', workflowId: both })]);
      const waiting = async () =>
        (await one<{ n: number }>(
          db,
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND (query LIKE 'SELECT pg_advisory_xact_lock%' OR query LIKE 'INSERT INTO executions%')`,
        ))!.n;
      await until(async () => (await waiting()) >= 2, 'os dois horários chegarem à conferência');
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    await until(async () => (await scheduledRuns(both)).length === 1, 'um dos dois horários rodar');
    // A execução agendada nasce rodando, já com o worker: se ele parar, a procura de abandonadas a acha.
    // (gravada já rodando: começou no mesmo comando que a criou, sem passar pela fila)
    expect(await one(db, `SELECT status, worker_id IS NOT NULL AS owned, started_at = created_at AS born_running FROM executions WHERE workflow_id = $1`, [both])).toEqual({
      status: 'running',
      owned: true,
      born_running: true,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(await scheduledRuns(both)).toHaveLength(1);
    await until(async () => (await scheduledRuns(both)).join() === 'success', 'a execução terminar');
  });

  it('o Postgres derrubando uma conexão parada não encerra o processo', async () => {
    const probe = createDb(DATABASE_URL);
    try {
      expect(probe.listenerCount('error')).toBeGreaterThan(0);
      const { pid } = (await one<{ pid: number }>(probe, 'SELECT pg_backend_pid() AS pid'))!;
      expect(probe.idleCount).toBe(1);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await db.query('SELECT pg_terminate_backend($1)', [pid]);
        await until(async () => probe.idleCount === 0, 'o pool descartar a conexão derrubada');
        expect(errors).toHaveBeenCalledWith('Uma conexão parada com o Postgres caiu:', expect.any(String));
      } finally {
        errors.mockRestore();
      }
      // A próxima consulta abre outra conexão.
      expect((await one<{ ok: number }>(probe, 'SELECT 1 AS ok'))!.ok).toBe(1);
    } finally {
      await probe.end();
    }
  });

  // ---------- Q1: desligar o servidor no meio de uma execução ----------

  it('desligar o worker no meio marca a execução como interrompida', async () => {
    const wf = await createFlow('Demorado', flow([{ id: 't', name: 'Início', type: 'manualTrigger' }, { id: 'h', name: 'Demora', type: 'httpRequest', parameters: { url: slowBase } }], [['t', 'h']]));
    const { executionId } = (await call(admin, 'POST', `/api/workflows/${wf}/run`, {})).body;
    await until(async () => (await status(executionId)).status === 'running', 'a execução começar');
    const { worker_id } = (await one<{ worker_id: string }>(db, 'SELECT worker_id FROM executions WHERE id = $1', [executionId]))!;
    expect(await redis.exists(`sa:worker:${worker_id}`, `sa:worker-held:${worker_id}`)).toBe(2);
    await worker!.close();
    worker = null;
    expect(await status(executionId)).toEqual({ status: 'error', error_message: 'Execução interrompida porque o servidor foi desligado' });
    // Desligado, o worker apaga o aviso de vida: as execuções dele param de contar como em andamento.
    expect(await redis.exists(`sa:worker:${worker_id}`, `sa:worker-held:${worker_id}`)).toBe(0);
  });
});
