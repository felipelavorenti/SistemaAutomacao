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

describe.skipIf(!available)('API', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle;
  let redis: Redis;
  let api: Server;
  let apiBase = '';

  const config: Config = {
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    encryptionKey: parseKey('0'.repeat(64)),
    sessionTtlHours: 1,
    executionRetentionDays: 0,
    keepSuccessData: false,
    workerConcurrency: 2,
    runWorkerInProcess: true,
    secureCookies: false,
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await ensureAdmin(db, { email: 'admin@teste.com', password: 'senha-inicial-123', name: 'Admin' });
    redis = createRedis(REDIS_URL);
    await redis.flushdb();
    queue = new ExecutionQueue(redis);
    worker = startWorker({ db, config, redis: createRedis(REDIS_URL), subscriber: createRedis(REDIS_URL) });
    app = await buildApp({ db, config, queue });

    // API externa falsa que os fluxos vão chamar.
    api = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/erro') {
        res.statusCode = 400;
        res.end(JSON.stringify({ motivo: 'SKU não encontrado' }));
      } else {
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null, path: req.url }));
      }
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    redis?.disconnect();
    await app?.close();
    api?.close();
    await db?.end();
  });

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'sa_session')!;
    return `sa_session=${cookie.value}`;
  }

  async function call(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }

  async function waitExecution(cookie: string, id: string) {
    for (let i = 0; i < 100; i++) {
      const { body } = await call(cookie, 'GET', `/api/executions/${id}`);
      if (!['queued', 'running'].includes(body.status)) return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('A execução não terminou');
  }

  let admin = '';
  let editor = '';
  let viewer = '';
  let folderA = '';
  let folderB = '';
  let clientX = '';
  let connectionId = '';
  let workflowId = '';

  it('exige login e troca de senha no primeiro acesso', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@teste.com', password: 'errada' } });
    expect(bad.statusCode).toBe(401);

    admin = await loginAs('admin@teste.com', 'senha-inicial-123');
    expect((await call(admin, 'GET', '/api/workflows')).status).toBe(403);
    expect((await call(admin, 'POST', '/api/auth/change-password', { currentPassword: 'senha-inicial-123', newPassword: 'nova-senha-forte-1' })).status).toBe(200);
    expect((await call(admin, 'GET', '/api/workflows')).status).toBe(200);
  });

  it('bloqueia o usuário depois de 5 senhas erradas', async () => {
    await call(admin, 'POST', '/api/users', { email: 'alvo@teste.com', name: 'Alvo', role: 'viewer', password: 'senha-do-alvo-1' });
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alvo@teste.com', password: 'x' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alvo@teste.com', password: 'senha-do-alvo-1' } });
    expect(res.json().error).toMatch(/bloqueado/);
  });

  it('cria pastas, clientes e usuários com acesso restrito', async () => {
    folderA = (await call(admin, 'POST', '/api/folders', { name: 'ERP Consinco' })).body.id;
    folderB = (await call(admin, 'POST', '/api/folders', { name: 'Financeiro' })).body.id;
    clientX = (await call(admin, 'POST', '/api/clients', { name: 'Cliente X' })).body.id;
    await call(admin, 'POST', '/api/clients', { name: 'Cliente Y' });

    const created = await call(admin, 'POST', '/api/users', {
      email: 'editor@teste.com',
      name: 'Editor',
      role: 'editor',
      password: 'senha-do-editor-1',
      folderIds: [folderA],
      clientIds: [clientX],
    });
    expect(created.status).toBe(200);
    await call(admin, 'POST', '/api/users', { email: 'leitor@teste.com', name: 'Leitor', role: 'viewer', password: 'senha-do-leitor-1', folderIds: [folderA] });

    editor = await loginAs('editor@teste.com', 'senha-do-editor-1');
    await call(editor, 'POST', '/api/auth/change-password', { currentPassword: 'senha-do-editor-1', newPassword: 'senha-do-editor-2' });
    viewer = await loginAs('leitor@teste.com', 'senha-do-leitor-1');
    await call(viewer, 'POST', '/api/auth/change-password', { currentPassword: 'senha-do-leitor-1', newPassword: 'senha-do-leitor-2' });

    expect((await call(editor, 'GET', '/api/folders')).body.map((f: { name: string }) => f.name)).toEqual(['ERP Consinco']);
    expect((await call(editor, 'GET', '/api/clients')).body.map((c: { name: string }) => c.name)).toEqual(['Cliente X']);
    expect((await call(editor, 'GET', '/api/users')).status).toBe(403);
  });

  it('guarda a conexão criptografada e nunca devolve o segredo', async () => {
    const res = await call(editor, 'POST', '/api/connections', {
      name: 'Consinco Cliente X',
      type: 'httpBearerAuth',
      clientId: clientX,
      data: { token: 'segredo-123' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    connectionId = res.body.id;
    expect(res.body.data.token).toBe('••••••');

    const raw = await db.query('SELECT data_encrypted::text AS t FROM connections WHERE id = $1', [connectionId]);
    expect(raw.rows[0].t).not.toContain('segredo-123');

    // Salvar com o campo secreto vazio mantém o valor anterior.
    await call(editor, 'PUT', `/api/connections/${connectionId}`, { name: 'Consinco X', type: 'httpBearerAuth', clientId: clientX, data: { token: '' } });

    const audit = await call(admin, 'GET', `/api/audit?entityType=connection&entityId=${connectionId}`);
    expect(JSON.stringify(audit.body)).not.toContain('segredo-123');
    expect(audit.body.map((a: { action: string }) => a.action)).toEqual(['update', 'create']);
  });

  it('não deixa usar conexão de cliente sem acesso', async () => {
    const other = await call(admin, 'POST', '/api/connections', { name: 'Outro', type: 'httpBearerAuth', clientId: null, data: { token: 't' } });
    const clients = (await call(admin, 'GET', '/api/clients')).body as { id: string; name: string }[];
    const restricted = await call(admin, 'POST', '/api/connections', {
      name: 'Do Y',
      type: 'httpBearerAuth',
      clientId: clients.find((c) => c.name === 'Cliente Y')!.id,
      data: { token: 't' },
    });
    expect(other.status).toBe(200);
    const res = await call(editor, 'POST', '/api/workflows', {
      name: 'Tentativa',
      folderId: folderA,
      definition: {
        nodes: [
          { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
          { id: 'h', name: 'H', type: 'httpRequest', position: { x: 0, y: 0 }, parameters: { url: apiBase, connection: restricted.body.id } },
        ],
        connections: [{ from: 't', fromOutput: 0, to: 'h', toInput: 0 }],
      },
    });
    expect(res.status).toBe(403);
  });

  it('salva versões do fluxo e executa com a conexão', async () => {
    const created = await call(editor, 'POST', '/api/workflows', { name: 'Alterar preço', folderId: folderA });
    workflowId = created.body.id;
    expect((await call(editor, 'POST', '/api/workflows', { name: 'Fora', folderId: folderB })).status).toBe(403);

    const definition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'h', name: 'Chamar API', type: 'httpRequest', position: { x: 200, y: 0 }, parameters: { url: `=${apiBase}/precos/{{ $json.sku }}`, connection: connectionId } },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'h', toInput: 0 }],
    };
    const saved = await call(editor, 'PUT', `/api/workflows/${workflowId}`, { name: 'Alterar preço', folderId: folderA, definition, baseVersion: 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.version).toBe(2);
    expect((await call(editor, 'PUT', `/api/workflows/${workflowId}`, { name: 'x', folderId: folderA, definition, baseVersion: 1 })).status).toBe(409);

    const run = await call(editor, 'POST', `/api/workflows/${workflowId}/run`, { input: [{ json: { sku: 'ABC' } }] });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status).toBe('success');
    expect(execution.runs[1].output[0][0].json).toEqual({ auth: 'Bearer segredo-123', path: '/precos/ABC' });
  });

  it('guarda o retorno da API quando a execução falha', async () => {
    const definition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'h', name: 'Chamar API', type: 'httpRequest', position: { x: 200, y: 0 }, parameters: { url: `${apiBase}/erro` } },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'h', toInput: 0 }],
    };
    const run = await call(editor, 'POST', `/api/workflows/${workflowId}/run`, { definition });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status).toBe('error');
    expect(execution.error_node).toBe('Chamar API');
    expect(execution.error.details.body).toEqual({ motivo: 'SKU não encontrado' });

    const list = await call(editor, 'GET', `/api/executions?workflowId=${workflowId}&status=error`);
    expect(list.body).toHaveLength(1);
  });

  it('respeita os perfis', async () => {
    expect((await call(viewer, 'GET', `/api/workflows/${workflowId}`)).status).toBe(200);
    expect((await call(viewer, 'POST', `/api/workflows/${workflowId}/run`, {})).status).toBe(403);
    expect((await call(viewer, 'PUT', `/api/workflows/${workflowId}`, { name: 'x', folderId: folderA, definition: { nodes: [], connections: [] } })).status).toBe(403);
    expect((await call(viewer, 'GET', '/api/connections')).body.map((c: { name: string }) => c.name)).toEqual(['Outro']);
  });

  it('ativa só fluxo agendado e válido', async () => {
    expect((await call(editor, 'POST', `/api/workflows/${workflowId}/activate`)).status).toBe(400);
    const definition = {
      nodes: [
        { id: 's', name: 'Agendamento', type: 'scheduleTrigger', position: { x: 0, y: 0 }, parameters: { mode: 'cron', cron: '0 8 * * *', timezone: 'America/Sao_Paulo' } },
        { id: 'h', name: 'Chamar API', type: 'httpRequest', position: { x: 200, y: 0 }, parameters: { url: apiBase } },
      ],
      connections: [{ from: 's', fromOutput: 0, to: 'h', toInput: 0 }],
    };
    await call(editor, 'PUT', `/api/workflows/${workflowId}`, { name: 'Alterar preço', folderId: folderA, definition });
    expect((await call(editor, 'POST', `/api/workflows/${workflowId}/activate`)).status).toBe(200);
    const schedulers = await queue.queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(`wf:${workflowId}`);

    await call(editor, 'POST', `/api/workflows/${workflowId}/deactivate`);
    expect((await queue.queue.getJobSchedulers()).map((s) => s.key)).not.toContain(`wf:${workflowId}`);
  });

  it('registra quem alterou o fluxo', async () => {
    const audit = await call(admin, 'GET', `/api/audit?entityType=workflow&entityId=${workflowId}`);
    expect(audit.body.map((a: { action: string }) => a.action)).toEqual(['deactivate', 'activate', 'update', 'update', 'create']);
    expect(audit.body[0].user_email).toBe('editor@teste.com');
  });
});
