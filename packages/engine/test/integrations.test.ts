import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { ConnectionData } from '../src/node-types.js';
import { CLICKUP_API, parseDue } from '../src/nodes/clickup.js';
import { questionId } from '../src/nodes/metabase.js';
import type { JsonObject, NodeInstance, WorkflowDefinition } from '../src/types.js';

interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = '';
const received: Received[] = [];
let handler: (req: Received) => { status?: number; body: unknown } = () => ({ body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body };
      received.push(r);
      const out = handler(r);
      res.statusCode = out.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // As chamadas para a API do ClickUp vão para o servidor local.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    realFetch(String(input).startsWith(CLICKUP_API) ? `${base}/clickup${String(input).slice(CLICKUP_API.length)}` : input, init),
  );
});
afterAll(() => {
  vi.restoreAllMocks();
  server.close();
});

const node = (id: string, type: string, parameters: NodeInstance['parameters'], name = id): NodeInstance => ({ id, name, type, position: { x: 0, y: 0 }, parameters });
const flow = (n: NodeInstance): WorkflowDefinition => ({
  nodes: [node('t', 'manualTrigger', {}, 'Início'), n],
  connections: [{ from: 't', fromOutput: 0, to: n.id, toInput: 0 }],
});
function run(workflow: WorkflowDefinition, input: JsonObject[], connections: Record<string, ConnectionData>) {
  return executeWorkflow({
    workflow,
    executionId: 'x',
    mode: 'manual',
    triggerItems: input.map((json) => ({ json })),
    getConnection: async (id) => connections[id]!,
  });
}

describe('Metabase', () => {
  const card = {
    id: 42,
    parameters: [
      { id: 'p-loja', type: 'number/=', slug: 'loja', name: 'Loja', target: ['variable', ['template-tag', 'loja']] },
      { id: 'p-cat', type: 'category', slug: 'categoria', name: 'Categoria', target: ['variable', ['template-tag', 'categoria']] },
    ],
  };
  const metabaseNode = (parameters: JsonObject) => node('m', 'metabase', { connection: 'mb', question: `${base}/question/42-vendas`, ...parameters }, 'Vendas');

  it('faz login, envia os filtros no formato do Metabase e devolve um item por linha', async () => {
    received.length = 0;
    handler = (r) => {
      if (r.url === '/api/session') return { body: { id: 'sessao-1' } };
      if (r.url === '/api/card/42') return { body: card };
      if (r.url === '/api/card/42/query/json') return { body: [{ Loja: 1, Total: 10 }, { Loja: 1, Total: 5 }] };
      return { status: 404, body: {} };
    };
    const result = await run(
      flow(metabaseNode({ filters: [{ name: 'loja', value: '={{ $json.loja }}' }, { name: 'Categoria', value: 'Bebidas' }] })),
      [{ loja: '1' }],
      { mb: { id: 'mb', type: 'metabase', data: { url: `${base}/`, username: 'ana', password: 'x' } } },
    );
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(result.lastOutput.map((i) => i.json)).toEqual([
      { Loja: 1, Total: 10 },
      { Loja: 1, Total: 5 },
    ]);
    expect(received.map((r) => r.url)).toEqual(['/api/session', '/api/card/42', '/api/card/42/query/json']);
    expect(JSON.parse(received[0]!.body)).toEqual({ username: 'ana', password: 'x' });
    expect(received[1]!.headers['x-metabase-session']).toBe('sessao-1');
    const form = new URLSearchParams(received[2]!.body);
    expect(JSON.parse(form.get('parameters')!)).toEqual([
      { id: 'p-loja', type: 'number/=', target: ['variable', ['template-tag', 'loja']], value: [1] },
      { id: 'p-cat', type: 'category', target: ['variable', ['template-tag', 'categoria']], value: 'Bebidas' },
    ]);
  });

  it('com API key não faz login, e filtro inexistente lista os disponíveis', async () => {
    received.length = 0;
    handler = (r) => (r.url === '/api/card/42' ? { body: card } : { status: 404, body: {} });
    const result = await run(flow(metabaseNode({ filters: [{ name: 'regiao', value: 'Sul' }] })), [{}], {
      mb: { id: 'mb', type: 'metabase', data: { url: base, apiKey: 'mb_chave' } },
    });
    expect(received[0]!.headers['x-api-key']).toBe('mb_chave');
    expect(result.error?.message).toBe('A question 42 não tem o filtro "regiao". Filtros disponíveis: Loja, Categoria');
  });

  it('erro da consulta traz o retorno do Metabase', async () => {
    handler = (r) => (r.url === '/api/card/42/query/json' ? { status: 202, body: { status: 'failed', error: 'Tabela não existe' } } : { body: {} });
    const result = await run(flow(metabaseNode({})), [{}], { mb: { id: 'mb', type: 'metabase', data: { url: base, apiKey: 'k' } } });
    expect(result.error).toMatchObject({ message: 'A question 42 falhou no Metabase: Tabela não existe', details: { body: { error: 'Tabela não existe' } } });
  });

  it('aceita o número ou o link da question', () => {
    expect(questionId('17')).toBe(17);
    expect(questionId('https://bi.empresa/question/305-vendas-por-loja?loja=1')).toBe(305);
    expect(() => questionId('vendas')).toThrow(/número ou o link/);
  });
});

describe('ClickUp', () => {
  const clickupNode = (parameters: JsonObject) =>
    node('c', 'clickup', { connection: 'cu', list: 'https://app.clickup.com/9012/v/li/901234', name: '={{ "Revisar " + $json.sku }}', ...parameters }, 'Tarefa');
  const connections = { cu: { id: 'cu', type: 'clickup', data: { token: 'pk_123' } } };

  it('cria uma tarefa por item com responsável por e-mail, prazo e campos personalizados', async () => {
    received.length = 0;
    handler = (r) => {
      if (r.url === '/clickup/team') return { body: { teams: [{ members: [{ user: { id: 77, email: 'Ana@Empresa.com' } }] }] } };
      if (r.url === '/clickup/list/901234/task') {
        const body = JSON.parse(r.body) as JsonObject;
        return { body: { id: `t-${String(body.name)}`, url: 'https://app.clickup.com/t/x' } };
      }
      return { status: 404, body: {} };
    };
    const result = await run(
      flow(
        clickupNode({
          description: 'Preço **alterado**',
          assignees: 'ana@empresa.com, 55',
          dueDate: '31/12/2026 18:30',
          customFields: [
            { id: 'cf-loja', value: '={{ $json.loja }}' },
            { id: 'cf-obs', value: 'urgente' },
          ],
        }),
      ),
      [
        { sku: 'A1', loja: 3 },
        { sku: 'B2', loja: 4 },
      ],
      connections,
    );
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(result.lastOutput.map((i) => i.json.id)).toEqual(['t-Revisar A1', 't-Revisar B2']);
    const tasks = received.filter((r) => r.url.includes('/task'));
    expect(tasks).toHaveLength(2);
    expect(received.filter((r) => r.url === '/clickup/team')).toHaveLength(1);
    expect(tasks[0]!.headers.authorization).toBe('pk_123');
    expect(JSON.parse(tasks[0]!.body)).toEqual({
      name: 'Revisar A1',
      markdown_content: 'Preço **alterado**',
      assignees: [77, 55],
      due_date: new Date(2026, 11, 31, 18, 30).getTime(),
      due_date_time: true,
      custom_fields: [
        { id: 'cf-loja', value: 3 },
        { id: 'cf-obs', value: 'urgente' },
      ],
    });
  });

  it('erro da API traz o retorno do ClickUp', async () => {
    handler = () => ({ status: 401, body: { err: 'Token invalid', ECODE: 'OAUTH_025' } });
    const result = await run(flow(clickupNode({})), [{ sku: 'A1' }], connections);
    expect(result.error).toMatchObject({
      message: 'O ClickUp respondeu com status 401 Unauthorized',
      details: { statusCode: 401, body: { err: 'Token invalid', ECODE: 'OAUTH_025' }, request: { method: 'POST', url: `${CLICKUP_API}/list/901234/task` } },
    });
  });

  it('entende os formatos de prazo', () => {
    expect(parseDue('05/01/2027')).toEqual({ ms: new Date(2027, 0, 5).getTime(), hasTime: false });
    expect(parseDue('2027-01-05T10:00:00Z')).toEqual({ ms: Date.parse('2027-01-05T10:00:00Z'), hasTime: true });
    expect(() => parseDue('31/02/2027')).toThrow(/Prazo inválido/);
  });
});
