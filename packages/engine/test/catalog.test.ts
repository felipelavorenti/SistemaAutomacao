import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiEndpointData } from '../src/catalog.js';
import { fillJsonTemplate, fillTemplate } from '../src/catalog.js';
import { executeWorkflow } from '../src/executor.js';
import type { WorkflowDefinition } from '../src/types.js';

let server: Server;
let port = 0;
const received: { method: string; url: string; auth: string | null; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/login') return res.end(JSON.stringify({ token: 'tok-9' }));
      if (req.headers.authorization !== 'Bearer tok-9') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ erro: 'token inválido' }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

describe('modelos do catálogo', () => {
  it('troca variáveis no texto e mantém o tipo no JSON', () => {
    expect(fillTemplate('http://{{host}}:{{ porta }}/x', { host: 'h', porta: 80 })).toBe('http://h:80/x');
    expect(fillJsonTemplate('{"preco": "{{preco}}", "obs": "R$ {{preco}}", "itens": "{{itens}}"}', { preco: 9.5, itens: [1, 2] })).toEqual({
      preco: 9.5,
      obs: 'R$ 9.5',
      itens: [1, 2],
    });
    expect(() => fillTemplate('{{nada}}', {})).toThrow(/nada/);
  });
});

describe('HTTP Request com API cadastrada', () => {
  const erp = () => ({ erpName: 'Consinco', clientName: 'Cliente X', baseUrl: `http://127.0.0.1:${port}/{{prefixo}}`, clientValues: { prefixo: 'api', usuario: 'joao', senha: 's3nha' } });
  const endpoints = (): Record<string, ApiEndpointData> => ({
    login: {
      ...erp(),
      endpointName: 'Login',
      authType: 'bearer',
      usesAuth: false,
      method: 'POST',
      path: '/login',
      headers: [],
      query: [],
      bodyType: 'json',
      body: '{"usuario": "{{usuario}}", "senha": "{{senha}}"}',
      variables: [],
    },
    preco: {
      ...erp(),
      endpointName: 'Alteração de preço',
      authType: 'bearer',
      usesAuth: true,
      method: 'PUT',
      path: '/produtos/{{sku}}/preco',
      headers: [{ name: 'x-loja', value: '{{loja}}' }],
      query: [],
      bodyType: 'json',
      body: '{"preco": "{{preco}}"}',
      variables: [
        { name: 'sku', type: 'text', required: true },
        { name: 'preco', type: 'number', required: true },
        { name: 'loja', type: 'text', required: false, default: '1' },
      ],
    },
  });
  const workflow = (variables: Record<string, string>): WorkflowDefinition => ({
    nodes: [
      { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'l', name: 'Login', type: 'httpRequest', position: { x: 0, y: 0 }, parameters: { source: 'catalog', erpClient: 'c1', endpoint: 'login' } },
      { id: 'p', name: 'Preço', type: 'httpRequest', position: { x: 0, y: 0 }, parameters: { source: 'catalog', erpClient: 'c1', endpoint: 'preco', variables } },
    ],
    connections: [
      { from: 't', fromOutput: 0, to: 'l', toInput: 0 },
      { from: 'l', fromOutput: 0, to: 'p', toInput: 0 },
    ],
  });
  const run = (variables: Record<string, string>) =>
    executeWorkflow({
      workflow: workflow(variables),
      executionId: 'x',
      mode: 'manual',
      triggerItems: [{ json: { sku: 'A 1', preco: '12,5' } }],
      getApiEndpoint: async (_client, endpoint) => endpoints()[endpoint],
    });

  it('faz login com as credenciais do cliente e usa o token nas próximas chamadas', async () => {
    received.length = 0;
    const result = await run({ sku: "={{ $('Início').first().json.sku }}", preco: "={{ $('Início').first().json.preco }}", token: '={{ $json.token }}' });
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(received).toEqual([
      { method: 'POST', url: '/api/login', auth: null, body: { usuario: 'joao', senha: 's3nha' } },
      { method: 'PUT', url: '/api/produtos/A%201/preco', auth: 'Bearer tok-9', body: { preco: 12.5 } },
    ]);
  });

  it('avisa a variável obrigatória que faltou e traz o retorno da API no erro', async () => {
    const missing = await run({ sku: 'A', token: 'x' });
    expect(missing.error?.message).toBe('Consinco · Alteração de preço: Preencha a variável "preco"');
    const denied = await run({ sku: 'A', preco: '1', token: 'errado' });
    expect(denied.error).toMatchObject({
      nodeName: 'Preço',
      details: { statusCode: 401, body: { erro: 'token inválido' }, request: { api: { erp: 'Consinco', endpoint: 'Alteração de preço', client: 'Cliente X' } } },
    });
  });
});
