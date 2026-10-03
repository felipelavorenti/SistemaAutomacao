import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import { convertN8nWorkflow } from '../src/n8n/import.js';
import type { ConnectionData } from '../src/node-types.js';
import { buildMime, parseMessage, splitAddresses } from '../src/nodes/gmail.js';
import { exchangeGoogleCode, googleAuthUrl, GOOGLE_TOKEN_URL } from '../src/nodes/google.js';
import type { JsonObject, NodeInstance, WorkflowDefinition } from '../src/types.js';

interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
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
  // O Google e o Gmail viram o servidor local: /token e /gmail/...
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_URL) return realFetch(`${base}/token`, init);
    if (url.startsWith(GMAIL)) return realFetch(`${base}/gmail${url.slice(GMAIL.length)}`, init);
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  server.close();
});

let connectionCounter = 0;
let connection: ConnectionData;
beforeEach(() => {
  received.length = 0;
  // Uma conexão nova por teste, para o access token guardado em memória não vazar entre eles.
  connection = {
    id: `gm-${++connectionCounter}`,
    type: 'gmailOAuth2',
    data: { clientId: 'cliente.apps.googleusercontent.com', clientSecret: 'segredo', oauthRefreshToken: 'refresh-1', oauthAccount: 'financeiro@empresa.com' },
  };
});

const node = (parameters: JsonObject): NodeInstance => ({ id: 'g', name: 'Gmail', type: 'gmail', position: { x: 0, y: 0 }, parameters: { connection: 'gm', ...parameters } });
const flow = (n: NodeInstance): WorkflowDefinition => ({
  nodes: [{ id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} }, n],
  connections: [{ from: 't', fromOutput: 0, to: n.id, toInput: 0 }],
});
const run = (parameters: JsonObject, input: JsonObject[] = [{}]) =>
  executeWorkflow({
    workflow: flow(node(parameters)),
    executionId: 'x',
    mode: 'manual',
    triggerItems: input.map((json) => ({ json })),
    getConnection: async () => connection,
    getFile: async (id) => {
      if (id !== 'arq-1') throw new Error(`O arquivo ${id} não existe mais`);
      return { id, name: 'relatório.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4') };
    },
  });

/** Decodifica o "raw" enviado ao Gmail. */
const rawOf = (body: string, path: (b: JsonObject) => string = (b) => String(b.raw)) =>
  Buffer.from(path(JSON.parse(body) as JsonObject).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const tokenOk = { body: { access_token: 'acesso-1', expires_in: 3599, token_type: 'Bearer' } };

describe('Gmail', () => {
  it('renova o token, envia o e-mail com acento e anexo e devolve o id', async () => {
    handler = (r) => {
      if (r.url === '/token') return tokenOk;
      if (r.url === '/gmail/messages/send') return { body: { id: 'm1', threadId: 't1', labelIds: ['SENT'] } };
      return { status: 404, body: {} };
    };
    const result = await run({
      operation: 'send',
      to: '={{ $json.email }}',
      cc: 'Gerência <gerencia@empresa.com>',
      subject: 'Relatório de ação',
      bodyType: 'html',
      body: '=<p>Olá, {{ $json.nome }}</p>',
      senderName: 'Financeiro Empresa',
      attachments: [{ fileName: 'nota.txt', content: Buffer.from('conteúdo').toString('base64'), mimeType: 'text/plain' }],
    }, [{ email: 'ana@cliente.com', nome: 'Ana' }]);

    expect(result.status).toBe('success');
    expect(result.lastOutput).toEqual([{ json: { id: 'm1', threadId: 't1', labelIds: ['SENT'] } }]);
    const token = received.find((r) => r.url === '/token')!;
    expect(new URLSearchParams(token.body).get('refresh_token')).toBe('refresh-1');
    const send = received.find((r) => r.url === '/gmail/messages/send')!;
    expect(send.headers.authorization).toBe('Bearer acesso-1');
    const raw = rawOf(send.body);
    expect(raw).toContain('To: ana@cliente.com');
    expect(raw).toContain('Cc: Gerência <gerencia@empresa.com>'.replace('Gerência', `=?UTF-8?B?${Buffer.from('Gerência').toString('base64')}?=`));
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Relatório de ação').toString('base64')}?=`);
    expect(raw).toContain(`From: Financeiro Empresa <financeiro@empresa.com>`);
    expect(raw).toContain('Content-Type: multipart/mixed');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw).toContain(Buffer.from('<p>Olá, Ana</p>').toString('base64'));
    expect(raw).toContain('Content-Disposition: attachment; filename="nota.txt"');
    expect(raw).toContain(Buffer.from('conteúdo').toString('base64'));
  });

  it('usa o mesmo access token nas execuções seguidas', async () => {
    handler = (r) => (r.url === '/token' ? tokenOk : { body: { id: 'm', threadId: 't' } });
    await run({ operation: 'send', to: 'a@b.com', subject: 'x', body: 'y' });
    await run({ operation: 'send', to: 'a@b.com', subject: 'x', body: 'y' });
    expect(received.filter((r) => r.url === '/token')).toHaveLength(1);
  });

  it('anexa o arquivo escolhido na tela com o nome e o tipo dele', async () => {
    handler = (r) => (r.url === '/token' ? tokenOk : r.url === '/gmail/messages/send' ? { body: { id: 'm1' } } : { status: 404, body: {} });
    const result = await run({
      operation: 'send',
      to: 'a@b.com',
      subject: 'Relatório',
      body: 'Segue',
      attachments: [
        { file: 'arq-1', fileName: '', content: '', mimeType: '' },
        { file: 'arq-1', fileName: 'outro-nome.pdf', content: '', mimeType: '' },
      ],
    });
    expect(result.status).toBe('success');
    const mime = rawOf(received.find((r) => r.url === '/gmail/messages/send')!.body);
    expect(mime).toContain('Content-Type: application/pdf');
    expect(mime).toContain(Buffer.from('%PDF-1.4').toString('base64'));
    expect(mime).toContain(`filename="=?UTF-8?B?${Buffer.from('relatório.pdf').toString('base64')}?="`);
    expect(mime).toContain('outro-nome.pdf');

    const missing = await run({ operation: 'send', to: 'a@b.com', attachments: [{ file: 'sumiu' }] });
    expect(missing.status).toBe('error');
    expect(missing.error?.message).toContain('não existe mais');
  });

  it('responde na mesma conversa, com Re:, In-Reply-To e todos menos a própria conta', async () => {
    handler = (r) => {
      if (r.url === '/token') return tokenOk;
      if (r.url.startsWith('/gmail/messages/orig?format=metadata')) {
        return {
          body: {
            id: 'orig',
            threadId: 'conversa-9',
            payload: {
              headers: [
                { name: 'Subject', value: 'Pedido 1043' },
                { name: 'From', value: 'Bruno <bruno@cliente.com>' },
                { name: 'To', value: 'financeiro@empresa.com, Carla <carla@cliente.com>' },
                { name: 'Cc', value: 'dani@cliente.com' },
                { name: 'Message-ID', value: '<abc@mail.gmail.com>' },
              ],
            },
          },
        };
      }
      if (r.url === '/gmail/messages/send') return { body: { id: 'resp', threadId: 'conversa-9' } };
      return { status: 404, body: {} };
    };
    const result = await run({ operation: 'reply', messageId: 'orig', replyAll: true, body: 'Recebido.' });
    expect(result.status).toBe('success');
    const send = JSON.parse(received.find((r) => r.url === '/gmail/messages/send')!.body) as JsonObject;
    expect(send.threadId).toBe('conversa-9');
    const raw = rawOf(JSON.stringify(send));
    expect(raw).toContain('To: Bruno <bruno@cliente.com>, Carla <carla@cliente.com>');
    expect(raw).not.toContain('financeiro@empresa.com');
    expect(raw).toContain('Cc: dani@cliente.com');
    expect(raw).toContain('Subject: Re: Pedido 1043');
    expect(raw).toContain('In-Reply-To: <abc@mail.gmail.com>');
    expect(raw).toContain('References: <abc@mail.gmail.com>');
  });

  it('cria e envia rascunho', async () => {
    handler = (r) => {
      if (r.url === '/token') return tokenOk;
      if (r.url === '/gmail/drafts') return { body: { id: 'r-1', message: { id: 'm9', threadId: 't9' } } };
      if (r.url === '/gmail/drafts/send') return { body: { id: 'm9', threadId: 't9', labelIds: ['SENT'] } };
      return { status: 404, body: {} };
    };
    const draft = await run({ operation: 'createDraft', to: 'a@b.com', subject: 'Rascunho', body: 'Texto' });
    expect(draft.lastOutput[0]!.json.id).toBe('r-1');
    const created = received.find((r) => r.url === '/gmail/drafts')!;
    expect(rawOf(created.body, (b) => String((b.message as JsonObject).raw))).toContain('Subject: Rascunho');

    const sent = await run({ operation: 'sendDraft', draftId: '={{ $json.id }}' }, [{ id: 'r-1' }]);
    expect(sent.status).toBe('success');
    expect(JSON.parse(received.find((r) => r.url === '/gmail/drafts/send')!.body)).toEqual({ id: 'r-1' });
  });

  it('busca rascunhos já existentes e devolve o id que Enviar rascunho usa', async () => {
    handler = (r) => {
      if (r.url === '/token') return tokenOk;
      if (r.url.startsWith('/gmail/drafts?')) {
        const page = new URL(`http://x${r.url}`).searchParams.get('pageToken');
        return page
          ? { body: { drafts: [{ id: 'r-2', message: { id: 'm2', threadId: 't2' } }] } }
          : { body: { drafts: [{ id: 'r-1', message: { id: 'm1', threadId: 't1' } }], nextPageToken: 'p2' } };
      }
      const m = /^\/gmail\/messages\/(\w+)\?format=full$/.exec(r.url);
      if (m) {
        return {
          body: {
            id: m[1],
            threadId: `t${m[1]!.slice(1)}`,
            labelIds: ['DRAFT'],
            payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: 'cliente@x.com' }, { name: 'Subject', value: `Relatório ${m[1]}` }], body: { data: b64url('Segue') } },
          },
        };
      }
      return { status: 404, body: {} };
    };
    const result = await run({ operation: 'searchDrafts', query: 'subject:Relatório', limit: 5 });
    expect(result.status).toBe('success');
    const lists = received.filter((r) => r.url.startsWith('/gmail/drafts?')).map((r) => new URL(`http://x${r.url}`).searchParams);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.get('q')).toBe('subject:Relatório');
    expect(lists[0]!.get('maxResults')).toBe('5');
    expect(lists[1]!.get('maxResults')).toBe('4');
    expect(result.lastOutput.map((o) => o.json)).toMatchObject([
      { id: 'r-1', emailId: 'm1', threadId: 't1', to: 'cliente@x.com', subject: 'Relatório m1', text: 'Segue', labelIds: ['DRAFT'] },
      { id: 'r-2', emailId: 'm2', subject: 'Relatório m2' },
    ]);
  });

  it('busca, lê o texto e os anexos e devolve um item por e-mail', async () => {
    const full = (id: string) => ({
      id,
      threadId: `t-${id}`,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Segue a nota',
      internalDate: '1790000000000',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'nf@fornecedor.com' },
          { name: 'Subject', value: `Nota ${id}` },
        ],
        parts: [
          { mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/plain', body: { data: b64url('Segue a nota fiscal.') } },
            { mimeType: 'text/html', body: { data: b64url('<b>Segue</b>') } },
          ] },
          { mimeType: 'application/pdf', filename: 'nota.pdf', body: { attachmentId: `anexo-${id}`, size: 4 } },
        ],
      },
    });
    handler = (r) => {
      if (r.url === '/token') return tokenOk;
      if (r.url === '/gmail/labels') return { body: { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_7', name: 'Notas fiscais' }] } };
      if (r.url.startsWith('/gmail/messages?')) return { body: { messages: [{ id: 'a' }, { id: 'b' }], resultSizeEstimate: 2 } };
      const m = /^\/gmail\/messages\/(\w+)\?format=full$/.exec(r.url);
      if (m) return { body: full(m[1]!) };
      if (r.url.startsWith('/gmail/messages/a/attachments/')) return { body: { data: b64url('%PDF'), size: 4 } };
      if (r.url.startsWith('/gmail/messages/b/attachments/')) return { body: { data: b64url('%PDF'), size: 4 } };
      return { status: 404, body: {} };
    };
    const result = await run({ operation: 'search', query: 'is:unread', labelFilter: 'Notas fiscais', limit: 5, downloadAttachments: true });
    expect(result.status).toBe('success');
    const list = received.find((r) => r.url.startsWith('/gmail/messages?'))!;
    const params = new URL(`http://x${list.url}`).searchParams;
    expect(params.get('q')).toBe('is:unread');
    expect(params.getAll('labelIds')).toEqual(['Label_7']);
    expect(params.get('maxResults')).toBe('5');
    expect(result.lastOutput).toHaveLength(2);
    expect(result.lastOutput[0]!.json).toMatchObject({
      id: 'a',
      subject: 'Nota a',
      from: 'nf@fornecedor.com',
      text: 'Segue a nota fiscal.',
      html: '<b>Segue</b>',
      labelIds: ['INBOX', 'UNREAD'],
      attachments: [{ fileName: 'nota.pdf', mimeType: 'application/pdf', size: 4, attachmentId: 'anexo-a', content: Buffer.from('%PDF').toString('base64') }],
    });
  });

  it('marca como lido, troca etiquetas pelo nome e manda para a lixeira', async () => {
    handler = (r) => {
      if (r.url === '/token') return tokenOk;
      if (r.url === '/gmail/labels') return { body: { labels: [{ id: 'Label_7', name: 'Processado' }, { id: 'STARRED', name: 'STARRED' }] } };
      return { body: { id: 'm1', labelIds: [] } };
    };
    await run({ operation: 'markRead', messageId: 'm1' });
    await run({ operation: 'addLabels', messageId: 'm1', labels: 'processado, STARRED' });
    await run({ operation: 'trash', messageId: 'm1' });
    const modify = received.filter((r) => r.url === '/gmail/messages/m1/modify').map((r) => JSON.parse(r.body));
    expect(modify).toEqual([{ removeLabelIds: ['UNREAD'] }, { addLabelIds: ['Label_7', 'STARRED'] }]);
    expect(received.some((r) => r.url === '/gmail/messages/m1/trash' && r.method === 'POST')).toBe(true);

    const missing = await run({ operation: 'addLabels', messageId: 'm1', labels: 'Não existe' });
    expect(missing.error?.message).toBe('Nenhuma etiqueta do Gmail chamada "Não existe"');
  });

  it('explica quando o Google recusa o refresh token', async () => {
    handler = (r) => (r.url === '/token' ? { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } : { body: {} });
    const result = await run({ operation: 'send', to: 'a@b.com', subject: 'x', body: 'y' });
    expect(result.error?.message).toMatch(/Conectar com Google de novo/);
  });

  it('pede para conectar quando a conexão ainda não tem o refresh token', async () => {
    connection.data.oauthRefreshToken = '';
    const result = await run({ operation: 'send', to: 'a@b.com', subject: 'x', body: 'y' });
    expect(result.error?.message).toMatch(/clique em Conectar com Google/);
  });
});

describe('Login com Google', () => {
  it('monta o endereço de autorização pedindo acesso offline', () => {
    const url = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'http://localhost:3000/api/oauth/google/callback', state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'cid',
      redirect_uri: 'http://localhost:3000/api/oauth/google/callback',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
    });
  });

  it('troca o código pelo refresh token e descobre o e-mail da conta', async () => {
    received.length = 0;
    handler = (r) => {
      if (r.url === '/token') return { body: { access_token: 'a', refresh_token: 'r', expires_in: 3599 } };
      if (r.url === '/gmail/profile') return { body: { emailAddress: 'financeiro@empresa.com' } };
      return { status: 404, body: {} };
    };
    const result = await exchangeGoogleCode({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost/cb', code: 'codigo' });
    expect(result).toEqual({ refreshToken: 'r', account: 'financeiro@empresa.com' });
    expect(Object.fromEntries(new URLSearchParams(received[0]!.body))).toEqual({
      code: 'codigo',
      client_id: 'cid',
      client_secret: 'sec',
      redirect_uri: 'http://localhost/cb',
      grant_type: 'authorization_code',
    });
  });
});

describe('Montagem e leitura de e-mail', () => {
  it('separa endereços sem quebrar nomes com vírgula', () => {
    expect(splitAddresses('"Silva, Ana" <ana@x.com>, bruno@y.com; Carla <c@z.com>')).toEqual(['"Silva, Ana" <ana@x.com>', 'bruno@y.com', 'Carla <c@z.com>']);
  });

  it('monta texto simples sem multipart quando não há anexo', () => {
    const raw = Buffer.from(
      buildMime({ to: ['a@b.com'], cc: [], bcc: [], subject: 'Oi', body: 'Linha 1', html: false, attachments: [] }).replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    expect(raw).toBe(['To: a@b.com', 'Subject: Oi', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from('Linha 1').toString('base64')].join('\r\n'));
  });

  it('lê e-mail sem partes, só com o corpo', () => {
    const parsed = parseMessage({ id: 'x', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'S' }], body: { data: b64url('Só texto') } } });
    expect(parsed).toMatchObject({ id: 'x', subject: 'S', text: 'Só texto', html: '', attachments: [] });
  });
});

describe('Importação do Gmail do n8n', () => {
  const convert = (parameters: JsonObject, typeVersion = 2.1) =>
    convertN8nWorkflow({ nodes: [{ name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion, parameters }] });

  it('traz o envio com cópias e o nome do remetente', () => {
    const { definition, warnings } = convert({
      sendTo: '={{ $json.email }}',
      subject: 'Boleto',
      emailType: 'html',
      message: '<p>Segue</p>',
      options: { ccList: 'a@b.com', senderName: 'Financeiro', appendAttribution: false },
    });
    expect(definition.nodes[0]!.type).toBe('gmail');
    expect(definition.nodes[0]!.parameters).toMatchObject({ operation: 'send', to: '={{ $json.email }}', cc: 'a@b.com', subject: 'Boleto', bodyType: 'html', body: '<p>Segue</p>', senderName: 'Financeiro' });
    expect(warnings.map((w) => w.message)).toContain('escolha a conexão do Gmail');
  });

  it('traz busca, rascunho e exclusão (que vira lixeira)', () => {
    expect(convert({ operation: 'getAll', limit: 10, filters: { q: 'is:unread', labelIds: ['INBOX'] } }).definition.nodes[0]!.parameters).toMatchObject({
      operation: 'search',
      query: 'is:unread',
      labelFilter: 'INBOX',
      limit: 10,
    });
    expect(convert({ resource: 'draft', operation: 'create', subject: 'R', message: 'm', options: { sendTo: 'x@y.com' } }).definition.nodes[0]!.parameters).toMatchObject({
      operation: 'createDraft',
      to: 'x@y.com',
    });
    expect(convert({ resource: 'draft', operation: 'getAll', limit: 10 }).definition.nodes[0]!.parameters).toMatchObject({ operation: 'searchDrafts', limit: 10 });
    const deleted = convert({ operation: 'delete', messageId: '={{ $json.id }}' });
    expect(deleted.definition.nodes[0]!.parameters).toMatchObject({ operation: 'trash', messageId: '={{ $json.id }}' });
    expect(deleted.warnings.map((w) => w.message)).toContain('no n8n o e-mail era apagado de vez; aqui ele vai para a lixeira');
  });

  it('deixa como não convertido o Gmail antigo (versão 1) e as operações sem equivalente', () => {
    expect(convert({ resource: 'message', operation: 'send' }, 1).definition.nodes[0]!.type).toBe('n8nUnsupported');
    expect(convert({ resource: 'label', operation: 'create' }).definition.nodes[0]!.type).toBe('n8nUnsupported');
  });
});
