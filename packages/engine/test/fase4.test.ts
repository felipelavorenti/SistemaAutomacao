import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server as SshServer } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBinary } from '../src/binary.js';
import { MemoryDataTableStore } from '../src/data-tables.js';
import { executeWorkflow } from '../src/executor.js';
import { converters } from '../src/n8n/convert-server.js';
import type { Ctx, N8nNode } from '../src/n8n/import.js';
import type { CommandLog, ConnectionData } from '../src/node-types.js';
import { dataTable } from '../src/nodes/data-table.js';
import { emailSend } from '../src/nodes/email-send.js';
import { executeCommand, rssFeedRead } from '../src/nodes/execute-command.js';
import { ftp } from '../src/nodes/ftp.js';
import { gitNode, parseLog, parseStatus } from '../src/nodes/git.js';
import { info8nApi } from '../src/nodes/info8n-api.js';
import { ssh } from '../src/nodes/ssh.js';
import { manualTrigger } from '../src/nodes/triggers.js';
import { NodeRegistry } from '../src/registry.js';
import type { Item, JsonObject, WorkflowDefinition } from '../src/types.js';

const registry = new NodeRegistry([manualTrigger, emailSend, ftp, ssh, executeCommand, gitNode, rssFeedRead, info8nApi, dataTable]);

interface RunOptions {
  items?: Item[];
  filesDirs?: string[];
  connections?: Record<string, ConnectionData>;
  dataTables?: MemoryDataTableStore;
  commands?: CommandLog[];
  publicUrl?: string;
}

async function run(type: string, parameters: JsonObject, o: RunOptions = {}) {
  const workflow: WorkflowDefinition = {
    nodes: [
      { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'n', name: 'Nó', type, position: { x: 0, y: 0 }, parameters },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'n', toInput: 0 }],
  };
  return executeWorkflow({
    workflow,
    executionId: 'x',
    mode: 'manual',
    registry,
    triggerItems: o.items ?? [{ json: {} }],
    filesDirs: o.filesDirs ?? [],
    dataTables: o.dataTables,
    publicUrl: o.publicUrl,
    onCommand: (entry) => {
      o.commands?.push(entry);
    },
    getConnection: async (id) => {
      const c = o.connections?.[id];
      if (!c) throw new Error(`conexão ${id} não existe`);
      return c;
    },
  });
}

async function output(type: string, parameters: JsonObject, o?: RunOptions) {
  const r = await run(type, parameters, o);
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return r.lastOutput;
}

async function failure(type: string, parameters: JsonObject, o?: RunOptions) {
  const r = await run(type, parameters, o);
  expect(r.status).toBe('error');
  return r.error?.message ?? '';
}

function convert(type: string, parameters: Record<string, unknown>, extra: Partial<N8nNode> = {}) {
  const warnings: string[] = [];
  const node: N8nNode = { name: 'N', type: `n8n-nodes-base.${type}`, typeVersion: 1, parameters, ...extra };
  const ctx: Ctx = { node, params: parameters, warn: (m) => warnings.push(m), options: {}, timezone: 'America/Sao_Paulo' };
  return { converted: converters[type]!(ctx), warnings };
}

const listen = (server: HttpServer | NetServer) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

// ---------------------------------------------------------------------
describe('Data Table', () => {
  const setup = async () => {
    const store = new MemoryDataTableStore();
    await store.create('clientes', [
      { name: 'nome', type: 'string' },
      { name: 'idade', type: 'number' },
      { name: 'ativo', type: 'boolean' },
      { name: 'desde', type: 'date' },
    ]);
    return store;
  };

  it('insere pelos campos do item (ignora os que não são colunas) e converte os tipos', async () => {
    const store = await setup();
    const out = await output(
      'dataTable',
      { resource: 'row', operation: 'insert', dataTable: 'clientes', mappingMode: 'autoMapInputData' },
      { dataTables: store, items: [{ json: { nome: 'Ana', idade: '31', ativo: 'true', desde: '2024-01-02', extra: 1 } }, { json: { nome: 'Bia', idade: 25 } }] },
    );
    expect(out.map((i) => i.json)).toMatchObject([
      { id: 1, nome: 'Ana', idade: 31, ativo: true, desde: '2024-01-02T00:00:00.000Z' },
      { id: 2, nome: 'Bia', idade: 25, ativo: null, desde: null },
    ]);
    expect(out[0]!.json.createdAt).toEqual(expect.any(String));
  });

  it('busca com condições, ordem e limite; atualiza, faz upsert e apaga', async () => {
    const store = await setup();
    const table = await store.get('clientes');
    await store.insertRows(table.id, [
      { nome: 'Ana', idade: 31 },
      { nome: 'ana maria', idade: 40 },
      { nome: 'Carlos', idade: 18 },
    ]);
    const get = (conditions: JsonObject[], extra: JsonObject = {}) =>
      output('dataTable', { resource: 'row', operation: 'get', dataTable: table.id, conditions, returnAll: true, ...extra }, { dataTables: store });
    expect((await get([{ column: 'nome', condition: 'ilike', value: 'ana%' }])).map((i) => i.json.nome)).toEqual(['Ana', 'ana maria']);
    expect((await get([{ column: 'nome', condition: 'like', value: 'ana%' }])).map((i) => i.json.nome)).toEqual(['ana maria']);
    expect((await get([{ column: 'idade', condition: 'gte', value: '31' }], { orderBy: 'idade', orderDirection: 'desc' })).map((i) => i.json.idade)).toEqual([40, 31]);
    expect(
      (await get([{ column: 'idade', condition: 'lt', value: 20 }, { column: 'nome', condition: 'eq', value: 'Ana' }], { matchType: 'anyCondition' })).map((i) => i.json.nome),
    ).toEqual(['Ana', 'Carlos']);
    expect(await get([], { returnAll: false, limit: 1 })).toHaveLength(1);

    const updated = await output(
      'dataTable',
      { resource: 'row', operation: 'update', dataTable: 'clientes', mappingMode: 'defineBelow', values: [{ column: 'ativo', value: 'true' }], conditions: [{ column: 'idade', condition: 'gt', value: 30 }] },
      { dataTables: store },
    );
    expect(updated.map((i) => [i.json.nome, i.json.ativo])).toEqual([
      ['Ana', true],
      ['ana maria', true],
    ]);

    const upsert = (nome: string, idade: number) =>
      output(
        'dataTable',
        { resource: 'row', operation: 'upsert', dataTable: 'clientes', mappingMode: 'autoMapInputData', conditions: [{ column: 'nome', condition: 'eq', value: '={{ $json.nome }}' }] },
        { dataTables: store, items: [{ json: { nome, idade } }] },
      );
    expect((await upsert('Carlos', 19))[0]!.json).toMatchObject({ id: 3, idade: 19 });
    expect((await upsert('Duda', 22))[0]!.json).toMatchObject({ id: 4, nome: 'Duda' });

    const dry = await output('dataTable', { resource: 'row', operation: 'deleteRows', dataTable: 'clientes', conditions: [{ column: 'ativo', condition: 'isTrue' }], dryRun: true }, { dataTables: store });
    expect(dry).toHaveLength(2);
    expect(await store.getRows(table.id, {})).toHaveLength(4);
    await output('dataTable', { resource: 'row', operation: 'deleteRows', dataTable: 'clientes', conditions: [{ column: 'ativo', condition: 'isTrue' }] }, { dataTables: store });
    expect((await store.getRows(table.id, {})).map((r) => r.nome)).toEqual(['Carlos', 'Duda']);

    expect(await failure('dataTable', { resource: 'row', operation: 'deleteRows', dataTable: 'clientes', conditions: [] }, { dataTables: store })).toMatch(/ao menos uma condição/);
  });

  it('se existe / se não existe deixam passar o item; erros claros de coluna e tipo', async () => {
    const store = await setup();
    await store.insertRows((await store.get('clientes')).id, [{ nome: 'Ana' }]);
    const cond = (value: string) => [{ column: 'nome', condition: 'eq', value }];
    const items = [{ json: { pedido: 7 } }];
    expect(await output('dataTable', { resource: 'row', operation: 'rowExists', dataTable: 'clientes', conditions: cond('Ana') }, { dataTables: store, items })).toEqual(items);
    expect(await output('dataTable', { resource: 'row', operation: 'rowExists', dataTable: 'clientes', conditions: cond('Zé') }, { dataTables: store, items })).toEqual([]);
    expect(await output('dataTable', { resource: 'row', operation: 'rowNotExists', dataTable: 'clientes', conditions: cond('Zé') }, { dataTables: store, items })).toEqual(items);

    expect(await failure('dataTable', { resource: 'row', operation: 'insert', dataTable: 'clientes', mappingMode: 'defineBelow', values: [{ column: 'cpf', value: '1' }] }, { dataTables: store })).toMatch(
      /não tem a coluna "cpf"/,
    );
    expect(await failure('dataTable', { resource: 'row', operation: 'insert', dataTable: 'clientes', mappingMode: 'defineBelow', values: [{ column: 'idade', value: 'abc' }] }, { dataTables: store })).toMatch(
      /não serve para a coluna "idade"/,
    );
    expect(await failure('dataTable', { resource: 'row', operation: 'get', dataTable: 'nada' }, { dataTables: store })).toMatch(/"nada" não existe/);
  });

  it('tabela: cria (ou reaproveita), lista, renomeia e exclui', async () => {
    const store = new MemoryDataTableStore();
    const create = { resource: 'table', operation: 'create', tableName: 'estoque', tableColumns: [{ name: 'sku', type: 'string' }, { name: 'qtd', type: 'number' }] };
    const [created] = await output('dataTable', create, { dataTables: store });
    expect(created!.json).toMatchObject({ name: 'estoque', columns: [{ name: 'sku', type: 'string' }, { name: 'qtd', type: 'number' }] });
    expect(await failure('dataTable', create, { dataTables: store })).toMatch(/Já existe/);
    expect((await output('dataTable', { ...create, reuseExisting: true }, { dataTables: store }))[0]!.json.id).toBe(created!.json.id);
    expect(await failure('dataTable', { ...create, tableName: 'x', tableColumns: [{ name: 'id', type: 'string' }] }, { dataTables: store })).toMatch(/já existe em toda tabela/);
    expect((await output('dataTable', { resource: 'table', operation: 'list', returnAll: true }, { dataTables: store })).map((i) => i.json.name)).toEqual(['estoque']);
    await output('dataTable', { resource: 'table', operation: 'update', dataTable: 'estoque', newName: 'estoque2' }, { dataTables: store });
    await output('dataTable', { resource: 'table', operation: 'delete', dataTable: 'estoque2' }, { dataTables: store });
    expect(await store.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------
describe('Execute Command', () => {
  it('roda uma vez (padrão) ou por item, e cada comando vai para a auditoria', async () => {
    const commands: CommandLog[] = [];
    const items = [{ json: { n: 1 } }, { json: { n: 2 } }];
    const once = await output('executeCommand', { command: '=echo oi-{{ $json.n }}' }, { items, commands });
    expect(once.map((i) => i.json)).toEqual([{ exitCode: 0, stderr: '', stdout: 'oi-1' }]);
    const each = await output('executeCommand', { executeOnce: false, command: '=echo oi-{{ $json.n }}' }, { items, commands });
    expect(each.map((i) => i.json.stdout)).toEqual(['oi-1', 'oi-2']);
    expect(commands.map((c) => [c.nodeType, c.command, c.exitCode])).toEqual([
      ['executeCommand', 'echo oi-1', 0],
      ['executeCommand', 'echo oi-1', 0],
      ['executeCommand', 'echo oi-2', 0],
    ]);
  });

  it('código de saída diferente de 0 é erro, com a saída nos detalhes e na auditoria', async () => {
    const commands: CommandLog[] = [];
    const r = await run('executeCommand', { command: 'echo parcial; echo falhou >&2; exit 3' }, { commands });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('O comando terminou com o código 3: falhou');
    expect(r.error?.details).toEqual({ exitCode: 3, stdout: 'parcial', stderr: 'falhou' });
    expect(commands[0]).toMatchObject({ exitCode: 3, error: 'falhou' });
  });
});

// ---------------------------------------------------------------------
describe('RSS Read', () => {
  let server: HttpServer;
  let url = '';
  beforeAll(async () => {
    server = createHttpServer((_req, res) => {
      res.setHeader('Content-Type', 'application/rss+xml');
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
        <item><title>Primeira</title><link>https://x/1</link><pubDate>Mon, 06 Oct 2026 10:00:00 GMT</pubDate></item>
        <item><title>Segunda</title><link>https://x/2</link></item></channel></rss>`);
    });
    url = `http://127.0.0.1:${await listen(server)}/feed`;
  });
  afterAll(() => server.close());

  it('cada notícia vira um item', async () => {
    const out = await output('rssFeedRead', { url });
    expect(out.map((i) => i.json.title)).toEqual(['Primeira', 'Segunda']);
    expect(out[0]!.json).toMatchObject({ link: 'https://x/1', isoDate: '2026-10-06T10:00:00.000Z' });
  });

  it('URL inválida dá erro claro', async () => {
    expect(await failure('rssFeedRead', { url: 'ftp://x' })).toMatch(/precisa começar com http/);
  });
});

// ---------------------------------------------------------------------
describe('Send Email (SMTP)', () => {
  let server: NetServer;
  let port = 0;
  const received: { from: string; to: string[]; data: string; auth?: string }[] = [];

  beforeAll(async () => {
    // Servidor SMTP mínimo: aceita AUTH PLAIN e guarda as mensagens.
    server = createNetServer((socket) => {
      let mail: { from: string; to: string[]; data: string; auth?: string } = { from: '', to: [], data: '' };
      let inData = false;
      let buffer = '';
      socket.write('220 teste ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let at: number;
        while ((at = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              received.push(mail);
              mail = { from: '', to: [], data: '', auth: mail.auth };
              socket.write('250 2.0.0 Ok: queued as ABC123\r\n');
            } else mail.data += `${line}\n`;
            continue;
          }
          const cmd = line.toUpperCase();
          if (cmd.startsWith('EHLO')) socket.write('250-teste\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (cmd.startsWith('AUTH PLAIN')) {
            mail.auth = Buffer.from(line.slice(11), 'base64').toString('utf8');
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (cmd.startsWith('MAIL FROM')) {
            mail.from = line.slice(10);
            socket.write('250 Ok\r\n');
          } else if (cmd.startsWith('RCPT TO')) {
            if (line.includes('recusado@')) socket.write('550 5.1.1 Usuário não existe\r\n');
            else {
              mail.to.push(line.slice(8));
              socket.write('250 Ok\r\n');
            }
          } else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd === 'QUIT') socket.end('221 Bye\r\n');
          else socket.write('250 Ok\r\n');
        }
      });
    });
    port = await listen(server);
  });
  afterAll(() => server.close());

  const connections = (): Record<string, ConnectionData> => ({
    smtp: { id: 'smtp', type: 'smtp', data: { host: '127.0.0.1', port: String(port), secure: 'false', disableStartTls: 'true', user: 'robo', password: 'segredo' } },
  });

  it('envia um e-mail por item, com cópia, HTML e texto e anexos', async () => {
    received.length = 0;
    const out = await output(
      'emailSend',
      {
        connection: 'smtp',
        fromEmail: 'Info8n <robo@empresa.com>',
        toEmail: '={{ $json.para }}',
        ccEmail: 'gestor@empresa.com',
        subject: '=Pedido {{ $json.id }}',
        emailFormat: 'both',
        html: '<b>Olá</b>',
        text: 'Olá',
        attachments: 'data',
      },
      { connections: connections(), items: [{ json: { id: 1, para: 'a@x.com' }, binary: { data: toBinary(Buffer.from('a;b'), { fileName: 'r.csv' }) } }] },
    );
    expect(out[0]!.json).toMatchObject({ accepted: ['a@x.com', 'gestor@empresa.com'], rejected: [], response: expect.stringContaining('250') });
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe('\0robo\0segredo');
    expect(received[0]!.data).toMatch(/Subject: Pedido 1/);
    expect(received[0]!.data).toMatch(/text\/html/);
    expect(received[0]!.data).toMatch(/filename=r\.csv/);
  });

  it('destinatário recusado vira erro claro', async () => {
    expect(await failure('emailSend', { connection: 'smtp', fromEmail: 'robo@empresa.com', toEmail: 'recusado@x.com', subject: 'x', html: 'x' }, { connections: connections() })).toMatch(
      /O servidor SMTP não aceitou o e-mail/,
    );
  });
});

// ---------------------------------------------------------------------
describe('SSH', () => {
  let server: SshServer;
  let port = 0;
  const execs: string[] = [];

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
    server = new SshServer({ hostKeys: [privateKey] }, (client) => {
      client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'p' ? ctx.accept() : ctx.reject()));
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec();
            execs.push(info.command);
            if (info.command.includes('falha')) {
              stream.stderr.write('deu ruim\n');
              stream.exit(2);
            } else {
              stream.write('saida\n');
              stream.exit(0);
            }
            stream.end();
          });
        });
      });
    });
    port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  });
  afterAll(() => server.close());

  const conn = (password = 'p'): Record<string, ConnectionData> => ({ s: { id: 's', type: 'ssh', data: { host: '127.0.0.1', port: String(port), user: 'u', password } } });

  it('roda o comando na pasta e registra na auditoria', async () => {
    const commands: CommandLog[] = [];
    const out = await output('ssh', { connection: 's', resource: 'command', operation: 'execute', command: 'ls -la', cwd: '/var/log' }, { connections: conn(), commands });
    expect(out[0]!.json).toEqual({ code: 0, signal: null, stdout: 'saida', stderr: '' });
    expect(execs.at(-1)).toBe('cd /var/log && ls -la');
    expect(commands).toEqual([expect.objectContaining({ nodeType: 'ssh', command: 'cd /var/log && ls -la', host: `u@127.0.0.1:${port}`, exitCode: 0 })]);

    const fail = await output('ssh', { connection: 's', command: 'falha', cwd: "/pasta com 'aspas'" }, { connections: conn() });
    expect(fail[0]!.json).toMatchObject({ code: 2, stderr: 'deu ruim' });
    expect(execs.at(-1)).toBe(`cd '/pasta com '\\''aspas'\\''' && falha`);
  });

  it('senha errada dá erro com o servidor', async () => {
    expect(await failure('ssh', { connection: 's', command: 'ls' }, { connections: conn('x') })).toMatch(/Não foi possível entrar por SSH em 127\.0\.0\.1/);
  });
});

// ---------------------------------------------------------------------
describe('Git', () => {
  let root = '';
  let origin = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'info8n-git-'));
    origin = path.join(root, 'origem.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', origin, seed]);
    await writeFile(path.join(seed, 'README.md'), '# oi\n');
    execFileSync('git', ['-C', seed, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--allow-empty', '-m', 'inicio']);
    execFileSync('git', ['-C', seed, 'add', '.']);
    execFileSync('git', ['-C', seed, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-m', 'readme']);
    execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD:main']);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const git = (parameters: JsonObject) => output('git', { repositoryPath: path.join(root, 'trabalho'), ...parameters }, { filesDirs: [root] });

  it('clona, configura, adiciona, faz commit, tag, log, status e push', async () => {
    expect(await git({ operation: 'clone', sourceRepository: origin })).toEqual([{ json: { success: true } }]);
    await git({ operation: 'userSetup', userName: 'Robô', userEmail: 'robo@empresa.com' });
    await mkdir(path.join(root, 'trabalho', 'relatorios'), { recursive: true });
    await writeFile(path.join(root, 'trabalho', 'relatorios', 'a.csv'), 'a;b\n');
    const [status] = await git({ operation: 'status' });
    expect(status!.json).toMatchObject({ current: 'main', tracking: 'origin/main', not_added: ['relatorios/'] });
    await git({ operation: 'add', pathsToAdd: 'relatorios/' });
    await git({ operation: 'commit', message: 'relatório do dia' });
    await git({ operation: 'tag', name: 'v1' });
    const log = await git({ operation: 'log', limit: 2 });
    expect(log.map((i) => i.json.message)).toEqual(['relatório do dia', 'readme']);
    expect(log[0]!.json).toMatchObject({ author_name: 'Robô', author_email: 'robo@empresa.com', refs: expect.stringContaining('tag: v1') });
    expect((await git({ operation: 'status' }))[0]!.json).toMatchObject({ ahead: 1 });
    await git({ operation: 'push' });
    await git({ operation: 'pushTags' });
    expect(execFileSync('git', ['-C', origin, 'log', '--format=%s', '-1', 'main']).toString().trim()).toBe('relatório do dia');
    expect(execFileSync('git', ['-C', origin, 'tag']).toString().trim()).toBe('v1');
    const config = await git({ operation: 'listConfig' });
    expect(config.map((i) => i.json)).toEqual(expect.arrayContaining([{ _key: 'user.name', _value: 'Robô' }]));
    await git({ operation: 'switchBranch', branchName: 'nova', createBranch: true });
    expect((await git({ operation: 'status' }))[0]!.json.current).toBe('nova');
  });

  it('recusa caminho fora de FILES_DIRS, opção disfarçada de valor e configuração perigosa', async () => {
    expect(await failure('git', { operation: 'status', repositoryPath: '/etc' }, { filesDirs: [root] })).toMatch(/fora das pastas liberadas/);
    expect(await failure('git', { operation: 'clone', repositoryPath: path.join(root, 'x'), sourceRepository: '--upload-pack=touch /tmp/pwn' }, { filesDirs: [root] })).toMatch(
      /não pode começar com "-"/,
    );
    expect(await failure('git', { operation: 'addConfig', repositoryPath: path.join(root, 'trabalho'), key: 'core.fsmonitor', value: 'touch /tmp/pwn' }, { filesDirs: [root] })).toMatch(
      /não pode ser mudada pelo nó/,
    );
    await git({ operation: 'addConfig', key: 'pull.rebase', value: 'true' });
  });

  it('parseStatus e parseLog seguem os campos do simple-git', () => {
    expect(parseStatus('## main...origin/main [ahead 2, behind 1]\n M a.txt\nA  b.txt\nR  c -> d\n?? e\nUU f\n')).toMatchObject({
      current: 'main',
      tracking: 'origin/main',
      ahead: 2,
      behind: 1,
      modified: ['a.txt'],
      created: ['b.txt'],
      renamed: [{ from: 'c', to: 'd' }],
      not_added: ['e'],
      conflicted: ['f'],
      staged: ['b.txt', 'd'],
    });
    expect(parseLog('\x1eh1\x1f2026-01-01\x1fmsg\x1f\x1fcorpo\n\x1fAna\x1fa@x\n')).toEqual([
      { hash: 'h1', date: '2026-01-01', message: 'msg', refs: '', body: 'corpo', author_name: 'Ana', author_email: 'a@x' },
    ]);
  });
});

// ---------------------------------------------------------------------
describe('Info8n (API)', () => {
  let server: HttpServer;
  let base = '';
  const calls: { method: string; url: string; auth?: string; body: string }[] = [];
  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/workflows') return res.end(JSON.stringify([{ id: 'w1', name: 'Pedidos', active: true }, { id: 'w2', name: 'Notas', active: false }]));
        if (req.url === '/api/workflows/w1' && req.method === 'GET') return res.end(JSON.stringify({ id: 'w1', name: 'Pedidos', folder_id: 'f1', definition: { nodes: [], connections: [] } }));
        if (req.url === '/api/workflows/w1' && req.method === 'PUT') return res.end(body);
        if (req.url === '/api/workflows/w1/run') return res.end(JSON.stringify({ executionId: 'e9' }));
        if (req.url?.startsWith('/api/executions')) return res.end(JSON.stringify([{ id: 'e1', status: 'error', created_at: '2026-10-07T10:00:00.000Z' }]));
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Fluxo não encontrado' }));
      });
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => server.close());

  const connections = { api: { id: 'api', type: 'info8nApi', data: { baseUrl: '', apiKey: 'tok123' } } };

  it('lista fluxos (com filtro), altera mantendo o que falta e executa', async () => {
    const list = await output('info8n', { connection: 'api', resource: 'workflow', operation: 'getAll', activeWorkflows: true, returnAll: true }, { connections, publicUrl: base });
    expect(list.map((i) => i.json.id)).toEqual(['w1']);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/workflows', auth: 'Bearer tok123' });

    const [updated] = await output('info8n', { connection: 'api', resource: 'workflow', operation: 'update', workflowId: 'w1', workflowObject: '{"name":"Pedidos 2"}' }, { connections, publicUrl: base });
    expect(updated!.json).toEqual({ name: 'Pedidos 2', folderId: 'f1', definition: { nodes: [], connections: [] } });

    const [ran] = await output('info8n', { connection: 'api', resource: 'workflow', operation: 'run', workflowId: 'w1', runInput: '[{"pedido":1}]' }, { connections, publicUrl: base });
    expect(ran!.json).toEqual({ executionId: 'e9' });
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ input: [{ json: { pedido: 1 } }] });
  });

  it('lista execuções com filtros e mostra o erro da API', async () => {
    const out = await output('info8n', { connection: 'api', resource: 'execution', operation: 'getAll', statusFilter: 'error', workflowFilter: 'w1', limit: 5 }, { connections, publicUrl: base });
    expect(out[0]!.json.id).toBe('e1');
    expect(calls.at(-1)!.url).toBe('/api/executions?workflowId=w1&status=error&limit=5');
    expect(await failure('info8n', { connection: 'api', resource: 'workflow', operation: 'get', workflowId: 'zzz' }, { connections, publicUrl: base })).toMatch(/status 404/);
    expect(await failure('info8n', { connection: 'api', resource: 'execution', operation: 'delete', executionId: 'e1' }, { connections, publicUrl: base })).toMatch(/não tem a operação/);
  });
});

// ---------------------------------------------------------------------
describe('importador do n8n: servidor e protocolos', () => {
  it('Send Email v2.1 e v1', () => {
    const r = convert(
      'emailSend',
      { fromEmail: 'a@x', toEmail: 'b@x', subject: 'S', emailFormat: 'both', html: '<b>x</b>', text: 'x', options: { ccEmail: 'c@x', attachments: 'data', appendAttribution: false } },
      { typeVersion: 2.1 },
    );
    expect(r.converted).toMatchObject({ type: 'emailSend', parameters: { emailFormat: 'both', ccEmail: 'c@x', attachments: 'data', connection: '' } });
    expect(r.warnings).toEqual([]);
    expect(convert('emailSend', { fromEmail: 'a', toEmail: 'b', html: '<b>x</b>' }).converted?.parameters.emailFormat).toBe('html');
    expect(convert('emailSend', { operation: 'sendAndWait' }).converted).toBeNull();
  });

  it('FTP, SSH, Execute Command e RSS Read', () => {
    expect(convert('ftp', { protocol: 'sftp', operation: 'delete', path: '/a', options: { folder: true, recursive: true } }).converted?.parameters).toMatchObject({
      operation: 'delete',
      folder: true,
      recursiveDelete: true,
    });
    expect(convert('ssh', { resource: 'file', operation: 'upload', path: '/tmp', options: { fileName: 'x.txt' } }).converted?.parameters).toMatchObject({ resource: 'file', fileName: 'x.txt' });
    expect(convert('executeCommand', { command: 'ls', executeOnce: false }).converted).toEqual({ type: 'executeCommand', parameters: { executeOnce: false, command: 'ls' } });
    expect(convert('rssFeedRead', { url: 'https://x/feed', options: { ignoreSSL: true } }).converted).toEqual({ type: 'rssFeedRead', parameters: { url: 'https://x/feed', ignoreSSL: true } });
  });

  it('Git avisa da pasta liberada; n8n (API) troca credencial por conexão', () => {
    const g = convert('git', { operation: 'push', repositoryPath: '/repo', authentication: 'gitPassword', options: { branch: 'main', targetRepository: 'origin' } });
    expect(g.converted?.parameters).toMatchObject({ operation: 'push', authentication: 'gitPassword', branch: 'main', targetRepository: 'origin' });
    expect(g.warnings).toEqual([expect.stringMatching(/FILES_DIRS/)]);
    const n = convert('n8n', { resource: 'workflow', operation: 'activate', workflowId: { __rl: true, mode: 'list', value: '12' } });
    expect(n.converted?.parameters).toMatchObject({ resource: 'workflow', operation: 'activate', workflowId: '12' });
    expect(convert('n8n', { resource: 'credential', operation: 'delete', credentialId: '5' }).converted?.parameters).toMatchObject({ resource: 'connection', connectionId: '5' });
    expect(convert('n8n', { resource: 'audit', operation: 'generate' }).converted).toBeNull();
  });

  it('Data Table: tabela pelo nome, colunas e condições', () => {
    const r = convert('dataTable', {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'list', value: 'abc', cachedResultName: 'clientes' },
      columns: { mappingMode: 'defineBelow', value: { nome: '={{ $json.nome }}', idade: 30 } },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: 3 }] },
    });
    expect(r.converted?.parameters).toMatchObject({
      dataTable: 'clientes',
      mappingMode: 'defineBelow',
      values: [
        { column: 'nome', value: '={{ $json.nome }}' },
        { column: 'idade', value: 30 },
      ],
      matchType: 'allConditions',
      conditions: [{ column: 'id', condition: 'eq', value: 3 }],
    });
    expect(r.warnings).toEqual([expect.stringMatching(/crie a tabela de dados "clientes"/)]);
  });
});
