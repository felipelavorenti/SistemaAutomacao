import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';
import { createDb, migrate, type Db } from '../src/db/db.js';
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

describe.skipIf(!available)('Gatilhos: webhook, formulário, pausa e fluxo de erro', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle;
  let redis: Redis;
  let triggers: TriggerManager;
  let api: Server;
  let apiBase = '';
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
    publicUrl: 'https://info8n.teste',
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

    api = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.url === '/erro' ? 400 : 200;
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@teste.com', password: 'senha-inicial-123' } });
    admin = `sa_session=${res.cookies.find((c) => c.name === 'sa_session')!.value}`;
    folder = (await call('POST', '/api/folders', { name: 'Gatilhos' })).body.id;
  });

  afterAll(async () => {
    await triggers?.close();
    await worker?.close();
    await queue?.close();
    redis?.disconnect();
    await app?.close();
    api?.close();
    await db?.end();
  });

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie: admin } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }

  async function createFlow(name: string, definition: ReturnType<typeof flow>, activate = true): Promise<string> {
    const wf = (await call('POST', '/api/workflows', { name, folderId: folder, definition })).body;
    expect(wf.id, JSON.stringify(wf)).toBeTruthy();
    if (activate) {
      const res = await call('POST', `/api/workflows/${wf.id}/activate`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    return wf.id;
  }

  async function executionsOf(workflowId: string) {
    return (await call('GET', `/api/executions?workflowId=${workflowId}`)).body as { id: string; status: string; mode: string }[];
  }

  async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Não aconteceu: ${what}`);
  }

  const nonEmpty = <T,>(list: T[]) => (list.length ? list : null);

  async function finished(id: string, statuses = ['success', 'error', 'canceled', 'waiting']) {
    return waitFor(async () => {
      const { body } = await call('GET', `/api/executions/${id}`);
      return statuses.includes(body.status) ? body : null;
    }, `execução ${id} terminar`);
  }

  it('webhook responde na hora e a execução recebe headers, params, query e body', async () => {
    const id = await createFlow(
      'Webhook pedidos',
      flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'pedidos/:numero' } }, { id: 'n', name: 'Fim', type: 'noOp' }], [['w', 'n']]),
    );
    const res = await app.inject({ method: 'POST', url: '/webhook/pedidos/42?origem=loja', payload: { total: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Workflow was started' });

    const [exec] = await waitFor(async () => nonEmpty((await executionsOf(id)).filter((e) => e.status === 'success')), 'execução do webhook');
    expect(exec!.mode).toBe('webhook');
    const full = (await call('GET', `/api/executions/${exec!.id}`)).body;
    expect(full.runs[0].output[0][0].json).toMatchObject({
      params: { numero: '42' },
      query: { origem: 'loja' },
      body: { total: 10 },
      webhookUrl: 'https://info8n.teste/webhook/pedidos/:numero',
      executionMode: 'production',
    });
    expect(full.runs[0].output[0][0].json.headers['content-type']).toMatch(/json/);

    expect((await app.inject({ method: 'GET', url: '/webhook/pedidos/42' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'POST', url: '/webhook/nao-existe' })).statusCode).toBe(404);
  });

  it('não deixa dois fluxos ativos com o mesmo caminho', async () => {
    const wf = (await call('POST', '/api/workflows', {
      name: 'Webhook repetido',
      folderId: folder,
      definition: flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'pedidos/:numero' } }]),
    })).body;
    const res = await call('POST', `/api/workflows/${wf.id}/activate`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/já é usado pelo fluxo ativo "Webhook pedidos"/);
  });

  it('responde com a saída do último nó e pelo Respond to Webhook', async () => {
    await createFlow(
      'Webhook último nó',
      flow(
        [
          { id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'eco', responseMode: 'lastNode', responseData: 'firstEntryJson', responsePropertyName: 'body' } },
          { id: 'n', name: 'Fim', type: 'noOp' },
        ],
        [['w', 'n']],
      ),
    );
    const eco = await app.inject({ method: 'POST', url: '/webhook/eco', payload: { a: 1 } });
    expect(eco.statusCode).toBe(200);
    expect(eco.json()).toEqual({ a: 1 });

    await createFlow(
      'Webhook respond',
      flow(
        [
          { id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'GET', path: 'resposta', responseMode: 'responseNode' } },
          {
            id: 'r',
            name: 'Responder',
            type: 'respondToWebhook',
            parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: true, q: $json.query.x }) }}', responseCode: 201, responseHeaders: [{ name: 'X-Teste', value: 'sim' }] },
          },
          { id: 'n', name: 'Depois', type: 'noOp' },
        ],
        [
          ['w', 'r'],
          ['r', 'n'],
        ],
      ),
    );
    const res = await app.inject({ method: 'GET', url: '/webhook/resposta?x=7' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-teste']).toBe('sim');
    expect(res.json()).toEqual({ ok: true, q: '7' });
  });

  it('confere usuário e senha do webhook', async () => {
    const conn = (await call('POST', '/api/connections', { name: 'Senha do webhook', type: 'httpBasicAuth', data: { user: 'loja', password: 's3nha' } })).body;
    expect(conn.id, JSON.stringify(conn)).toBeTruthy();
    await createFlow(
      'Webhook protegido',
      flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'protegido', authentication: 'basicAuth', basicAuthConnection: conn.id } }]),
    );
    const none = await app.inject({ method: 'POST', url: '/webhook/protegido', payload: {} });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/Basic/);
    const wrong = await app.inject({ method: 'POST', url: '/webhook/protegido', payload: {}, headers: { authorization: `Basic ${Buffer.from('loja:x').toString('base64')}` } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/webhook/protegido', payload: {}, headers: { authorization: `Basic ${Buffer.from('loja:s3nha').toString('base64')}` } });
    expect(ok.statusCode).toBe(200);
  });

  it('pausa no Wait até a URL de retomada ser chamada, sem ocupar o worker', async () => {
    const id = await createFlow(
      'Espera webhook',
      flow(
        [
          { id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'aprovar' } },
          { id: 'e', name: 'Esperar aprovação', type: 'wait', parameters: { resume: 'webhook', httpMethod: 'POST', responseMode: 'lastNode' } },
          { id: 'n', name: 'Aprovado', type: 'noOp' },
        ],
        [
          ['w', 'e'],
          ['e', 'n'],
        ],
      ),
    );
    await app.inject({ method: 'POST', url: '/webhook/aprovar', payload: { pedido: 1 } });
    const [waiting] = await waitFor(async () => nonEmpty((await executionsOf(id)).filter((e) => e.status === 'waiting')), 'execução pausada');
    const paused = (await call('GET', `/api/executions/${waiting!.id}`)).body;
    expect(paused.wait_info).toMatchObject({ kind: 'webhook', nodeName: 'Esperar aprovação' });
    expect(paused.resume_state).toBeUndefined();
    expect(paused.runs.map((r: { nodeName: string }) => r.nodeName)).toEqual(['Webhook']);

    expect((await app.inject({ method: 'GET', url: `/webhook-waiting/${waiting!.id}` })).statusCode).toBe(405);
    const res = await app.inject({ method: 'POST', url: `/webhook-waiting/${waiting!.id}`, payload: { aprovado: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ aprovado: true });
    const done = await finished(waiting!.id, ['success', 'error']);
    expect(done.status).toBe('success');
    expect(done.runs.map((r: { nodeName: string }) => r.nodeName)).toEqual(['Webhook', 'Esperar aprovação', 'Aprovado']);
    expect((await app.inject({ method: 'POST', url: `/webhook-waiting/${waiting!.id}`, payload: {} })).statusCode).toBe(409);
  });

  it('espera longa vira pausa com retomada agendada; cancelar também funciona', async () => {
    const wf = (await call('POST', '/api/workflows', {
      name: 'Espera 2 horas',
      folderId: folder,
      definition: flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'e', name: 'Esperar', type: 'wait', parameters: { resume: 'timeInterval', amount: 2, unit: 'hours' } },
          { id: 'n', name: 'Depois', type: 'noOp' },
        ],
        [
          ['t', 'e'],
          ['e', 'n'],
        ],
      ),
    })).body;
    const run1 = (await call('POST', `/api/workflows/${wf.id}/run`, { input: [{ json: { a: 1 } }] })).body;
    const paused = await finished(run1.executionId);
    expect(paused.status).toBe('waiting');
    expect(Date.parse(paused.wait_till) - Date.now()).toBeGreaterThan(3_600_000);
    const job = await queue.queue.getJob(`resume-${run1.executionId}`);
    expect(job).toBeTruthy();
    // Adianta o relógio: o job da retomada roda agora.
    await job!.promote();
    const done = await finished(run1.executionId, ['success', 'error']);
    expect(done.status).toBe('success');
    expect(done.runs.at(-1).output[0]).toEqual([{ json: { a: 1 } }]);

    const run2 = (await call('POST', `/api/workflows/${wf.id}/run`, {})).body;
    await finished(run2.executionId);
    expect((await call('POST', `/api/executions/${run2.executionId}/cancel`)).status).toBe(200);
    expect((await call('GET', `/api/executions/${run2.executionId}`)).body.status).toBe('canceled');
    expect(await queue.queue.getJob(`resume-${run2.executionId}`)).toBeFalsy();
  });

  it('formulário em duas páginas: Form Trigger e Form', async () => {
    const id = await createFlow(
      'Cadastro',
      flow(
        [
          {
            id: 'f',
            name: 'Formulário',
            type: 'formTrigger',
            parameters: {
              path: 'cadastro',
              formTitle: 'Cadastro de cliente',
              formFields: [
                { fieldLabel: 'Nome', fieldType: 'text', requiredField: true },
                { fieldLabel: 'Idade', fieldType: 'number' },
                { fieldLabel: 'Interesses', fieldType: 'checkbox', fieldOptions: 'Vinho\nQueijo' },
              ],
            },
          },
          { id: 'p', name: 'Endereço', type: 'form', parameters: { formTitle: 'Endereço', formFields: [{ fieldLabel: 'Cidade', fieldType: 'text', requiredField: true }] } },
          { id: 'c', name: 'Fim', type: 'form', parameters: { operation: 'completion', completionTitle: 'Pronto', completionMessage: 'Obrigado!' } },
        ],
        [
          ['f', 'p'],
          ['p', 'c'],
        ],
      ),
    );
    const page = await app.inject({ method: 'GET', url: '/form/cadastro' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);
    expect(page.body).toContain('Cadastro de cliente');
    expect(page.body).toContain('name="field-0"');

    const form = 'field-0=&field-1=30';
    const invalid = await app.inject({ method: 'POST', url: '/form/cadastro', payload: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('Preencha');

    const sent = await app.inject({
      method: 'POST',
      url: '/form/cadastro',
      payload: 'field-0=Ana&field-1=30&field-2=Vinho&field-2=Queijo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(sent.statusCode).toBe(303);
    const next = sent.headers.location as string;
    expect(next).toMatch(/^\/form-waiting\//);
    const second = await app.inject({ method: 'GET', url: next });
    expect(second.body).toContain('Endereço');
    const end = await app.inject({ method: 'POST', url: next, payload: 'field-0=Recife', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(end.statusCode).toBe(200);
    expect(end.body).toContain('Obrigado!');

    const [exec] = await waitFor(async () => nonEmpty((await executionsOf(id)).filter((e) => e.status === 'success')), 'formulário concluído');
    const full = (await call('GET', `/api/executions/${exec!.id}`)).body;
    expect(full.runs[0].output[0][0].json).toMatchObject({ Nome: 'Ana', Idade: 30, Interesses: ['Vinho', 'Queijo'], formMode: 'production' });
    expect(full.runs[1].output[0][0].json).toMatchObject({ Cidade: 'Recife' });
  });

  it('roda o fluxo de erro quando uma execução de produção falha', async () => {
    const errorFlow = await createFlow(
      'Avisar erro',
      flow([{ id: 'e', name: 'Error Trigger', type: 'errorTrigger' }, { id: 'n', name: 'Avisar', type: 'noOp' }], [['e', 'n']]),
      false,
    );
    const failing = await createFlow(
      'Falha no webhook',
      flow(
        [
          { id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'falha' } },
          { id: 'h', name: 'Chamar API', type: 'httpRequest', parameters: { url: `${apiBase}/erro` } },
        ],
        [['w', 'h']],
        { errorWorkflowId: errorFlow },
      ),
    );
    await app.inject({ method: 'POST', url: '/webhook/falha', payload: {} });
    const [failed] = await waitFor(async () => nonEmpty((await executionsOf(failing)).filter((e) => e.status === 'error')), 'execução com erro');
    const [handled] = await waitFor(async () => nonEmpty((await executionsOf(errorFlow)).filter((e) => e.status === 'success')), 'fluxo de erro');
    expect(handled!.mode).toBe('error');
    const full = (await call('GET', `/api/executions/${handled!.id}`)).body;
    expect(full.runs[0].output[0][0].json).toMatchObject({
      execution: { id: failed!.id, url: `https://info8n.teste/execucoes/${failed!.id}`, lastNodeExecuted: 'Chamar API', mode: 'webhook' },
      workflow: { id: failing, name: 'Falha no webhook' },
    });

    // O fluxo de erro precisa ter o Error Trigger.
    const bad = await call('POST', '/api/workflows', { name: 'Sem error trigger', folderId: folder, definition: flow([{ id: 't', name: 'Início', type: 'manualTrigger' }], [], { errorWorkflowId: failing }) });
    expect(bad.status).toBe(400);
  });

  it('escuta de teste: a URL de teste só responde enquanto o editor escuta', async () => {
    const wf = (await call('POST', '/api/workflows', {
      name: 'Teste de webhook',
      folderId: folder,
      definition: flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'teste-editor' } }]),
    })).body;
    expect((await app.inject({ method: 'POST', url: '/webhook-test/teste-editor', payload: {} })).statusCode).toBe(404);
    const listen = await call('POST', `/api/workflows/${wf.id}/listen`, {});
    expect(listen.status).toBe(200);
    expect(listen.body.webhooks).toEqual([{ kind: 'webhook', method: 'POST', path: 'teste-editor', nodeName: 'Webhook' }]);
    expect((await call('GET', `/api/workflows/${wf.id}/listen`)).body.listening).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/webhook-test/teste-editor', payload: { x: 1 } })).statusCode).toBe(200);
    const status = (await call('GET', `/api/workflows/${wf.id}/listen`)).body;
    expect(status.listening).toBe(false);
    const exec = await finished(status.executionId, ['success', 'error']);
    expect(exec.mode).toBe('manual');
    expect(exec.runs[0].output[0][0].json.executionMode).toBe('test');
    // Fechou depois do primeiro evento.
    expect((await app.inject({ method: 'POST', url: '/webhook-test/teste-editor', payload: {} })).statusCode).toBe(404);
  });

  it('n8n Trigger dispara ao ativar', async () => {
    const id = await createFlow('Ao ativar', flow([{ id: 'n', name: 'n8n Trigger', type: 'n8nTrigger', parameters: { events: ['activate'] } }]));
    const [exec] = await waitFor(async () => nonEmpty((await executionsOf(id)).filter((e) => e.status === 'success')), 'execução do n8n Trigger');
    expect(exec!.mode).toBe('trigger');
    const full = (await call('GET', `/api/executions/${exec!.id}`)).body;
    expect(full.runs[0].output[0][0].json).toMatchObject({ event: 'Workflow activated', workflow_id: id });
  });
});
