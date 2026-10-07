import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import { toBinary } from '../src/binary.js';
import { fileNameFromDisposition, isBinaryContentType } from '../src/nodes/http-request.js';
import type { Item, NodeInstance, WorkflowDefinition } from '../src/types.js';
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
      } else if (url.pathname === '/vazio') {
        res.statusCode = 204;
        res.end();
      } else if (url.pathname === '/lista-vazia') {
        res.end('[]');
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

  it.each(['/vazio', '/lista-vazia'])('termina o fluxo sem erro quando a API não devolve nada (%s)', async (path) => {
    const wf = chain(trigger, http('v', 'Busca', { url: `${base}${path}` }), http('e', 'Eco', { url: `${base}/eco` }));
    const result = await run(wf);
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(result.runs.map((r) => r.nodeName)).not.toContain('Eco');
    expect(result.runs.find((r) => r.nodeName === 'Busca')?.output).toEqual([[]]);
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

describe('HTTP Request com arquivos', () => {
  let fileServer: Server;
  let fileBase = '';
  const pdf = Buffer.from('%PDF-1.4\n\x00\xff binário', 'latin1');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe]);

  beforeAll(async () => {
    fileServer = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (url.pathname === '/docs/nota.pdf') {
          res.setHeader('content-type', 'application/pdf');
          res.end(pdf);
        } else if (url.pathname === '/imagem') {
          res.setHeader('content-type', 'image/png');
          res.end(png);
        } else if (url.pathname === '/relatorio') {
          res.setHeader('content-type', 'text/csv; charset=utf-8');
          res.setHeader('content-disposition', "attachment; filename=\"relatorio.csv\"; filename*=UTF-8''relat%C3%B3rio%20m%C3%AAs.csv");
          res.end('a,b\n1,2\n');
        } else if (url.pathname === '/texto') {
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('olá');
        } else if (url.pathname === '/upload') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ contentType: req.headers['content-type'] ?? null, base64: body.toString('base64') }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((r) => fileServer.listen(0, '127.0.0.1', r));
    fileBase = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    fileServer.closeAllConnections();
    fileServer.close();
  });

  const one = async (parameters: NodeInstance['parameters'], triggerItems?: Item[]) => {
    const r = await run(chain(trigger, http('h', 'HTTP', parameters)), triggerItems ? { triggerItems } : {});
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    return r.lastOutput;
  };

  it('no automático, PDF e imagem viram arquivo; nome do fim da URL e tipo do Content-Type', async () => {
    const [item] = await one({ url: `${fileBase}/docs/nota.pdf` });
    expect(item!.json).toEqual({});
    expect(item!.binary?.data).toMatchObject({ fileName: 'nota.pdf', mimeType: 'application/pdf', fileExtension: 'pdf', bytes: pdf.length });
    expect(Buffer.from(item!.binary!.data!.data, 'base64').equals(pdf)).toBe(true);

    const [img] = await one({ url: `${fileBase}/imagem`, outputPropertyName: 'foto' });
    expect(img!.binary?.foto).toMatchObject({ fileName: 'imagem', mimeType: 'image/png', fileExtension: 'png', fileType: 'image' });
    expect(Buffer.from(img!.binary!.foto!.data, 'base64').equals(png)).toBe(true);
  });

  it('texto continua texto no automático; formato Arquivo usa o nome do Content-Disposition', async () => {
    expect((await one({ url: `${fileBase}/texto` })).map((i) => i.json)).toEqual([{ data: 'olá' }]);
    expect((await one({ url: `${fileBase}/texto`, responseFormat: 'text', outputPropertyName: 'conteudo' })).map((i) => i.json)).toEqual([{ conteudo: 'olá' }]);
    expect((await one({ url: `${fileBase}/relatorio` }))[0]!.binary).toBeUndefined();

    const [file] = await one({ url: `${fileBase}/relatorio`, responseFormat: 'file', outputPropertyName: 'planilha' });
    expect(file!.binary?.planilha).toMatchObject({ fileName: 'relatório mês.csv', mimeType: 'text/csv', fileExtension: 'csv' });
    expect(Buffer.from(file!.binary!.planilha!.data, 'base64').toString('utf8')).toBe('a,b\n1,2\n');

    const [full] = await one({ url: `${fileBase}/docs/nota.pdf`, fullResponse: true });
    expect(full!.json).toMatchObject({ statusCode: 200, headers: { 'content-type': 'application/pdf' } });
    expect(full!.binary?.data?.fileName).toBe('nota.pdf');
  });

  it('formato JSON recusa resposta que não é JSON', async () => {
    const r = await run(chain(trigger, http('h', 'HTTP', { url: `${fileBase}/texto`, responseFormat: 'json' })));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/não é um JSON válido/);
  });

  it('envia um arquivo do item como corpo e em formulário multipart', async () => {
    const file = toBinary(pdf, { fileName: 'nota.pdf' });
    const items: Item[] = [{ json: { id: 7 }, binary: { data: file, outro: toBinary(Buffer.from('x;y'), { fileName: 'dados.csv' }) } }];

    const [raw] = await one({ method: 'POST', url: `${fileBase}/upload`, bodyType: 'binary' }, items);
    expect(raw!.json.contentType).toBe('application/pdf');
    expect(Buffer.from(String(raw!.json.base64), 'base64').equals(pdf)).toBe(true);

    const [own] = await one({ method: 'PUT', url: `${fileBase}/upload`, bodyType: 'binary', inputDataFieldName: 'outro', headers: [{ name: 'Content-Type', value: 'application/octet-stream' }] }, items);
    expect(own!.json.contentType).toBe('application/octet-stream');

    const [multi] = await one(
      {
        method: 'POST',
        url: `${fileBase}/upload`,
        bodyType: 'multipart',
        headers: [{ name: 'Content-Type', value: 'multipart/form-data' }],
        multipartBody: [
          { parameterType: 'formData', name: 'id', value: '={{ $json.id }}' },
          { parameterType: 'formBinaryData', name: 'arquivo', value: 'data' },
          { parameterType: 'formBinaryData', name: 'planilha', value: 'outro' },
        ],
      },
      items,
    );
    const contentType = String(multi!.json.contentType);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(Buffer.from(String(multi!.json.base64), 'base64'), { headers: { 'content-type': contentType } }).formData();
    expect(form.get('id')).toBe('7');
    const sent = form.get('arquivo') as File;
    expect(sent.name).toBe('nota.pdf');
    expect(sent.type).toBe('application/pdf');
    expect(Buffer.from(await sent.arrayBuffer()).equals(pdf)).toBe(true);
    expect((form.get('planilha') as File).name).toBe('dados.csv');

    const missing = await run(chain(trigger, http('h', 'HTTP', { method: 'POST', url: `${fileBase}/upload`, bodyType: 'binary' })));
    expect(missing.status).toBe('error');
    expect(missing.error?.message).toMatch(/não tem arquivo/);
  });
});

describe('fileNameFromDisposition', () => {
  it('lê filename*, filename com e sem aspas', () => {
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''a%20b.pdf")).toBe('a b.pdf');
    expect(fileNameFromDisposition('attachment; filename="c:\\pasta\\nota.pdf"')).toBe('nota.pdf');
    expect(fileNameFromDisposition('inline; filename=x.txt')).toBe('x.txt');
    expect(fileNameFromDisposition('inline')).toBeUndefined();
    expect(isBinaryContentType('application/vnd.api+json')).toBe(false);
    expect(isBinaryContentType('application/zip')).toBe(true);
    expect(isBinaryContentType('')).toBe(false);
  });
});
