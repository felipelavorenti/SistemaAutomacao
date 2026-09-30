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

  it('chama subfluxo, registra a execução filha e devolve o erro da API', async () => {
    const node = (id: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name: id, type, position: { x: 0, y: 0 }, parameters });
    const sub = await call(editor, 'POST', '/api/workflows', { name: 'Subfluxo preço', folderId: folderA });
    const subDefinition = (url: string) => ({
      nodes: [node('Recebe', 'executeWorkflowTrigger'), node('API', 'httpRequest', { url })],
      connections: [{ from: 'Recebe', fromOutput: 0, to: 'API', toInput: 0 }],
    });
    expect((await call(editor, 'PUT', `/api/workflows/${sub.body.id}`, { name: 'Subfluxo preço', folderId: folderA, definition: subDefinition(`=${apiBase}/sub/{{ $json.sku }}`) })).status).toBe(200);

    const parent = await call(editor, 'POST', '/api/workflows', { name: 'Chama subfluxo', folderId: folderA });
    const parentDefinition = {
      nodes: [node('Início', 'manualTrigger'), node('Sub', 'executeWorkflow', { workflowId: sub.body.id, mode: 'each' })],
      connections: [{ from: 'Início', fromOutput: 0, to: 'Sub', toInput: 0 }],
    };
    const saved = await call(editor, 'PUT', `/api/workflows/${parent.body.id}`, { name: 'Chama subfluxo', folderId: folderA, definition: parentDefinition });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await call(editor, 'GET', `/api/workflows/${sub.body.id}/callers`)).body.map((w: { name: string }) => w.name)).toEqual(['Chama subfluxo']);

    const run = await call(editor, 'POST', `/api/workflows/${parent.body.id}/run`, { input: [{ json: { sku: 'A' } }, { json: { sku: 'B' } }] });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status, JSON.stringify(execution.error)).toBe('success');
    expect(execution.runs[1].output[0].map((i: { json: { path: string } }) => i.json.path)).toEqual(['/sub/A', '/sub/B']);
    expect(execution.children).toHaveLength(2);
    expect(execution.runs[1].meta.subExecutionIds).toEqual(execution.children.map((c: { id: string }) => c.id));
    const child = await call(editor, 'GET', `/api/executions/${execution.children[0].id}`);
    expect(child.body).toMatchObject({ mode: 'subworkflow', status: 'success', parent_execution_id: run.body.executionId });
    expect(child.body.runs).not.toBeNull();

    // Erro dentro do subfluxo chega no pai com o retorno da API.
    await call(editor, 'PUT', `/api/workflows/${sub.body.id}`, { name: 'Subfluxo preço', folderId: folderA, definition: subDefinition(`${apiBase}/erro`) });
    const failed = await waitExecution(editor, (await call(editor, 'POST', `/api/workflows/${parent.body.id}/run`, {})).body.executionId);
    expect(failed.status).toBe('error');
    expect(failed.error_message).toContain('O subfluxo falhou no nó "API"');
    expect(failed.error.details.details.body).toEqual({ motivo: 'SKU não encontrado' });

    // Não dá para excluir um fluxo que outro chama, nem chamar fluxo de pasta sem acesso.
    expect((await call(editor, 'DELETE', `/api/workflows/${sub.body.id}`)).body.error).toMatch(/chamado por outros fluxos/);
    const hidden = await call(admin, 'POST', '/api/workflows', { name: 'Oculto', folderId: folderB });
    const bad = { ...parentDefinition, nodes: [parentDefinition.nodes[0], node('Sub', 'executeWorkflow', { workflowId: hidden.body.id })] };
    expect((await call(editor, 'PUT', `/api/workflows/${parent.body.id}`, { name: 'Chama subfluxo', folderId: folderA, definition: bad })).status).toBe(403);

    // Subfluxo sem o gatilho certo.
    const plain = await call(editor, 'POST', '/api/workflows', { name: 'Sem gatilho', folderId: folderA });
    const noTrigger = { ...parentDefinition, nodes: [parentDefinition.nodes[0], node('Sub', 'executeWorkflow', { workflowId: plain.body.id })] };
    const wrong = await waitExecution(editor, (await call(editor, 'POST', `/api/workflows/${parent.body.id}/run`, { definition: noTrigger })).body.executionId);
    expect(wrong.error_message).toMatch(/não começa pelo gatilho/);
  });

  it('executa comandos no banco do cliente e registra cada um', async () => {
    const u = new URL(DATABASE_URL);
    const data = { host: u.hostname, port: u.port || '5432', database: u.pathname.slice(1), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    const bad = await call(editor, 'POST', '/api/connections/test', { type: 'postgres', data: { ...data, database: 'nao_existe' } });
    expect(bad.body.ok).toBe(false);
    const good = await call(editor, 'POST', '/api/connections/test', { type: 'postgres', data });
    expect(good.body, JSON.stringify(good.body)).toMatchObject({ ok: true });

    const conn = await call(editor, 'POST', '/api/connections', { name: 'Banco do Cliente X', type: 'postgres', clientId: clientX, data });
    expect(conn.status, JSON.stringify(conn.body)).toBe(200);
    // Testar de novo com a senha em branco usa a salva.
    expect((await call(editor, 'POST', '/api/connections/test', { id: conn.body.id, type: 'postgres', data: { ...data, password: '' } })).body.ok).toBe(true);

    const wf = await call(editor, 'POST', '/api/workflows', { name: 'Consulta no banco', folderId: folderA });
    const definition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        {
          id: 'd',
          name: 'Dobrar',
          type: 'database',
          position: { x: 0, y: 0 },
          parameters: { connection: conn.body.id, operation: 'query', sql: 'SELECT CAST(:n AS int) * 2 AS dobro', queryParams: [{ name: 'n', value: '={{ $json.n }}' }] },
        },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'd', toInput: 0 }],
    };
    const run = await call(editor, 'POST', `/api/workflows/${wf.body.id}/run`, { definition, input: [{ json: { n: 4 } }, { json: { n: 5 } }] });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status, JSON.stringify(execution.error)).toBe('success');
    expect(execution.runs[1].output[0].map((i: { json: { dobro: number } }) => i.json.dobro)).toEqual([8, 10]);

    const commands = await call(editor, 'GET', `/api/db-commands?executionId=${run.body.executionId}`);
    expect(commands.body).toHaveLength(2);
    expect(commands.body[0]).toMatchObject({
      workflow_name: 'Consulta no banco',
      node_name: 'Dobrar',
      connection_name: 'Banco do Cliente X',
      client_name: 'Cliente X',
      db_type: 'postgres',
      sql: 'SELECT CAST(:n AS int) * 2 AS dobro',
      params: { n: 5 },
      rows: 1,
      triggered_by_name: 'Editor',
    });
    // Quem não tem acesso ao cliente não vê os comandos dele.
    expect((await call(viewer, 'GET', `/api/db-commands?executionId=${run.body.executionId}`)).body).toHaveLength(0);
  });

  it('chama API cadastrada com os dados do cliente no ERP', async () => {
    const port = new URL(apiBase).port;
    const erp = await call(editor, 'POST', '/api/erps', { name: 'Consinco', baseUrl: 'http://127.0.0.1:{{porta}}/{{prefixo}}', authType: 'bearer',
      clientFields: [{ name: 'porta', label: 'Porta', secret: false }, { name: 'prefixo', label: 'Prefixo', secret: false }, { name: 'senha', label: 'Senha', secret: true }] });
    expect(erp.status, JSON.stringify(erp.body)).toBe(200);
    const endpoint = await call(editor, 'POST', `/api/erps/${erp.body.id}/endpoints`, {
      name: 'Alteração de preço',
      method: 'PUT',
      path: '/precos/{{sku}}',
      bodyType: 'json',
      body: '{"preco": "{{preco}}"}',
      variables: [
        { name: 'sku', type: 'text', required: true },
        { name: 'preco', type: 'number', required: true },
      ],
    });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(200);
    const erpClient = await call(editor, 'POST', `/api/erps/${erp.body.id}/clients`, { clientId: clientX, values: { porta: port, prefixo: 'v1', senha: 'senha-erp-123' } });
    expect(erpClient.status, JSON.stringify(erpClient.body)).toBe(200);

    const detail = await call(editor, 'GET', `/api/erps/${erp.body.id}`);
    expect(detail.body.clients[0].values).toEqual({ porta: port, prefixo: 'v1', senha: '••••••' });
    const catalog = await call(editor, 'GET', '/api/api-catalog');
    expect(catalog.body.endpoints[0].variables.map((v: { name: string }) => v.name)).toEqual(['sku', 'preco', 'token']);
    expect((await call(viewer, 'GET', '/api/api-catalog')).body.clients).toHaveLength(0);

    const wf = await call(editor, 'POST', '/api/workflows', { name: 'Preço via catálogo', folderId: folderA });
    const definition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        {
          id: 'h',
          name: 'Alterar preço',
          type: 'httpRequest',
          position: { x: 0, y: 0 },
          parameters: { source: 'catalog', erpClient: erpClient.body.id, endpoint: endpoint.body.id, variables: { sku: '={{ $json.sku }}', preco: '9,90', token: 'tok-1' } },
        },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'h', toInput: 0 }],
    };
    const saved = await call(editor, 'PUT', `/api/workflows/${wf.body.id}`, { name: 'Preço via catálogo', folderId: folderA, definition });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const run = await call(editor, 'POST', `/api/workflows/${wf.body.id}/run`, { input: [{ json: { sku: 'ABC' } }] });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status, JSON.stringify(execution.error)).toBe('success');
    expect(execution.runs[1].output[0][0].json).toEqual({ auth: 'Bearer tok-1', path: '/v1/precos/ABC' });

    // A senha do ERP não aparece na auditoria, e o cadastro em uso não pode ser excluído.
    const audit = await call(admin, 'GET', '/api/audit?entityType=erp_client');
    expect(JSON.stringify(audit.body)).not.toContain('senha-erp-123');
    expect((await call(editor, 'DELETE', `/api/erp-clients/${erpClient.body.id}`)).status).toBe(409);
    expect((await call(editor, 'DELETE', `/api/erps/${erp.body.id}`)).status).toBe(409);
  });

  it('importa fluxos do n8n e liga os subfluxos pelo ID antigo', async () => {
    const sub = {
      id: 'n8n-sub',
      name: 'Sub do n8n',
      nodes: [
        { name: 'Recebe', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { name: 'Marca', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return $input.all().map((i) => ({ ...i.json, sub: true }));' } },
      ],
      connections: { Recebe: { main: [[{ node: 'Marca', type: 'main', index: 0 }]] } },
    };
    const parent = {
      id: 'n8n-pai',
      name: 'Pai do n8n',
      active: true,
      nodes: [
        { name: 'Início', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { name: 'Chama', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.1, position: [200, 0], parameters: { workflowId: { __rl: true, value: 'n8n-sub' } } },
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 200], parameters: { path: 'x' } },
      ],
      connections: { Início: { main: [[{ node: 'Chama', type: 'main', index: 0 }]] } },
    };
    // O pai vem antes do subfluxo no arquivo, e mesmo assim aponta para ele.
    const first = await call(editor, 'POST', '/api/workflows/import-n8n', { folderId: folderA, data: [parent, sub] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ['Pai do n8n', 'imported'],
      ['Sub do n8n', 'imported'],
    ]);
    const [pai, filho] = first.body;
    expect(pai.wasActive).toBe(true);
    expect(pai.warnings.map((w: { node?: string }) => w.node)).toContain('Webhook');

    const imported = await call(editor, 'GET', `/api/workflows/${pai.id}`);
    expect(imported.body.active).toBe(false);
    expect(imported.body.definition.nodes.find((n: { name: string }) => n.name === 'Chama').parameters.workflowId).toBe(filho.id);
    expect(imported.body.issues.map((i: { message: string }) => i.message)).toContain('"Webhook" veio do n8n sem equivalente; substitua-o por outros nós');

    // Sem o nó não convertido, o fluxo importado roda chamando o subfluxo importado.
    const definition = { ...imported.body.definition, nodes: imported.body.definition.nodes.filter((n: { name: string }) => n.name !== 'Webhook') };
    const run = await call(editor, 'POST', `/api/workflows/${pai.id}/run`, { definition, input: [{ json: { sku: 'A' } }] });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status, JSON.stringify(execution.error)).toBe('success');
    expect(execution.runs.at(-1).output[0]).toEqual([{ json: { sku: 'A', sub: true } }]);

    // Importar de novo não duplica; um fluxo novo que chama o sub já importado aponta para ele.
    const again = await call(editor, 'POST', '/api/workflows/import-n8n', { folderId: folderA, data: { data: [sub, { ...parent, id: 'n8n-pai-2', name: 'Pai 2' }] } });
    expect(again.body.map((r: { status: string }) => r.status)).toEqual(['skipped', 'imported']);
    const pai2 = await call(editor, 'GET', `/api/workflows/${again.body[1].id}`);
    expect(pai2.body.definition.nodes.find((n: { name: string }) => n.name === 'Chama').parameters.workflowId).toBe(filho.id);

    expect((await call(viewer, 'POST', '/api/workflows/import-n8n', { folderId: folderA, data: sub })).status).toBe(403);
    expect((await call(editor, 'POST', '/api/workflows/import-n8n', { folderId: folderA, data: { nome: 'x' } })).body.error).toMatch(/não parece um fluxo/);
  });

  it('mostra os agendados que esperam vaga no worker', async () => {
    const wf = (await call(editor, 'POST', '/api/workflows', { name: 'Agendado na fila', folderId: folderA })).body;
    // Com a fila pausada, o job fica esperando como ficaria com todas as vagas ocupadas.
    await queue.queue.pause();
    try {
      await queue.queue.add('scheduled', { kind: 'scheduled', workflowId: wf.id });
      const waiting = (await call(viewer, 'GET', '/api/executions/waiting')).body;
      expect(waiting).toEqual([{ workflowId: wf.id, workflowName: 'Agendado na fila', dueAt: expect.any(String) }]);
      expect((await call(admin, 'GET', '/api/executions/waiting')).body).toHaveLength(1);
    } finally {
      await queue.queue.obliterate({ force: true });
      await queue.queue.resume();
    }
  });
});
