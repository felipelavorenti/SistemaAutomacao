import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import { ExpressionSandbox } from '../src/expressions/sandbox.js';
import { convertN8nWorkflow, readN8nExport, type N8nWorkflow } from '../src/n8n/import.js';
import { validateWorkflow } from '../src/validate.js';

// Fluxo no formato que o n8n 1.x exporta, com os nós que a equipe usa.
const exported: N8nWorkflow = {
  id: 'wf-precos',
  name: 'Reajuste de preços',
  active: true,
  settings: { timezone: 'America/Sao_Paulo' },
  nodes: [
    {
      id: 'a1',
      name: 'Todo dia 8h',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 8, triggerAtMinute: 30 }] } },
    },
    {
      id: 'a2',
      name: 'Login',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [200, 0],
      parameters: {
        method: 'POST',
        url: 'http://erp:8080/login',
        sendBody: true,
        bodyParameters: { parameters: [{ name: 'usuario', value: 'api' }, { name: 'loja', value: '={{ $json.loja }}' }, { name: 'obs', value: '=Loja {{ $json.loja }}' }] },
        options: { timeout: 30000, response: { response: { neverError: true } } },
      },
    },
    {
      id: 'a3',
      name: 'Produtos',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [400, 0],
      parameters: { operation: 'executeQuery', query: 'SELECT * FROM produtos WHERE loja = $1 AND ativo = $2', options: { queryReplacement: '={{ [$json.loja, true] }}' } },
      credentials: { postgres: { id: '7', name: 'Banco Cliente X' } },
    },
    { id: 'a4', name: 'Loop Over Items', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [600, 0], parameters: { batchSize: 10, options: {} } },
    {
      id: 'a5',
      name: 'Calcula',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [800, 100],
      parameters: { mode: 'runOnceForEachItem', jsCode: 'return { ...$json, novo: $json.preco * 1.1, hoje: $now.toISO() };' },
    },
    {
      id: 'a6',
      name: 'Tem preço?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [1000, 100],
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ id: 'c1', leftValue: '={{ $json.novo }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        },
      },
    },
    {
      id: 'a7',
      name: 'Subfluxo',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.1,
      position: [1200, 100],
      parameters: { workflowId: { __rl: true, value: 'n8n-sub-1', mode: 'list' }, mode: 'each', options: {} },
    },
    { id: 'a8', name: 'Erro', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [1200, 300], parameters: { errorMessage: '=Sem preço: {{ $json.sku }}' } },
    { id: 'a9', name: 'Roteia', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [1400, 100], parameters: { rules: {} } },
    { id: 'a10', name: 'Nota', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 300], parameters: { content: 'oi' } },
  ],
  connections: {
    'Todo dia 8h': { main: [[{ node: 'Login', type: 'main', index: 0 }]] },
    Login: { main: [[{ node: 'Produtos', type: 'main', index: 0 }]] },
    Produtos: { main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]] },
    'Loop Over Items': { main: [[{ node: 'Roteia', type: 'main', index: 0 }], [{ node: 'Calcula', type: 'main', index: 0 }]] },
    Calcula: { main: [[{ node: 'Tem preço?', type: 'main', index: 0 }]] },
    'Tem preço?': { main: [[{ node: 'Subfluxo', type: 'main', index: 0 }], [{ node: 'Erro', type: 'main', index: 0 }]] },
    Subfluxo: { main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]] },
    Roteia: { main: [[], [{ node: 'Erro', type: 'main', index: 0 }]] },
  },
};

describe('importador do n8n', () => {
  const result = convertN8nWorkflow(exported, { workflowId: (id) => (id === 'n8n-sub-1' ? 'aqui-sub-1' : undefined) });
  const byName = (name: string) => result.definition.nodes.find((n) => n.name === name)!;
  const warningsOf = (name: string) => result.warnings.filter((w) => w.node === name).map((w) => w.message);

  it('converte os nós equivalentes', () => {
    expect(result).toMatchObject({ n8nId: 'wf-precos', name: 'Reajuste de preços', wasActive: true });
    expect(byName('Todo dia 8h')).toMatchObject({ type: 'scheduleTrigger', parameters: { mode: 'cron', cron: '30 8 * * *', timezone: 'America/Sao_Paulo' } });
    expect(byName('Login')).toMatchObject({
      type: 'httpRequest',
      parameters: { method: 'POST', url: 'http://erp:8080/login', bodyType: 'json', failOnHttpError: false },
      settings: { timeoutMs: 30000 },
    });
    expect(byName('Produtos').parameters).toMatchObject({ operation: 'query', sql: 'SELECT * FROM produtos WHERE loja = :p1 AND ativo = :p2', connection: '' });
    expect((byName('Produtos').parameters.queryParams as unknown[]).length).toBe(2);
    expect(byName('Loop Over Items')).toMatchObject({ type: 'loop', parameters: { batchSize: 10 } });
    expect(byName('Calcula')).toMatchObject({ type: 'code', parameters: { language: 'javaScript', mode: 'each' } });
    expect(byName('Tem preço?')).toMatchObject({ type: 'if', parameters: { combinator: 'and', conditions: [{ left: '={{ $json.novo }}', operator: 'gt', right: 0 }] } });
    expect(byName('Subfluxo')).toMatchObject({ type: 'executeWorkflow', parameters: { workflowId: 'aqui-sub-1', mode: 'each' } });
    expect(byName('Erro')).toMatchObject({ type: 'stopAndError', parameters: { errorType: 'message', message: '=Sem preço: {{ $json.sku }}' } });
    expect(result.definition.nodes.some((n) => n.name === 'Nota')).toBe(false);
  });

  it('mantém as ligações, com as saídas do Loop no lugar certo', () => {
    const id = (name: string) => byName(name).id;
    const link = (from: string, output: number, to: string) => ({ from: id(from), fromOutput: output, to: id(to), toInput: 0 });
    expect(result.definition.connections).toEqual(
      expect.arrayContaining([link('Loop Over Items', 0, 'Roteia'), link('Loop Over Items', 1, 'Calcula'), link('Tem preço?', 1, 'Erro'), link('Subfluxo', 0, 'Loop Over Items')]),
    );
    // A saída 2 do Switch não tem onde ligar no nó não convertido.
    expect(result.definition.connections.some((c) => c.from === id('Roteia'))).toBe(false);
  });

  it('marca o que precisa de revisão', () => {
    expect(byName('Roteia')).toMatchObject({ type: 'n8nUnsupported', parameters: { n8nType: 'n8n-nodes-base.switch' } });
    expect(warningsOf('Roteia')).toEqual(['o nó "switch" do n8n não tem equivalente aqui; substitua-o', expect.stringMatching(/saída 2 para "Erro" foi removida/)]);
    expect(warningsOf('Produtos')).toEqual(expect.arrayContaining([expect.stringMatching(/escolha a conexão/), expect.stringMatching(/"Banco Cliente X"/)]));
    expect(warningsOf('Calcula')).toEqual([expect.stringMatching(/usa \$now, \.toISO\(\)/)]);
    expect(result.warnings).toContainEqual({ message: '1 nota(s) do canvas do n8n não foram importadas' });
    expect(validateWorkflow(result.definition).map((i) => i.message)).toContain('"Roteia" veio do n8n sem equivalente; substitua-o por outros nós');
  });

  it('avisa o subfluxo que ainda não foi importado', () => {
    const alone = convertN8nWorkflow(exported);
    expect(alone.definition.nodes.find((n) => n.name === 'Subfluxo')!.parameters.workflowId).toBe('');
    expect(alone.warnings).toContainEqual({ node: 'Subfluxo', message: 'o subfluxo n8n-sub-1 do n8n ainda não foi importado; importe-o e escolha o fluxo aqui' });
  });

  it('lê um fluxo, uma lista ou o formato da API', () => {
    expect(readN8nExport(exported)).toHaveLength(1);
    expect(readN8nExport([exported, exported])).toHaveLength(2);
    expect(readN8nExport({ data: [exported] })).toHaveLength(1);
    expect(() => readN8nExport({ nome: 'x' })).toThrow(/não parece um fluxo/);
  });

  it('o corpo, o Set, o If e os parâmetros do SQL convertidos funcionam de verdade', async () => {
    const flow: N8nWorkflow = {
      name: 'Teste',
      nodes: [
        { name: 'Início', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        {
          name: 'Campos',
          type: 'n8n-nodes-base.set',
          typeVersion: 3.4,
          parameters: {
            includeOtherFields: true,
            assignments: {
              assignments: [
                { id: '1', name: 'cliente.nome', value: '=Cliente {{ $json.id }}', type: 'string' },
                { id: '2', name: 'total', value: '={{ $json.qtd * 2 }}', type: 'number' },
                { id: '3', name: 'ativo', value: true, type: 'boolean' },
              ],
            },
            options: {},
          },
        },
        {
          name: 'Filtra',
          type: 'n8n-nodes-base.if',
          typeVersion: 1,
          parameters: { conditions: { number: [{ value1: '={{ $json.total }}', operation: 'larger', value2: 5 }] } },
        },
        {
          name: 'Corpo',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          parameters: { jsCode: 'return [{ corpo: 1 }];' },
        },
        {
          name: 'Velho',
          type: 'n8n-nodes-base.set',
          typeVersion: 2,
          parameters: { keepOnlySet: true, values: { string: [{ name: 'sku', value: '={{ $json.id }}' }], number: [{ name: 'fixo', value: 3 }] } },
        },
      ],
      connections: {
        Início: { main: [[{ node: 'Campos', index: 0 }]] },
        Campos: { main: [[{ node: 'Filtra', index: 0 }]] },
        Filtra: { main: [[{ node: 'Velho', index: 0 }], [{ node: 'Corpo', index: 0 }]] },
      },
    };
    const converted = convertN8nWorkflow(flow);
    const run = await executeWorkflow({ workflow: converted.definition, executionId: 'x', mode: 'manual', triggerItems: [{ json: { id: 1, qtd: 2 } }, { json: { id: 2, qtd: 4 } }] });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    const campos = run.runs.find((r) => r.nodeName === 'Campos')!.output[0]!.map((i) => i.json);
    expect(campos).toEqual([
      { id: 1, qtd: 2, cliente: { nome: 'Cliente 1' }, total: 4, ativo: true },
      { id: 2, qtd: 4, cliente: { nome: 'Cliente 2' }, total: 8, ativo: true },
    ]);
    expect(run.runs.find((r) => r.nodeName === 'Velho')!.output[0]!.map((i) => i.json)).toEqual([{ sku: '2', fixo: 3 }]);

    // HTTP com pares nome/valor: o corpo vira uma expressão que monta o JSON.
    const http = convertN8nWorkflow(exported).definition.nodes.find((n) => n.name === 'Login')!;
    const sandbox = new ExpressionSandbox();
    const scope = await sandbox.createScope({ nodeOutputs: {}, execution: { id: 'x', mode: 'manual' }, vars: {} });
    const input = [{ json: { loja: 3 } }];
    expect(await scope.resolve(http.parameters.jsonBody!, input, 0)).toEqual({ usuario: 'api', loja: 3, obs: 'Loja 3' });
    const sqlParams = convertN8nWorkflow(exported).definition.nodes.find((n) => n.name === 'Produtos')!.parameters.queryParams!;
    expect(await scope.resolve(sqlParams, input, 0)).toEqual([
      { name: 'p1', value: 3 },
      { name: 'p2', value: true },
    ]);
    scope.release();
    sandbox.dispose();
  });

  it('HTTP Request antigo com "JSON Parameters" leva headers, query, corpo e resposta completa', async () => {
    const seen: { url?: string; headers?: Record<string, unknown>; body?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'tok' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const wf: N8nWorkflow = {
        id: 'wf-legado',
        name: 'Login legado',
        nodes: [
          { id: 'a', name: 'Início', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          {
            id: 'b',
            name: 'Login',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 2,
            position: [200, 0],
            parameters: {
              requestMethod: 'POST',
              url: `${base}/oauth/token`,
              jsonParameters: true,
              options: { bodyContentType: 'form-urlencoded', fullResponse: true },
              headerParametersJson: '{"Authorization": "Basic YWJjOjEyMw=="}',
              queryParametersJson: '={"username": "{{ $json.ipa.username }}", "grant_type": "password", "tentativa": {{ $json.n }} }',
              bodyParametersJson: '={"password": "{{ $json.ipa.password }}"}',
            },
          },
        ],
        connections: { Início: { main: [[{ node: 'Login', type: 'main', index: 0 }]] } },
      };
      const converted = convertN8nWorkflow(wf);
      const run = await executeWorkflow({
        workflow: converted.definition,
        executionId: 'x',
        mode: 'manual',
        triggerItems: [{ json: { n: 2, ipa: { username: 'loja', password: 's3nha' } } }],
      });
      expect(run.status, JSON.stringify(run.error)).toBe('success');
      const url = new URL(seen[0]!.url!, base);
      expect(seen[0]!.headers!.authorization).toBe('Basic YWJjOjEyMw==');
      expect(Object.fromEntries(url.searchParams)).toEqual({ username: 'loja', grant_type: 'password', tentativa: '2' });
      expect(seen[0]!.headers!['content-type']).toBe('application/x-www-form-urlencoded');
      expect(seen[0]!.body).toBe('password=s3nha');
      expect(run.lastOutput[0]!.json).toMatchObject({ statusCode: 200, body: { access_token: 'tok' } });
    } finally {
      server.close();
    }
  });
});
