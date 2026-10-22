import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item, NodeRun } from '@sa/engine';
import { buildApp } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';
import { createDb, migrate, one, type Db } from '../src/db/db.js';
import { createRedis, ExecutionQueue } from '../src/executions/queue.js';
import { createExecution, createRunRecorder, customData, jsonBytesAtLeast, stripBinaries, summarize, trimRuns } from '../src/executions/store.js';
import { startWorker, type WorkerHandle } from '../src/executions/worker.js';
import { ensureAdmin } from '../src/lib/auth.js';
import { TriggerManager } from '../src/triggers/manager.js';

// O gravador de memória não muda o que é gravado (de propósito); a única marca dele é quem o pede, então o teste de ligação espia a fábrica.
vi.mock('../src/executions/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/executions/store.js')>();
  return { ...actual, createRunRecorder: vi.fn(actual.createRunRecorder) };
});

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

const big = (bytes: number): Item[] => [{ json: { texto: 'x'.repeat(bytes) } }];
const many = (n: number, size = 10): Item[] => Array.from({ length: n }, (_, i) => ({ json: { i, texto: 'y'.repeat(size) } }));

let clock = 0;
function run(name: string, input: Item[][], output: Item[][], extra: Partial<NodeRun> = {}): NodeRun {
  clock++;
  return {
    nodeId: name,
    nodeName: name,
    nodeType: 'noOp',
    status: 'success',
    startedAt: new Date(clock * 1000).toISOString(),
    finishedAt: new Date(clock * 1000 + 5).toISOString(),
    durationMs: 5,
    tries: 1,
    input,
    output,
    ...extra,
  };
}

/** O que é gravado hoje (arquivos fora, corte por nó, limite da execução) e o que sai do resumo. */
const saved = (runs: NodeRun[]) => JSON.stringify(trimRuns(stripBinaries(runs, false).runs));

describe('jsonBytesAtLeast', () => {
  const exact = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  it('é o tamanho do JSON quando o texto é simples, e nunca passa dele', () => {
    const plain = [{ json: { a: 1, b: 'texto', c: [1, 2, 3], d: { e: true, f: null, g: -1.5 } } }, { json: {} }];
    expect(jsonBytesAtLeast(plain, 1_000_000)).toBe(exact(plain));
    const hard = [{ json: { acento: 'ação é útil', aspas: 'a"b\\c\n', vazio: undefined, nada: null, inf: Infinity, f: () => 1 } }];
    expect(jsonBytesAtLeast(hard, 1_000_000)).toBeLessThanOrEqual(exact(hard));
    expect(jsonBytesAtLeast(hard, 1_000_000)).toBeGreaterThan(exact(hard) / 2);
  });

  it('para de somar quando passa do limite, sem andar pelo resto', () => {
    let reads = 0;
    const huge = Array.from({ length: 50_000 }, (_, i) => {
      const json: Record<string, unknown> = { i };
      Object.defineProperty(json, 'texto', { enumerable: true, get: () => (reads++, 'z'.repeat(50)) });
      return { json };
    });
    expect(jsonBytesAtLeast(huge, 1_000)).toBeGreaterThan(1_000);
    // Leu os primeiros itens e parou; os outros 49.9 mil nem foram abertos.
    expect(reads).toBeLessThan(100);
  });
});

describe('RunRecorder: o que fica na memória e o que é gravado', () => {
  const record = (runs: NodeRun[]) => runs.map(createRunRecorder());

  function recorded(runs: NodeRun[]) {
    const retained = record(runs);
    return { retained, saved: saved(retained), summary: summarize(retained), custom: customData(retained) };
  }

  it('grava o mesmo que gravava antes e o resumo traz as mesmas contagens, em execuções pequenas', () => {
    const runs = [run('Início', [[]], [many(3)]), run('Um', [many(3)], [many(3)]), run('Dois', [many(3)], [many(2), many(1)])];
    const now = recorded(runs);
    expect(now.saved).toBe(saved(runs));
    expect(now.summary).toEqual(summarize(runs));
    // Passagens pequenas ficam como estão.
    expect(now.retained.every((r, i) => r === runs[i])).toBe(true);
  });

  it('passagem acima de 256 KB vira o aviso na hora, com as contagens no resumo e o mesmo texto gravado', () => {
    const runs = [run('Início', [[]], [many(2)]), run('Grande', [many(2)], [big(300_000), big(10)]), run('Fim', [big(300_000)], [many(1)])];
    const now = recorded(runs);
    expect(now.saved).toBe(saved(runs));
    expect(now.summary).toEqual(summarize(runs));
    expect(now.summary[1]).toMatchObject({ nodeName: 'Grande', inputItems: 2, outputItems: [1, 1] });
    // Na memória não sobrou o texto grande.
    expect(JSON.stringify(now.retained).length).toBeLessThan(5_000);
    expect(now.retained[1].compacted).toEqual({ inputItems: [2], outputItems: [1, 1] });
    // E a execução original não foi mexida: os próximos nós continuam com os itens de verdade.
    expect(JSON.stringify(runs[1].output[0]).length).toBeGreaterThan(300_000);
  });

  it('passado o limite da execução, só a contagem, igual a antes (e sem medir mais nada)', () => {
    // 100 passagens de 200 KB: cada uma cabe no corte por nó, mas juntas passam de 16 MB.
    const runs = Array.from({ length: 100 }, (_, i) => run(`Nó ${i % 3}`, [many(1)], [big(200_000)]));
    const now = recorded(runs);
    expect(now.saved).toBe(saved(runs));
    expect(now.summary).toEqual(summarize(runs));
    const parsed = JSON.parse(now.saved) as NodeRun[];
    expect(parsed.slice(0, 70).every((r) => r.output[0][0].json.texto !== undefined)).toBe(true);
    expect(parsed.at(-1)!.output[0][0].json).toEqual({ _naoGuardado: true, itens: 1 });
    // O que ficou na memória é bem menor que os 20 MB que as passagens ocupavam.
    expect(JSON.stringify(now.retained).length).toBeLessThan(17 * 1024 * 1024);
  });

  it('arquivos dos itens saem da memória, como saem na hora de gravar', () => {
    const file = { fileName: 'a.pdf', mimeType: 'application/pdf', data: 'QUJD'.repeat(500_000) };
    const items: Item[] = [{ json: { n: 1 }, binary: { data: file } }];
    const runs = [run('Baixa', [[]], [items]), run('Segue', [items], [items])];
    const now = recorded(runs);
    expect(now.saved).toBe(saved(runs));
    expect(JSON.stringify(now.retained).length).toBeLessThan(2_000);
    expect(now.retained[0].output[0][0].binary!.data).toMatchObject({ data: '', omitted: true, fileName: 'a.pdf' });
    // O item original continua com o arquivo para o próximo nó.
    expect(runs[0].output[0][0].binary!.data.data.length).toBe(2_000_000);
  });

  it('texto com acento que passa de 256 KB só no JSON é cortado na hora de gravar, como antes', () => {
    // 150 mil "é": 150 mil caracteres, mas 300 mil bytes.
    const runs = [run('Acentos', [[]], [[{ json: { texto: 'é'.repeat(150_000) } }]])];
    const now = recorded(runs);
    expect(now.saved).toBe(saved(runs));
    expect(JSON.parse(now.saved)[0].output[0][0].json._truncado).toBe(true);
  });

  it('lista vazia, vários itens e contagens por saída', () => {
    const runs = [run('A', [[]], [[], many(4)]), run('B', [many(4), []], [many(4)])];
    const now = recorded(runs);
    expect(now.saved).toBe(saved(runs));
    expect(now.summary).toEqual(summarize(runs));
  });

  it('o que o Execution Data guarda continua no resumo', () => {
    const runs = [run('Dados', [[]], [big(300_000)], { meta: { executionData: { pedido: '123' } } })];
    const now = recorded(runs);
    expect(now.custom).toBe(customData(runs));
    expect(now.custom).toBe('{"pedido":"123"}');
  });

  it('não grava o campo interno compacted', () => {
    const now = recorded([run('Grande', [[]], [big(300_000)])]);
    expect(now.saved).not.toContain('compacted');
  });
});

describe.skipIf(!available)('Memória: a execução agendada guarda o mesmo log de antes', () => {
  let db: Db;
  let app: FastifyInstance;
  let queue: ExecutionQueue;
  let worker: WorkerHandle | null = null;
  let redis: Redis;
  let triggers: TriggerManager;
  let admin = '';
  let folder = '';
  let userId = '';

  const config: Config = {
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    encryptionKey: parseKey('0'.repeat(64)),
    sessionTtlHours: 1,
    executionRetentionDays: 0,
    keepSuccessData: false,
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
    for (let i = 0; i < 300; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Esperei e não aconteceu: ${what}`);
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await ensureAdmin(db, { email: 'admin@teste.com', password: 'senha-inicial-123', name: 'Admin' });
    await db.query('UPDATE users SET must_change_password = false');
    userId = (await one<{ id: string }>(db, 'SELECT id FROM users LIMIT 1'))!.id;
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

  // Gera 4 itens de 100 KB (400 KB juntos, acima do corte por nó), passa por um nó que só repassa e termina em erro:
  // o erro faz o log ser gravado, e os dados dos nós vêm junto.
  const definition = {
    nodes: [
      { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'g', name: 'Gera', type: 'code', position: { x: 200, y: 0 }, parameters: { mode: 'all', jsCode: "return Array.from({ length: 4 }, (_, i) => ({ json: { i, texto: 'x'.repeat(100000) } }));" } },
      { id: 'p', name: 'Passa', type: 'noOp', position: { x: 400, y: 0 }, parameters: {} },
      { id: 'e', name: 'Quebra', type: 'code', position: { x: 600, y: 0 }, parameters: { mode: 'all', jsCode: "throw new Error('falhou no fim');" } },
    ],
    connections: [
      { from: 't', fromOutput: 0, to: 'g', toInput: 0 },
      { from: 'g', fromOutput: 0, to: 'p', toInput: 0 },
      { from: 'p', fromOutput: 0, to: 'e', toInput: 0 },
    ],
  };

  const runAs = async (mode: 'schedule' | 'webhook', workflowId: string) => {
    const id = await createExecution(db, { workflowId, workflowVersion: 1, mode, triggeredBy: userId, definition: definition as never });
    await queue.enqueueRun(id);
    await until(async () => (await one<{ status: string }>(db, `SELECT status FROM executions WHERE id = $1 AND status IN ('success', 'error')`, [id]))?.status, 'a execução terminar');
    return id;
  };

  const shape = (runs: NodeRun[]) => runs.map((r) => ({ nodeName: r.nodeName, status: r.status, input: r.input, output: r.output, error: r.error }));

  it('execução agendada com erro grava o mesmo log que a manual, e o resumo conta os itens de verdade', async () => {
    const wf = (await call('POST', '/api/workflows', { name: 'Itens grandes', folderId: folder, definition })).body.id as string;
    const manual = (await call('POST', `/api/workflows/${wf}/run`, {})).body.executionId as string;
    await until(async () => (await one<{ status: string }>(db, `SELECT status FROM executions WHERE id = $1 AND status = 'error'`, [manual]))?.status, 'a execução manual terminar');
    const scheduled = await runAs('schedule', wf);
    const webhook = await runAs('webhook', wf);

    const read = async (id: string) => (await call('GET', `/api/executions/${id}`)).body as { status: string; runs: NodeRun[]; summary: { nodeName: string; inputItems: number; outputItems: number[] }[] };
    const [m, s, w] = [await read(manual), await read(scheduled), await read(webhook)];
    expect(s.status).toBe('error');
    expect(m.runs).toHaveLength(4);
    // O corte por nó aparece nos dois do mesmo jeito (e a manual não passa pelo gravador de memória).
    expect(shape(s.runs)).toEqual(shape(m.runs));
    expect(shape(w.runs)).toEqual(shape(m.runs));
    expect(s.runs[1].output[0][0].json).toMatchObject({ _truncado: true, itens: 4 });
    expect(JSON.stringify(s.runs)).not.toContain('compacted');

    // O resumo conta os itens que passaram, mesmo com os dados trocados pelo aviso.
    const byName = (r: { summary: { nodeName: string; inputItems: number; outputItems: number[] }[] }) =>
      Object.fromEntries(r.summary.map(({ nodeName, inputItems, outputItems }) => [nodeName, { inputItems, outputItems }]));
    expect(byName(s)['Gera']).toEqual({ inputItems: 1, outputItems: [4] });
    expect(byName(s)['Passa']).toEqual({ inputItems: 4, outputItems: [4] });
    expect(byName(s)).toEqual(byName(m));
  });

  it('execução agendada que pausa num Wait e volta grava o mesmo log que a manual', async () => {
    const at = new Date(Date.now() + 1500).toISOString();
    const withWait = {
      nodes: [
        definition.nodes[0],
        definition.nodes[1],
        { id: 'w', name: 'Espera', type: 'wait', position: { x: 300, y: 0 }, parameters: { resume: 'webhook', limitWaitTime: true, limitType: 'atSpecifiedTime', maxDateAndTime: at } },
        definition.nodes[2],
        definition.nodes[3],
      ],
      connections: [
        { from: 't', fromOutput: 0, to: 'g', toInput: 0 },
        { from: 'g', fromOutput: 0, to: 'w', toInput: 0 },
        { from: 'w', fromOutput: 0, to: 'p', toInput: 0 },
        { from: 'p', fromOutput: 0, to: 'e', toInput: 0 },
      ],
    };
    const wf = (await call('POST', '/api/workflows', { name: 'Itens grandes com espera', folderId: folder, definition: withWait })).body.id as string;
    const manual = (await call('POST', `/api/workflows/${wf}/run`, {})).body.executionId as string;
    const scheduled = await createExecution(db, { workflowId: wf, workflowVersion: 1, mode: 'schedule', triggeredBy: userId, definition: withWait as never });
    await queue.enqueueRun(scheduled);
    const status = async (id: string) => (await one<{ status: string }>(db, 'SELECT status FROM executions WHERE id = $1', [id]))?.status;
    await until(async () => (await status(scheduled)) === 'waiting', 'a execução agendada pausar');
    await until(async () => (await status(scheduled)) === 'error', 'a execução agendada voltar e terminar');
    await until(async () => (await status(manual)) === 'error', 'a execução manual voltar e terminar');

    const read = async (id: string) => (await call('GET', `/api/executions/${id}`)).body as { runs: NodeRun[]; summary: { nodeName: string; inputItems: number; outputItems: number[] }[] };
    const [m, s] = [await read(manual), await read(scheduled)];
    expect(s.runs.map((r) => r.nodeName)).toEqual(['Início', 'Gera', 'Espera', 'Passa', 'Quebra']);
    expect(shape(s.runs)).toEqual(shape(m.runs));
    expect(s.runs[1].output[0][0].json).toMatchObject({ _truncado: true, itens: 4 });
    expect(JSON.stringify(s.runs)).not.toContain('compacted');
    const counts = (r: typeof s) => r.summary.map(({ nodeName, inputItems, outputItems }) => ({ nodeName, inputItems, outputItems }));
    expect(counts(s)).toEqual(counts(m));
    expect(counts(s).find((c) => c.nodeName === 'Passa')).toEqual({ nodeName: 'Passa', inputItems: 4, outputItems: [4] });
  });

  describe('quem usa o gravador de memória', () => {
    const recorders = vi.mocked(createRunRecorder);
    beforeEach(() => recorders.mockClear());

    const flow = (name: string, nodes: { id: string; type: string; parameters?: object }[], edges: [string, string][]) => ({
      name,
      folderId: folder,
      definition: {
        nodes: nodes.map((n, i) => ({ name: n.id, position: { x: i * 200, y: 0 }, parameters: {}, ...n })),
        connections: edges.map(([from, to]) => ({ from, fromOutput: 0, to, toInput: 0 })),
      },
    });
    const create = async (body: ReturnType<typeof flow>) => (await call('POST', '/api/workflows', body)).body.id as string;
    const finished = async (id: string) =>
      until(async () => (await one<{ status: string }>(db, `SELECT status FROM executions WHERE id = $1 AND status IN ('success', 'error')`, [id]))?.status, 'a execução terminar');

    it('execução agendada e o subfluxo dela usam; execução manual (com subfluxo) não usa', async () => {
      const child = await create(flow('Filho', [{ id: 'r', type: 'executeWorkflowTrigger' }, { id: 'n', type: 'noOp' }], [['r', 'n']]));
      const parent = await create(flow('Pai', [{ id: 't', type: 'manualTrigger' }, { id: 'x', type: 'executeWorkflow', parameters: { workflowId: child } }], [['t', 'x']]));

      const manual = (await call('POST', `/api/workflows/${parent}/run`, {})).body.executionId as string;
      expect(await finished(manual)).toBe('success');
      expect(recorders).not.toHaveBeenCalled();

      const id = await createExecution(db, { workflowId: parent, workflowVersion: 1, mode: 'schedule', triggeredBy: userId, definition: (await one<{ definition: never }>(db, 'SELECT definition FROM workflows WHERE id = $1', [parent]))!.definition });
      await queue.enqueueRun(id);
      expect(await finished(id)).toBe('success');
      // Um gravador para a execução e outro para o subfluxo (cada execução tem a sua conta de bytes).
      expect(recorders).toHaveBeenCalledTimes(2);
    });
  });
});
