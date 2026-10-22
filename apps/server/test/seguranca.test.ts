import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { insecureSettings, parseKey, parseTrustProxy, type Config } from '../src/config.js';
import { createDb, migrate, type Db } from '../src/db/db.js';
import { createRedis, ExecutionQueue } from '../src/executions/queue.js';
import { startWorker, type WorkerHandle } from '../src/executions/worker.js';
import { fixedReferences } from '../src/lib/access.js';
import { ensureAdmin, LoginThrottle } from '../src/lib/auth.js';
import { secretsToRetype } from '../src/lib/connection-types.js';
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
const flow = (nodes: Node[], links: [string, string][] = []) => ({
  nodes: nodes.map((n, i) => ({ position: { x: i * 200, y: 0 }, parameters: {}, ...n })),
  connections: links.map(([from, to]) => ({ from, fromOutput: 0, to, toInput: 0 })),
});

describe('Segurança: regras sem banco', () => {
  it('TRUST_PROXY desligado por padrão', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('10.0.0.5, 172.16.0.0/12')).toEqual(['10.0.0.5', '172.16.0.0/12']);
  });

  it('avisa da senha de exemplo do Postgres', () => {
    const base = { databaseUrl: 'postgres://automacao:troque-esta-senha@postgres:5432/automacao', trustProxy: false } as Config;
    expect(insecureSettings(base).join(' ')).toMatch(/senha do Postgres/);
    expect(insecureSettings({ ...base, databaseUrl: 'postgres://automacao:Xy9-forte@postgres:5432/automacao' })).toEqual([]);
  });

  it('bloqueia o usuário só no computador que errou, e o computador depois de muitos erros', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < LoginThrottle.MAX_PER_USER; i++) t.fail('10.0.0.1', 'Alvo@teste.com');
    expect(t.blocked('10.0.0.1', 'alvo@teste.com')).toMatch(/bloqueado/);
    expect(t.blocked('10.0.0.2', 'alvo@teste.com')).toBeNull();
    t.clearUser('alvo@teste.com');
    expect(t.blocked('10.0.0.1', 'alvo@teste.com')).toBeNull();

    for (let i = 0; i < LoginThrottle.MAX_PER_IP; i++) t.fail('10.0.0.9', `u${i}@teste.com`);
    expect(t.blocked('10.0.0.9', 'outro@teste.com')).toMatch(/deste computador/);
    // Passados 15 minutos, libera.
    expect(t.blocked('10.0.0.9', 'outro@teste.com', Date.now() + LoginThrottle.WINDOW_MS + 1)).toBeNull();
  });

  it('pede a senha de novo quando o servidor muda', () => {
    const fields = [
      { name: 'host', secret: false, label: 'Servidor' },
      { name: 'password', secret: true, label: 'Senha' },
    ];
    const before = { host: '10.0.0.5', password: 'segredo' };
    expect(secretsToRetype(fields, { host: 'evil.com', password: '' }, before, { host: 'evil.com', password: 'segredo' })).toEqual(['Senha']);
    expect(secretsToRetype(fields, { host: 'evil.com', password: 'nova' }, before, { host: 'evil.com', password: 'nova' })).toEqual([]);
    expect(secretsToRetype(fields, { host: '10.0.0.5', password: '' }, before, before)).toEqual([]);
  });

  it('separa valores fixos dos que vêm de expressão', () => {
    const refs = fixedReferences(
      flow([
        { id: 'h', name: 'HTTP', type: 'httpRequest', parameters: { connection: 'fixa', erpClient: '={{ "x" }}' } },
        { id: 'w', name: 'Webhook', type: 'webhook', parameters: { basicAuthConnection: 'do-webhook' } },
        { id: 'e', name: 'Sub', type: 'executeWorkflow', parameters: { workflowId: 'sub-fixo' } },
        { id: 'c', name: 'Code', type: 'code', parameters: { workflowId: 'texto qualquer' } },
      ]) as never,
    );
    expect([...refs.connections].sort()).toEqual(['do-webhook', 'fixa']);
    expect([...refs.erpClients]).toEqual([]);
    expect([...refs.workflows]).toEqual(['sub-fixo']);
  });
});

describe.skipIf(!available)('Segurança', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle;
  let redis: Redis;
  let triggers: TriggerManager;
  let api: Server;
  let apiBase = '';
  let admin = '';
  let editor = '';
  let folderA = '';
  let folderB = '';
  let clientX = '';
  let clientY = '';
  let connY = '';

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

  async function login(email: string, password: string, remoteAddress = '127.0.0.1') {
    return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress });
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await login(email, password);
    expect(res.statusCode, res.body).toBe(200);
    return `sa_session=${res.cookies.find((c) => c.name === 'sa_session')!.value}`;
  }

  async function call(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }

  async function finished(cookie: string, id: string) {
    for (let i = 0; i < 200; i++) {
      const { body } = await call(cookie, 'GET', `/api/executions/${id}`);
      if (['success', 'error', 'canceled'].includes(body.status)) return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`A execução ${id} não terminou`);
  }

  async function createFlow(cookie: string, name: string, folderId: string, definition: ReturnType<typeof flow>) {
    const res = await call(cookie, 'POST', '/api/workflows', { name, folderId, definition });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  }

  async function run(cookie: string, workflowId: string) {
    const res = await call(cookie, 'POST', `/api/workflows/${workflowId}/run`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return finished(cookie, res.body.executionId);
  }

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
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    admin = await loginAs('admin@teste.com', 'senha-inicial-123');
    folderA = (await call(admin, 'POST', '/api/folders', { name: 'Pasta A' })).body.id;
    folderB = (await call(admin, 'POST', '/api/folders', { name: 'Pasta B' })).body.id;
    clientX = (await call(admin, 'POST', '/api/clients', { name: 'Cliente X' })).body.id;
    clientY = (await call(admin, 'POST', '/api/clients', { name: 'Cliente Y' })).body.id;
    await call(admin, 'POST', '/api/users', {
      email: 'editor@teste.com',
      name: 'Editor',
      role: 'editor',
      password: 'senha-do-editor-1',
      folderIds: [folderA],
      clientIds: [clientX],
    });
    await db.query('UPDATE users SET must_change_password = false');
    editor = await loginAs('editor@teste.com', 'senha-do-editor-1');
    connY = (await call(admin, 'POST', '/api/connections', { name: 'Token do Y', type: 'httpBearerAuth', clientId: clientY, data: { token: 'segredo-do-y' } })).body.id;
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

  // ---------- S1 e S2: o que o fluxo devolve não roda como o Info8n ----------

  it('resposta HTML do webhook vem isolada (CSP sandbox)', async () => {
    const id = await createFlow(
      admin,
      'Webhook HTML',
      folderA,
      flow(
        [
          { id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'GET', path: 'pagina', responseMode: 'responseNode' } },
          {
            id: 'r',
            name: 'Responder',
            type: 'respondToWebhook',
            parameters: { respondWith: 'text', responseText: '<script>fetch("/api/users")</script>', responseHeaders: [{ name: 'content-type', value: 'text/html' }] },
          },
        ],
        [['w', 'r']],
      ),
    );
    expect((await call(admin, 'POST', `/api/workflows/${id}/activate`)).status).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/webhook/pagina' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toMatch(/^sandbox /);
    expect(res.headers['content-security-policy']).not.toMatch(/allow-same-origin/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // A tela do Info8n continua protegida contra ser aberta dentro de outro site; o webhook não.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).headers['x-frame-options']).toBe('DENY');
  });

  it('CSS do formulário não fecha o bloco de estilo, e a página não roda script', async () => {
    const id = await createFlow(
      admin,
      'Formulário com CSS',
      folderA,
      flow([
        {
          id: 'f',
          name: 'Formulário',
          type: 'formTrigger',
          parameters: {
            path: 'css',
            formTitle: 'Teste',
            customCss: 'body{color:red}</sty</stylele><script>alert(1)</script>',
            formFields: [
              { fieldLabel: 'Nome', fieldType: 'text' },
              { fieldLabel: 'Aviso', fieldType: 'html', fieldValue: '<b>oi</b><img src=x onerror=alert(1) ' },
            ],
          },
        },
      ]),
    );
    expect((await call(admin, 'POST', `/api/workflows/${id}/activate`)).status).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/form/css' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/<\/style><script/i);
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toMatch(/<img src=x/i);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
  });

  // ---------- S3: conexão, cliente no ERP e subfluxo por expressão ----------

  it('não deixa usar por expressão a conexão de um cliente sem acesso', async () => {
    // Com o ID fixo, nem salva (regra que já existia).
    const fixed = await call(editor, 'POST', '/api/workflows', {
      name: 'Fixo',
      folderId: folderA,
      definition: flow([
        { id: 't', name: 'Início', type: 'manualTrigger' },
        { id: 'h', name: 'HTTP', type: 'httpRequest', parameters: { url: apiBase, connection: connY } },
      ]),
    });
    expect(fixed.status).toBe(403);

    const id = await createFlow(
      editor,
      'Por expressão',
      folderA,
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'h', name: 'HTTP', type: 'httpRequest', parameters: { url: apiBase, connection: `={{ "${connY}" }}` } },
        ],
        [['t', 'h']],
      ),
    );
    const blocked = await run(editor, id);
    expect(blocked.status).toBe('error');
    expect(blocked.error_message).toMatch(/cliente ao qual Editor não tem acesso/);

    // Quem tem acesso ao cliente (aqui o administrador) roda o mesmo fluxo normalmente.
    const ok = await run(admin, id);
    expect(ok.status, ok.error_message).toBe('success');
    expect(ok.runs.at(-1).output[0][0].json.auth).toBe('Bearer segredo-do-y');
  });

  it('webhook (sem usuário) confere o acesso de quem salvou o fluxo', async () => {
    const id = await createFlow(
      editor,
      'Webhook por expressão',
      folderA,
      flow(
        [
          { id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'expressao' } },
          { id: 'h', name: 'HTTP', type: 'httpRequest', parameters: { url: apiBase, connection: `={{ "${connY}" }}` } },
        ],
        [['w', 'h']],
      ),
    );
    expect((await call(editor, 'POST', `/api/workflows/${id}/activate`)).status).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/webhook/expressao', payload: {} })).statusCode).toBe(200);
    let exec: { id: string; status: string } | undefined;
    for (let i = 0; i < 200 && !exec; i++) {
      exec = (await call(admin, 'GET', `/api/executions?workflowId=${id}`)).body.find((e: { status: string }) => e.status === 'error');
      if (!exec) await new Promise((r) => setTimeout(r, 50));
    }
    expect(exec, 'execução do webhook com erro').toBeTruthy();
    expect((await call(admin, 'GET', `/api/executions/${exec!.id}`)).body.error_message).toMatch(/não tem acesso/);
  });

  it('não deixa chamar por expressão um subfluxo de pasta sem acesso', async () => {
    const sub = await createFlow(
      admin,
      'Subfluxo da pasta B',
      folderB,
      flow([
        { id: 's', name: 'Chamado', type: 'executeWorkflowTrigger' },
      ]),
    );
    const id = await createFlow(
      editor,
      'Chama subfluxo',
      folderA,
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'e', name: 'Executar', type: 'executeWorkflow', parameters: { workflowId: `={{ "${sub}" }}` } },
        ],
        [['t', 'e']],
      ),
    );
    const res = await run(editor, id);
    expect(res.status).toBe('error');
    expect(res.error_message).toMatch(/pasta à qual Editor não tem acesso/);
  });

  it('confere também a conexão fixa da autenticação do webhook ao salvar', async () => {
    const basicY = (await call(admin, 'POST', '/api/connections', { name: 'Basic do Y', type: 'httpBasicAuth', clientId: clientY, data: { user: 'u', password: 'p' } })).body.id;
    const res = await call(editor, 'POST', '/api/workflows', {
      name: 'Webhook com senha do Y',
      folderId: folderA,
      definition: flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'y', authentication: 'basicAuth', basicAuthConnection: basicY } }]),
    });
    expect(res.status).toBe(403);
  });

  // ---------- S4: X-Forwarded-For não engana a lista de IPs ----------

  it('ignora o X-Forwarded-For sem TRUST_PROXY', async () => {
    const id = await createFlow(
      admin,
      'Webhook por IP',
      folderA,
      flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'so-ip', ipWhitelist: '10.9.9.9' } }]),
    );
    expect((await call(admin, 'POST', `/api/workflows/${id}/activate`)).status).toBe(200);
    const spoofed = await app.inject({ method: 'POST', url: '/webhook/so-ip', payload: {}, headers: { 'x-forwarded-for': '10.9.9.9' } });
    expect(spoofed.statusCode).toBe(403);
    const real = await app.inject({ method: 'POST', url: '/webhook/so-ip', payload: {}, remoteAddress: '10.9.9.9' });
    expect(real.statusCode).toBe(200);
  });

  // ---------- S5 e S6: login e sessões ----------

  it('erros de senha bloqueiam o usuário só no computador de onde vieram', async () => {
    await call(admin, 'POST', '/api/users', { email: 'dono@teste.com', name: 'Dono', role: 'viewer', password: 'senha-do-dono-1' });
    for (let i = 0; i < LoginThrottle.MAX_PER_USER; i++) await login('dono@teste.com', 'errada', '10.1.1.1');
    const attacker = await login('dono@teste.com', 'senha-do-dono-1', '10.1.1.1');
    expect(attacker.statusCode).toBe(429);
    const owner = await login('dono@teste.com', 'senha-do-dono-1', '10.2.2.2');
    expect(owner.statusCode).toBe(200);
  });

  it('trocar a senha derruba as outras sessões', async () => {
    await call(admin, 'POST', '/api/users', { email: 'sessoes@teste.com', name: 'Sessões', role: 'viewer', password: 'senha-sessoes-1' });
    await db.query("UPDATE users SET must_change_password = false WHERE email = 'sessoes@teste.com'");
    const first = await loginAs('sessoes@teste.com', 'senha-sessoes-1');
    const second = await loginAs('sessoes@teste.com', 'senha-sessoes-1');
    expect((await call(second, 'POST', '/api/auth/change-password', { currentPassword: 'senha-sessoes-1', newPassword: 'senha-sessoes-2' })).status).toBe(200);
    expect((await call(second, 'GET', '/api/auth/me')).status).toBe(200);
    expect((await call(first, 'GET', '/api/auth/me')).status).toBe(401);
  });

  // ---------- S10: token com validade, troca de servidor e ERP ----------

  it('token de API vencido deixa de valer', async () => {
    const created = await call(admin, 'POST', '/api/auth/tokens', { name: 'Curto', expiresInDays: 30 });
    expect(created.status).toBe(200);
    expect(new Date(created.body.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const bearer = { authorization: `Bearer ${created.body.token}` };
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer })).statusCode).toBe(200);
    await db.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [created.body.id]);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer })).statusCode).toBe(401);

    const forever = await call(admin, 'POST', '/api/auth/tokens', { name: 'Sem validade' });
    expect(forever.body.expires_at).toBeNull();
  });

  it('mudar o servidor da conexão exige digitar a senha de novo', async () => {
    const conn = (await call(editor, 'POST', '/api/connections', {
      name: 'Banco do X',
      type: 'postgres',
      clientId: clientX,
      data: { host: '10.0.0.5', port: '5432', database: 'erp', user: 'leitura', password: 'segredo' },
    })).body;
    expect(conn.id, JSON.stringify(conn)).toBeTruthy();
    const moved = await call(editor, 'PUT', `/api/connections/${conn.id}`, {
      name: 'Banco do X',
      type: 'postgres',
      clientId: clientX,
      data: { host: 'servidor-de-fora.com', port: '5432', database: 'erp', user: 'leitura', password: '' },
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/digite de novo: Senha/);
    const retyped = await call(editor, 'PUT', `/api/connections/${conn.id}`, {
      name: 'Banco do X',
      type: 'postgres',
      clientId: clientX,
      data: { host: 'servidor-de-fora.com', port: '5432', database: 'erp', user: 'leitura', password: 'outra' },
    });
    expect(retyped.status, JSON.stringify(retyped.body)).toBe(200);
  });

  it('só quem enxerga todos os clientes do ERP muda a URL base', async () => {
    const erp = (await call(admin, 'POST', '/api/erps', { name: 'ERP Teste', baseUrl: 'https://{{host}}:{{porta}}', authType: 'bearer' })).body;
    expect(erp.id, JSON.stringify(erp)).toBeTruthy();
    await call(admin, 'POST', `/api/erps/${erp.id}/clients`, { clientId: clientY, values: { host: 'y.local', porta: '443', usuario: 'u', senha: 's' } });
    const body = { name: 'ERP Teste', baseUrl: 'https://servidor-de-fora.com', authType: 'bearer' };
    expect((await call(editor, 'PUT', `/api/erps/${erp.id}`, body)).status).toBe(403);
    // Mudar só o nome continua liberado.
    expect((await call(editor, 'PUT', `/api/erps/${erp.id}`, { ...body, name: 'ERP Teste 2', baseUrl: 'https://{{host}}:{{porta}}' })).status).toBe(200);
    expect((await call(admin, 'PUT', `/api/erps/${erp.id}`, body)).status).toBe(200);
  });

  // ---------- N1: "quem usa" não mostra fluxos de pastas sem acesso ----------

  it('lista de quem usa a conexão só mostra os fluxos das pastas do usuário', async () => {
    // Conexão sem cliente: todo mundo enxerga.
    const conn = (await call(admin, 'POST', '/api/connections', { name: 'Compartilhada', type: 'httpBearerAuth', clientId: null, data: { token: 't' } })).body.id;
    const http = (name: string) => flow([{ id: 'h', name, type: 'httpRequest', parameters: { url: apiBase, connection: conn } }]);
    const secret = await createFlow(admin, 'Fechamento da diretoria', folderB, http('HTTP'));
    const mine = await createFlow(editor, 'Fluxo da pasta A', folderA, http('HTTP'));

    expect((await call(editor, 'GET', `/api/connections/${conn}/usage`)).body).toEqual([{ id: mine, name: 'Fluxo da pasta A', active: false }]);
    expect((await call(admin, 'GET', `/api/connections/${conn}/usage`)).body.map((w: { id: string }) => w.id).sort()).toEqual([mine, secret].sort());

    // A exclusão continua bloqueada pelo fluxo da outra pasta, sem dizer o nome dele.
    const refused = await call(editor, 'DELETE', `/api/connections/${conn}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('A conexão é usada pelos fluxos: Fluxo da pasta A e por mais 1 fluxo de pasta que você não acessa');
    expect((await call(admin, 'DELETE', `/api/connections/${conn}`)).body.error).toBe('A conexão é usada pelos fluxos: Fechamento da diretoria, Fluxo da pasta A');
  });

  it('excluir endpoint ou cliente no ERP usado em outra pasta não mostra o nome do fluxo', async () => {
    const erp = (await call(admin, 'POST', '/api/erps', { name: 'ERP Pastas', baseUrl: 'https://erp.local', authType: 'none' })).body.id;
    const endpoint = (await call(admin, 'POST', `/api/erps/${erp}/endpoints`, { name: 'Consulta', method: 'GET', path: '/x' })).body.id;
    const erpClient = (await call(admin, 'POST', `/api/erps/${erp}/clients`, { clientId: clientX, values: {} })).body.id;
    expect(endpoint && erpClient).toBeTruthy();
    await createFlow(
      admin,
      'Fechamento da diretoria pelo ERP',
      folderB,
      flow([{ id: 'h', name: 'ERP', type: 'httpRequest', parameters: { source: 'catalog', erpClient, endpoint, variables: {} } }]),
    );

    const endpointRefused = await call(editor, 'DELETE', `/api/erp-endpoints/${endpoint}`);
    expect(endpointRefused.status).toBe(409);
    expect(endpointRefused.body.error).toBe('O endpoint é usado por 1 fluxo de pasta que você não acessa');
    const clientRefused = await call(editor, 'DELETE', `/api/erp-clients/${erpClient}`);
    expect(clientRefused.status).toBe(409);
    expect(clientRefused.body.error).toBe('O cadastro é usado por 1 fluxo de pasta que você não acessa');
    expect((await call(admin, 'DELETE', `/api/erp-clients/${erpClient}`)).body.error).toBe('O cadastro é usado pelos fluxos: Fechamento da diretoria pelo ERP');
  });

  it('caminho de webhook repetido não diz o nome do fluxo ativo de outra pasta', async () => {
    const webhook = flow([{ id: 'w', name: 'Webhook', type: 'webhook', parameters: { httpMethod: 'POST', path: 'diretoria/folha' } }]);
    const secret = await createFlow(admin, 'Folha da diretoria', folderB, webhook);
    expect((await call(admin, 'POST', `/api/workflows/${secret}/activate`)).status).toBe(200);
    const mine = await createFlow(editor, 'Webhook da pasta A', folderA, webhook);
    const refused = await call(editor, 'POST', `/api/workflows/${mine}/activate`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('O webhook POST "diretoria/folha" já é usado por um fluxo ativo de uma pasta que você não acessa');
    await call(admin, 'POST', `/api/workflows/${secret}/deactivate`);
  });

  it('excluir subfluxo chamado de outra pasta não diz o nome de quem chama', async () => {
    const sub = await createFlow(editor, 'Sub da pasta A', folderA, flow([{ id: 's', name: 'Recebe', type: 'executeWorkflowTrigger' }]));
    await createFlow(
      admin,
      'Chamador da diretoria',
      folderB,
      flow(
        [
          { id: 't', name: 'Início', type: 'manualTrigger' },
          { id: 'e', name: 'Chama', type: 'executeWorkflow', parameters: { workflowId: sub } },
        ],
        [['t', 'e']],
      ),
    );
    const refused = await call(editor, 'DELETE', `/api/workflows/${sub}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Este fluxo é chamado por 1 fluxo de pasta que você não acessa. Remova as chamadas antes de excluir.');
    expect((await call(admin, 'DELETE', `/api/workflows/${sub}`)).body.error).toMatch(/chamado por outros fluxos: Chamador da diretoria\./);
  });

  it('importar de novo um fluxo do n8n que está em outra pasta não diz o nome nem o ID de lá', async () => {
    const n8n = (name: string) => ({
      id: 'n8n-diretoria',
      name,
      nodes: [{ name: 'Início', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    });
    const first = await call(admin, 'POST', '/api/workflows/import-n8n', { folderId: folderB, data: n8n('Folha da diretoria (n8n)') });
    expect(first.body[0].status, JSON.stringify(first.body)).toBe('imported');
    const again = await call(editor, 'POST', '/api/workflows/import-n8n', { folderId: folderA, data: n8n('Qualquer nome') });
    expect(again.status).toBe(200);
    expect(again.body).toEqual([
      { n8nId: 'n8n-diretoria', name: 'Qualquer nome', status: 'skipped', warnings: [{ message: 'já foi importado antes, numa pasta que você não acessa' }] },
    ]);
  });
});
