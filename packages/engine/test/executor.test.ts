import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { NodeInstance, WorkflowDefinition } from '../src/types.js';
import { validateWorkflow } from '../src/validate.js';

let server: Server;
let base = '';
let flakyCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/login') {
        res.end(JSON.stringify({ token: 'tok-123' }));
      } else if (url.pathname === '/precos') {
        res.end(JSON.stringify([{ sku: 'A', preco: 10 }, { sku: 'B', preco: 50 }]));
      } else if (url.pathname === '/eco') {
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null, method: req.method, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null }));
      } else if (url.pathname === '/erro') {
        res.statusCode = 422;
        res.end(JSON.stringify({ mensagem: 'Preço inválido', codigo: 'E42' }));
      } else if (url.pathname === '/instavel') {
        flakyCalls++;
        res.statusCode = flakyCalls < 3 ? 503 : 200;
        res.end(JSON.stringify({ tentativa: flakyCalls }));
      } else if (url.pathname === '/lento') {
        setTimeout(() => res.end('{}'), 500);
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const trigger: NodeInstance = { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} };

function http(id: string, name: string, parameters: NodeInstance['parameters'], settings?: NodeInstance['settings']): NodeInstance {
  return { id, name, type: 'httpRequest', position: { x: 0, y: 0 }, parameters, settings };
}

function chain(...nodes: NodeInstance[]): WorkflowDefinition {
  return {
    nodes,
    connections: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, fromOutput: 0, to: n.id, toInput: 0 })),
  };
}

const run = (workflow: WorkflowDefinition, extra: Partial<Parameters<typeof executeWorkflow>[0]> = {}) =>
  executeWorkflow({ workflow, executionId: 'e1', mode: 'manual', ...extra });

describe('executeWorkflow', () => {
  it('passa o token do login para a próxima chamada', async () => {
    const wf = chain(
      trigger,
      http('l', 'Login', { method: 'POST', url: `${base}/login` }),
      http('e', 'Eco', {
        url: `${base}/eco`,
        headers: [{ name: 'Authorization', value: "=Bearer {{ $node['Login'].json.token }}" }],
        queryParameters: [{ name: 'origem', value: 'teste' }],
      }),
    );
    const result = await run(wf);
    expect(result.status).toBe('success');
    expect(result.lastOutput[0].json).toMatchObject({ auth: 'Bearer tok-123', method: 'GET', query: { origem: 'teste' } });
    expect(result.runs.map((r) => r.nodeName)).toEqual(['Início', 'Login', 'Eco']);
  });

  it('transforma array da resposta em itens e faz uma chamada por item', async () => {
    const wf = chain(
      trigger,
      http('p', 'Preços', { url: `${base}/precos` }),
      http('e', 'Eco', { method: 'POST', url: `${base}/eco`, bodyType: 'json', jsonBody: '={{ { sku: $json.sku, novo: $json.preco * 2 } }}' }),
    );
    const result = await run(wf);
    expect(result.lastOutput.map((i) => i.json.body)).toEqual([{ sku: 'A', novo: 20 }, { sku: 'B', novo: 100 }]);
  });

  it('separa os itens nas saídas do If', async () => {
    const wf: WorkflowDefinition = {
      nodes: [
        trigger,
        http('p', 'Preços', { url: `${base}/precos` }),
        { id: 'i', name: 'Caro?', type: 'if', position: { x: 0, y: 0 }, parameters: { conditions: [{ left: '={{ $json.preco }}', operator: 'gt', right: '20' }] } },
        http('c', 'Caros', { url: `=${base}/eco?sku={{ $json.sku }}` }),
        http('b', 'Baratos', { url: `=${base}/eco?sku={{ $json.sku }}` }),
      ],
      connections: [
        { from: 't', fromOutput: 0, to: 'p', toInput: 0 },
        { from: 'p', fromOutput: 0, to: 'i', toInput: 0 },
        { from: 'i', fromOutput: 0, to: 'c', toInput: 0 },
        { from: 'i', fromOutput: 1, to: 'b', toInput: 0 },
      ],
    };
    const result = await run(wf);
    const ifRun = result.runs.find((r) => r.nodeName === 'Caro?')!;
    expect(ifRun.output.map((o) => o.map((i) => i.json.sku))).toEqual([['B'], ['A']]);
    expect(result.runs.find((r) => r.nodeName === 'Caros')!.output[0][0].json.query).toEqual({ sku: 'B' });
    expect(result.runs.find((r) => r.nodeName === 'Baratos')!.output[0][0].json.query).toEqual({ sku: 'A' });
  });

  it('para com erro trazendo o retorno da API', async () => {
    const result = await run(chain(trigger, http('x', 'Alterar preço', { method: 'PUT', url: `${base}/erro` }), http('n', 'Nunca', { url: `${base}/eco` })));
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({
      nodeName: 'Alterar preço',
      message: 'A API respondeu com status 422 Unprocessable Entity',
      details: { statusCode: 422, body: { mensagem: 'Preço inválido', codigo: 'E42' } },
    });
    expect(result.runs.map((r) => r.nodeName)).not.toContain('Nunca');
  });

  it('continua com o erro como item quando configurado', async () => {
    const result = await run(chain(trigger, http('x', 'Falha', { url: `${base}/erro` }, { continueOnFail: true }), http('n', 'Depois', { url: `=${base}/eco?e={{ $json.details.body.codigo }}` })));
    expect(result.status).toBe('success');
    expect(result.lastOutput[0].json.query).toEqual({ e: 'E42' });
  });

  it('tenta de novo até dar certo', async () => {
    flakyCalls = 0;
    const result = await run(chain(trigger, http('x', 'Instável', { url: `${base}/instavel` }, { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 10 })));
    expect(result.status).toBe('success');
    expect(result.runs[1].tries).toBe(3);
  });

  it('respeita o tempo limite do nó', async () => {
    const result = await run(chain(trigger, http('x', 'Lento', { url: `${base}/lento` }, { timeoutMs: 100 })));
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/tempo limite/);
  });

  it('usa a conexão cadastrada para autenticar', async () => {
    const result = await run(chain(trigger, http('e', 'Eco', { url: `${base}/eco`, connection: 'c1' })), {
      getConnection: async (id) => ({ id, type: 'httpBasicAuth', data: { user: 'u', password: 'p' } }),
    });
    expect(result.lastOutput[0].json.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('pode ser cancelada', async () => {
    const controller = new AbortController();
    const promise = run(chain(trigger, http('x', 'Lento', { url: `${base}/lento` })), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await promise).status).toBe('canceled');
  });

  it('entrega o JSON de entrada ao gatilho manual', async () => {
    const result = await run(chain(trigger, http('e', 'Eco', { url: `=${base}/eco?id={{ $json.id }}` })), { triggerItems: [{ json: { id: 99 } }] });
    expect(result.lastOutput[0].json.query).toEqual({ id: '99' });
  });
});

describe('validateWorkflow', () => {
  it('aponta gatilho ausente, campo obrigatório, nó solto e expressão quebrada', () => {
    const issues = validateWorkflow({
      nodes: [http('a', 'A', { url: '' }), http('b', 'B', { url: '={{ $json.x ' })],
      connections: [],
    }).map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        'O fluxo precisa de um gatilho',
        '"A": o campo URL é obrigatório',
        '"A" não está ligado a nenhum nó',
        expect.stringMatching(/"B": Expressão sem/),
      ]),
    );
  });
});
