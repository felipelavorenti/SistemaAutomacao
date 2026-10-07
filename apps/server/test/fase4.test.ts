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
import { PgDataTableStore } from '../src/lib/data-tables.js';

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

describe.skipIf(!available)('Fase 4: tabelas de dados, comandos e nós só do Administrador', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle;
  let redis: Redis;

  const config: Config = {
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    encryptionKey: parseKey('0'.repeat(64)),
    sessionTtlHours: 1,
    executionRetentionDays: 0,
    keepSuccessData: false,
    filesDirs: [],
    workerConcurrency: 2,
    runWorkerInProcess: true,
    secureCookies: false,
  };

  let admin = '';
  let editor = '';
  let viewer = '';
  let folder = '';

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(res.statusCode, res.body).toBe(200);
    return `sa_session=${res.cookies.find((c) => c.name === 'sa_session')!.value}`;
  }

  async function call(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }

  async function waitExecution(cookie: string, id: string) {
    for (let i = 0; i < 200; i++) {
      const { body } = await call(cookie, 'GET', `/api/executions/${id}`);
      if (!['queued', 'running'].includes(body.status)) return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('A execução não terminou');
  }

  async function createUser(email: string, role: string): Promise<string> {
    const res = await call(admin, 'POST', '/api/users', { email, name: role, role, password: 'senha-temporaria-1', folderIds: [folder], clientIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    let cookie = await loginAs(email, 'senha-temporaria-1');
    await call(cookie, 'POST', '/api/auth/change-password', { currentPassword: 'senha-temporaria-1', newPassword: 'senha-nova-123' });
    cookie = await loginAs(email, 'senha-nova-123');
    return cookie;
  }

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

    admin = await loginAs('admin@teste.com', 'senha-inicial-123');
    await call(admin, 'POST', '/api/auth/change-password', { currentPassword: 'senha-inicial-123', newPassword: 'senha-do-admin-123' });
    admin = await loginAs('admin@teste.com', 'senha-do-admin-123');
    folder = (await call(admin, 'GET', '/api/folders')).body[0].id;
    editor = await createUser('editor@teste.com', 'editor');
    viewer = await createUser('leitor@teste.com', 'viewer');
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    redis?.disconnect();
    await app?.close();
    await db?.end();
  });

  let tableId = '';

  it('cria, lista e altera tabelas; leitor só vê', async () => {
    const created = await call(editor, 'POST', '/api/data-tables', {
      name: 'clientes',
      columns: [
        { name: 'nome', type: 'string' },
        { name: 'idade', type: 'number' },
        { name: 'ativo', type: 'boolean' },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ name: 'clientes', rowCount: 0, columns: [{ name: 'nome', type: 'string' }, { name: 'idade', type: 'number' }, { name: 'ativo', type: 'boolean' }] });
    tableId = created.body.id;

    expect((await call(editor, 'POST', '/api/data-tables', { name: 'clientes' })).body.error).toMatch(/Já existe/);
    expect((await call(editor, 'POST', '/api/data-tables', { name: 'x', columns: [{ name: 'id', type: 'string' }] })).status).toBe(400);
    expect((await call(viewer, 'POST', '/api/data-tables', { name: 'y' })).status).toBe(403);
    expect((await call(viewer, 'GET', '/api/data-tables')).body.map((t: { name: string }) => t.name)).toEqual(['clientes']);

    const changed = await call(editor, 'PUT', `/api/data-tables/${tableId}`, {
      name: 'clientes',
      columns: [
        { name: 'nome', type: 'string' },
        { name: 'idade', type: 'number' },
        { name: 'ativo', type: 'boolean' },
        { name: 'desde', type: 'date' },
      ],
    });
    expect(changed.body.columns).toHaveLength(4);
    expect((await call(editor, 'PUT', `/api/data-tables/${tableId}`, { columns: [{ name: 'idade', type: 'string' }] })).body.error).toMatch(/não pode mudar/);
  });

  it('insere, filtra, altera e apaga linhas pela API', async () => {
    const inserted = await call(editor, 'POST', `/api/data-tables/${tableId}/rows`, {
      rows: [
        { nome: 'Ana', idade: '31', ativo: true, desde: '2024-01-02' },
        { nome: 'ana maria', idade: 40 },
        { nome: 'Carlos', idade: 18, ativo: false },
      ],
    });
    expect(inserted.status, JSON.stringify(inserted.body)).toBe(200);
    expect(inserted.body.map((r: { id: number; idade: number }) => [r.id, r.idade])).toEqual([
      [1, 31],
      [2, 40],
      [3, 18],
    ]);
    expect(inserted.body[0].desde).toBe('2024-01-02T00:00:00.000Z');

    const filter = (f: unknown, extra = '') => call(viewer, 'GET', `/api/data-tables/${tableId}/rows?filter=${encodeURIComponent(JSON.stringify(f))}${extra}`);
    expect((await filter({ type: 'and', conditions: [{ column: 'nome', condition: 'ilike', value: 'ana%' }] })).body).toMatchObject({ total: 2, rows: [{ id: 1 }, { id: 2 }] });
    expect((await filter({ type: 'and', conditions: [{ column: 'nome', condition: 'like', value: 'ana%' }] })).body.total).toBe(1);
    expect((await filter({ type: 'or', conditions: [{ column: 'idade', condition: 'lt', value: 20 }, { column: 'ativo', condition: 'isTrue' }] })).body.rows.map((r: { id: number }) => r.id)).toEqual([
      1, 3,
    ]);
    expect((await filter({ type: 'and', conditions: [{ column: 'ativo', condition: 'isEmpty' }] })).body.rows.map((r: { id: number }) => r.id)).toEqual([2]);
    expect((await filter({ type: 'and', conditions: [{ column: 'ativo', condition: 'neq', value: true }] })).body.rows.map((r: { id: number }) => r.id)).toEqual([2, 3]);
    expect((await filter({ type: 'and', conditions: [] }, '&orderBy=idade&orderDirection=desc&limit=2')).body).toMatchObject({ total: 3, rows: [{ idade: 40 }, { idade: 31 }] });
    expect((await filter({ type: 'and', conditions: [{ column: 'cpf', condition: 'eq', value: 1 }] })).body.error).toMatch(/não tem a coluna "cpf"/);

    const updated = await call(editor, 'PUT', `/api/data-tables/${tableId}/rows/2`, { data: { ativo: 'true' } });
    expect(updated.body).toMatchObject({ id: 2, nome: 'ana maria', ativo: true });
    expect((await call(editor, 'PUT', `/api/data-tables/${tableId}/rows/99`, { data: { ativo: true } })).status).toBe(404);
    expect((await call(editor, 'PUT', `/api/data-tables/${tableId}/rows/2`, { data: { idade: 'abc' } })).body.error).toMatch(/não serve para a coluna "idade"/);

    expect((await call(editor, 'POST', `/api/data-tables/${tableId}/rows/delete`, { ids: [3, 99] })).body).toEqual({ deleted: 1 });
    expect((await call(viewer, 'GET', `/api/data-tables/${tableId}`)).body.rowCount).toBe(2);
  });

  it('o nó Data Table usa as tabelas do banco numa execução', async () => {
    const definition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        {
          id: 'up',
          name: 'Upsert',
          type: 'dataTable',
          position: { x: 200, y: 0 },
          parameters: { resource: 'row', operation: 'upsert', dataTable: 'clientes', mappingMode: 'autoMapInputData', conditions: [{ column: 'nome', condition: 'eq', value: '={{ $json.nome }}' }] },
        },
        { id: 'get', name: 'Buscar', type: 'dataTable', position: { x: 400, y: 0 }, parameters: { resource: 'row', operation: 'get', dataTable: tableId, returnAll: true } },
      ],
      connections: [
        { from: 't', fromOutput: 0, to: 'up', toInput: 0 },
        { from: 'up', fromOutput: 0, to: 'get', toInput: 0 },
      ],
    };
    const wf = await call(editor, 'POST', '/api/workflows', { name: 'Tabela', folderId: folder, definition });
    expect(wf.status, JSON.stringify(wf.body)).toBe(200);
    const run = await call(editor, 'POST', `/api/workflows/${wf.body.id}/run`, { input: [{ json: { nome: 'Ana', idade: 32 } }, { json: { nome: 'Zé', idade: 50 } }] });
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status, JSON.stringify(execution.error)).toBe('success');
    const rows = await new PgDataTableStore(db).getRows(tableId, {});
    expect(rows.map((r) => [r.id, r.nome, r.idade])).toEqual([
      [1, 'Ana', 32],
      [2, 'ana maria', 40],
      [4, 'Zé', 50],
    ]);
  });

  it('Execute Command: só o Administrador cria ou altera; cada comando vai para a Auditoria', async () => {
    const command = { id: 'cmd', name: 'Comando', type: 'executeCommand', position: { x: 200, y: 0 }, parameters: { command: 'echo ola' } };
    const definition = (extra: object[] = []) => ({
      nodes: [{ id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} }, ...extra],
      connections: extra.length ? [{ from: 't', fromOutput: 0, to: (extra[0] as { id: string }).id, toInput: 0 }] : [],
    });

    const denied = await call(editor, 'POST', '/api/workflows', { name: 'Comando', folderId: folder, definition: definition([command]) });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/Só o perfil Administrador pode criar ou alterar o nó "Comando"/);

    const created = await call(admin, 'POST', '/api/workflows', { name: 'Comando', folderId: folder, definition: definition([command]) });
    expect(created.status).toBe(200);
    const id = created.body.id;

    // O editor pode salvar o fluxo sem mexer no nó (renomear o fluxo, mover outro nó)...
    const same = definition([{ ...command, position: { x: 300, y: 50 } }]);
    expect((await call(editor, 'PUT', `/api/workflows/${id}`, { name: 'Comando 2', folderId: folder, definition: same })).status).toBe(200);
    // ...mas não trocar o comando, nem rodar uma definição com o comando trocado.
    const changed = definition([{ ...command, parameters: { command: 'rm -rf /' } }]);
    expect((await call(editor, 'PUT', `/api/workflows/${id}`, { name: 'Comando 2', folderId: folder, definition: changed })).status).toBe(403);
    expect((await call(editor, 'POST', `/api/workflows/${id}/run`, { definition: changed })).status).toBe(403);
    // Tirar o nó pode.
    const removed = await call(editor, 'POST', `/api/workflows/${id}/run`, { definition: definition() });
    expect(removed.status).toBe(200);

    const run = await call(editor, 'POST', `/api/workflows/${id}/run`, {});
    const execution = await waitExecution(editor, run.body.executionId);
    expect(execution.status, JSON.stringify(execution.error)).toBe('success');
    const audit = await call(admin, 'GET', `/api/audit?entityType=execution&entityId=${run.body.executionId}`);
    expect(audit.body).toEqual([
      expect.objectContaining({
        action: 'command',
        entity_name: 'Comando 2',
        user_name: 'editor',
        after: expect.objectContaining({ node: 'Comando', nodeType: 'executeCommand', command: 'echo ola', exitCode: 0 }),
      }),
    ]);
  });

  it('tipos de conexão novos e teste de conexão SMTP', async () => {
    const types = (await call(admin, 'GET', '/api/connection-types')).body.map((t: { type: string }) => t.type);
    expect(types).toEqual(expect.arrayContaining(['smtp', 'ftp', 'sftp', 'ssh', 'gitPassword', 'info8nApi']));
    const ssh = await call(admin, 'POST', '/api/connections', { name: 'Servidor', type: 'ssh', clientId: null, data: { host: '10.0.0.1', user: 'root' } });
    expect(ssh.body.error).toMatch(/Senha ou chave privada/);
    const test = await call(admin, 'POST', '/api/connections/test', { type: 'smtp', data: { host: '127.0.0.1', port: '1', secure: 'false' } });
    expect(test.body).toMatchObject({ ok: false });
  });
});
