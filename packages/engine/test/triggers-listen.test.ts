import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { converters } from '../src/n8n/convert-triggers-listen.js';
import type { Ctx, N8nNode } from '../src/n8n/import.js';
import type { NodeExecuteContext, TriggerContext } from '../src/node-types.js';
import {
  SseParser,
  emailReadImap,
  imapCriteriaToSearch,
  imapMessageToItem,
  listenTriggerNodes,
  localFileTrigger,
  pollTimesToCrons,
  rssFeedReadTrigger,
  sseMessageToItem,
  sseTrigger,
} from '../src/nodes/triggers-listen.js';
import type { Item, JsonObject, JsonValue } from '../src/types.js';

function triggerCtx(params: JsonObject, extra: Partial<TriggerContext> = {}) {
  const emitted: Item[][] = [];
  const errors: Error[] = [];
  const controller = new AbortController();
  const ctx: TriggerContext = {
    node: { id: 'n', name: 'Gatilho', type: 'x', position: { x: 0, y: 0 }, parameters: params },
    workflowId: 'w',
    getParam: async (name) => params[name] ?? null,
    getConnection: async () => {
      throw new Error('sem conexão');
    },
    filesDirs: [],
    staticData: {},
    saveStaticData: async () => {},
    emit: async (items) => {
      emitted.push(items);
    },
    emitError: (err) => {
      errors.push(err);
    },
    signal: controller.signal,
    testing: false,
    ...extra,
  };
  return { ctx, emitted, errors, controller };
}

function execCtx(params: JsonObject, inputs: Item[][] = [[]]): NodeExecuteContext {
  return { inputs, getParam: async (name: string) => params[name] ?? null } as unknown as NodeExecuteContext;
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// ---------------------------------------------------------------------
describe('pollTimesToCrons', () => {
  it('converte cada modo do n8n em cron de 6 campos', () => {
    expect(
      pollTimesToCrons([
        { mode: 'everyMinute' },
        { mode: 'everyHour', minute: 15 },
        { mode: 'everyDay', hour: 8, minute: 30 },
        { mode: 'everyWeek', hour: 9, minute: 0, weekday: '5' },
        { mode: 'everyMonth', hour: 7, minute: 5, dayOfMonth: 10 },
        { mode: 'everyX', value: 5, unit: 'minutes' },
        { mode: 'everyX', value: 3, unit: 'hours' },
        { mode: 'custom', cronExpression: '*/10 * * * 1-5' },
        { mode: 'custom', cronExpression: '30 0 12 * * *' },
      ]),
    ).toEqual(['0 * * * * *', '0 15 * * * *', '0 30 8 * * *', '0 0 9 * * 5', '0 5 7 10 * *', '0 */5 * * * *', '0 0 */3 * * *', '0 */10 * * * 1-5', '30 0 12 * * *']);
  });

  it('aceita o formato do n8n, usa os padrões, ignora linhas inválidas e repetidas', () => {
    expect(pollTimesToCrons({ item: [{ mode: 'everyDay' }, { mode: 'everyDay' }, { mode: 'nada' }, 'x'] } as JsonValue)).toEqual(['0 0 14 * * *']);
    expect(pollTimesToCrons([])).toEqual([]);
    expect(pollTimesToCrons(null)).toEqual([]);
    expect(pollTimesToCrons([{ mode: 'everyDay', hour: 99, minute: -3 }])).toEqual(['0 0 23 * * *']);
    expect(pollTimesToCrons(rssFeedReadTrigger.description.properties[0]!.default)).toEqual(['0 * * * * *']);
  });
});

// ---------------------------------------------------------------------
describe('RSS Feed Trigger', () => {
  let feedItems: { title: string; date: string }[] = [];
  let server: Server;
  let url = '';
  const rss = () =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>http://x</link><description>d</description>${feedItems
      .map((i) => `<item><title>${i.title}</title><link>http://x/${i.title}</link><guid>${i.title}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate></item>`)
      .join('')}</channel></rss>`;

  beforeAll(async () => {
    ({ server, url } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(rss());
    }));
  });
  afterAll(() => server.close());

  it('primeira consulta só guarda a data; depois devolve só os itens novos', async () => {
    feedItems = [
      { title: 'b', date: '2024-01-02T10:00:00Z' },
      { title: 'a', date: '2024-01-01T10:00:00Z' },
    ];
    const { ctx } = triggerCtx({ feedUrl: `${url}/feed` });
    expect(await rssFeedReadTrigger.poll!(ctx)).toBeNull();
    expect(ctx.staticData.lastItemDate).toBe('2024-01-02T10:00:00.000Z');
    expect(await rssFeedReadTrigger.poll!(ctx)).toBeNull();

    feedItems = [{ title: 'c', date: '2024-01-03T10:00:00Z' }, ...feedItems];
    const fresh = await rssFeedReadTrigger.poll!(ctx);
    expect(fresh).toHaveLength(1);
    expect(fresh![0]!.json).toMatchObject({ title: 'c', link: 'http://x/c', guid: 'c', isoDate: '2024-01-03T10:00:00.000Z' });
    expect(ctx.staticData.lastItemDate).toBe('2024-01-03T10:00:00.000Z');
  });

  it('teste e execução manual trazem o item mais recente', async () => {
    feedItems = [{ title: 'z', date: '2024-02-01T00:00:00Z' }];
    const { ctx } = triggerCtx({ feedUrl: `${url}/feed` }, { testing: true });
    const items = await rssFeedReadTrigger.poll!(ctx);
    expect(items![0]!.json.title).toBe('z');
    expect(ctx.staticData).toEqual({});
    const [out] = await rssFeedReadTrigger.execute(execCtx({ feedUrl: `${url}/feed` }));
    expect(out![0]!.json.title).toBe('z');
    // Com itens vindos do gatilho, só repassa.
    const [passed] = await rssFeedReadTrigger.execute(execCtx({}, [[{ json: { a: 1 } }]]));
    expect(passed).toEqual([{ json: { a: 1 } }]);
  });

  it('erro claro com URL inválida ou fora do ar', async () => {
    const { ctx } = triggerCtx({ feedUrl: 'ftp://x' });
    await expect(rssFeedReadTrigger.poll!(ctx)).rejects.toThrow(/http/);
    const { ctx: ctx2 } = triggerCtx({ feedUrl: 'http://127.0.0.1:1/feed' });
    await expect(rssFeedReadTrigger.poll!(ctx2)).rejects.toThrow(/Não foi possível/);
  });
});

// ---------------------------------------------------------------------
describe('SSE Trigger', () => {
  it('parser: várias linhas de data, id, retry, comentários e pedaços cortados', () => {
    const got: { event: string; data: string; id: string }[] = [];
    const p = new SseParser((m) => got.push(m));
    p.push(': comentário\r\nretry: 1500\r\nid: 7\r\ndata: lin');
    p.push('ha1\r');
    p.push('\ndata:linha2\r\n\r\nevent: ping\ndata: x\n\ndata\n\n');
    expect(got).toEqual([
      { event: 'message', data: 'linha1\nlinha2', id: '7' },
      { event: 'ping', data: 'x', id: '7' },
      { event: 'message', data: '', id: '7' },
    ]);
    expect(p.retry).toBe(1500);
    expect(sseMessageToItem('{"a":1}')).toEqual({ json: { a: 1 } });
    expect(sseMessageToItem('[1,2]')).toEqual({ json: { data: [1, 2] } });
    expect(sseMessageToItem('olá')).toEqual({ json: { data: 'olá' } });
  });

  it('recebe mensagens e reconecta com Last-Event-ID', async () => {
    const lastIds: (string | undefined)[] = [];
    const { server, url } = await startServer((req, res) => {
      lastIds.push(req.headers['last-event-id'] as string | undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (lastIds.length === 1) {
        res.write('retry: 50\n\n');
        res.write('id: 1\ndata: {"pedido": 10}\n\n');
        res.write('event: outro\ndata: {"ignorado": true}\n\n');
        res.end('id: 2\ndata: texto\n\n');
      } else {
        res.write('id: 3\ndata: {"pedido": 11}\n\n');
      }
    });
    const { ctx, emitted, errors } = triggerCtx({ url: `${url}/eventos` });
    const close = await sseTrigger.listen!(ctx);
    try {
      await waitFor(() => emitted.length >= 3);
      expect(emitted.map((e) => e[0]!.json)).toEqual([{ pedido: 10 }, { data: 'texto' }, { pedido: 11 }]);
      expect(lastIds.slice(0, 2)).toEqual([undefined, '2']);
      expect(errors).toEqual([]);
    } finally {
      await close();
      server.closeAllConnections();
      server.close();
    }
  });

  it('no teste, erro de conexão volta como erro; execução manual sem itens explica', async () => {
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const { ctx } = triggerCtx({ url }, { testing: true });
      await expect(sseTrigger.listen!(ctx)).rejects.toThrow(/404/);
      const { ctx: ctx2, errors, controller } = triggerCtx({ url });
      const close = await sseTrigger.listen!(ctx2);
      await waitFor(() => errors.length >= 1);
      controller.abort();
      await close();
    } finally {
      server.close();
    }
    await expect(sseTrigger.execute(execCtx({}))).rejects.toThrow(/Escutar teste/);
  });
});

// ---------------------------------------------------------------------
describe('Local File Trigger', () => {
  let base = '';
  let files = '';
  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'lft-'));
    files = path.join(base, 'files');
    await mkdir(path.join(files, 'entrada'), { recursive: true });
  });
  afterAll(() => rm(base, { recursive: true, force: true }));

  it('pasta: dispara add, change e unlink com { event, path }; respeita o Ignorar', async () => {
    const { ctx, emitted } = triggerCtx({ triggerOn: 'folder', path: 'entrada', events: ['add', 'change', 'unlink'], ignored: '**/*.tmp' }, { filesDirs: [files] });
    const close = await localFileTrigger.listen!(ctx);
    const file = path.join(files, 'entrada', 'nota.txt');
    try {
      await writeFile(path.join(files, 'entrada', 'lixo.tmp'), 'x');
      await writeFile(file, 'um');
      await waitFor(() => emitted.some((e) => e[0]!.json.event === 'add'));
      await new Promise((r) => setTimeout(r, 200));
      await writeFile(file, 'dois');
      await waitFor(() => emitted.some((e) => e[0]!.json.event === 'change'));
      await unlink(file);
      await waitFor(() => emitted.some((e) => e[0]!.json.event === 'unlink'));
      const real = emitted.map((e) => e[0]!.json);
      expect(real.find((j) => j.event === 'add')).toEqual({ event: 'add', path: expect.stringMatching(/entrada[\\/]nota\.txt$/) });
      expect(real.some((j) => String(j.path).endsWith('.tmp'))).toBe(false);
    } finally {
      await close();
    }
  }, 20_000);

  it('arquivo: dispara change', async () => {
    const file = path.join(files, 'config.json');
    await writeFile(file, '{}');
    const { ctx, emitted } = triggerCtx({ triggerOn: 'file', path: file }, { filesDirs: [files] });
    const close = await localFileTrigger.listen!(ctx);
    try {
      await writeFile(file, '{"a":1}');
      await waitFor(() => emitted.length > 0);
      expect(emitted[0]![0]!.json).toEqual({ event: 'change', path: file });
    } finally {
      await close();
    }
  }, 20_000);

  it('recusa caminho fora das pastas liberadas e pasta sem eventos', async () => {
    const { ctx } = triggerCtx({ triggerOn: 'folder', path: base, events: ['add'] }, { filesDirs: [files] });
    await expect(localFileTrigger.listen!(ctx)).rejects.toThrow(/fora das pastas liberadas/);
    const { ctx: ctx2 } = triggerCtx({ triggerOn: 'folder', path: 'entrada', events: [] }, { filesDirs: [files] });
    await expect(localFileTrigger.listen!(ctx2)).rejects.toThrow(/pelo menos um evento/);
    const { ctx: ctx3 } = triggerCtx({ triggerOn: 'file', path: 'x' }, { filesDirs: [] });
    await expect(localFileTrigger.listen!(ctx3)).rejects.toThrow(/FILES_DIRS/);
  });
});

// ---------------------------------------------------------------------
describe('Email Trigger (IMAP)', () => {
  const raw = Buffer.from(
    [
      'From: =?UTF-8?Q?Jo=C3=A3o_Silva?= <joao@exemplo.com>',
      'To: vendas@empresa.com',
      'Cc: chefe@empresa.com',
      'Subject: =?UTF-8?Q?Pedido_n=C2=BA_10?=',
      'Date: Tue, 01 Oct 2024 10:00:00 -0300',
      'Message-ID: <abc@exemplo.com>',
      'X-Prioridade: alta',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="XYZ"',
      '',
      '--XYZ',
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Olá, segue o pedido.',
      '--ALT',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Olá, segue o pedido.</p>',
      '--ALT--',
      '--XYZ',
      'Content-Type: text/csv; name="pedido.csv"',
      'Content-Disposition: attachment; filename="pedido.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('id;qtd\n1;2\n').toString('base64'),
      '--XYZ--',
      '',
    ].join('\r\n'),
  );

  it('formato simples: cabeçalhos principais, texto, metadata e anexos', async () => {
    const item = await imapMessageToItem(raw, 42, { format: 'simple', downloadAttachments: true, attachmentPrefix: 'attachment_' });
    expect(item.json).toMatchObject({
      from: 'João Silva <joao@exemplo.com>',
      to: 'vendas@empresa.com',
      cc: 'chefe@empresa.com',
      subject: 'Pedido nº 10',
      date: 'Tue, 01 Oct 2024 10:00:00 -0300',
      textPlain: 'Olá, segue o pedido.',
      textHtml: '<p>Olá, segue o pedido.</p>',
      attributes: { uid: 42 },
    });
    expect(item.json.metadata).toMatchObject({ 'message-id': '<abc@exemplo.com>', 'x-prioridade': 'alta', 'mime-version': '1.0' });
    expect(Object.keys(item.binary!)).toEqual(['attachment_0']);
    expect(item.binary!.attachment_0).toMatchObject({ fileName: 'pedido.csv', mimeType: 'text/csv' });
    expect(Buffer.from(item.binary!.attachment_0!.data, 'base64').toString()).toBe('id;qtd\n1;2\n');
    const noAttachments = await imapMessageToItem(raw, 42, { format: 'simple', downloadAttachments: false, attachmentPrefix: 'attachment_' });
    expect(noAttachments.binary).toBeUndefined();
  });

  it('formato completo (resolved) e bruto (raw)', async () => {
    const item = await imapMessageToItem(raw, 7, { format: 'resolved', downloadAttachments: false, attachmentPrefix: 'anexo_' });
    expect(item.json).toMatchObject({ subject: 'Pedido nº 10', text: 'Olá, segue o pedido.', messageId: '<abc@exemplo.com>', attributes: { uid: 7 } });
    expect((item.json.from as JsonObject).value).toEqual([{ address: 'joao@exemplo.com', name: 'João Silva' }]);
    expect((item.json.headers as JsonObject)['x-prioridade']).toBe('X-Prioridade: alta');
    expect(item.json.attachments).toBeUndefined();
    expect(item.json.headerLines).toBeUndefined();
    expect(item.json.date).toBe('2024-10-01T13:00:00.000Z');
    expect(Object.keys(item.binary!)).toEqual(['anexo_0']);
    const rawItem = await imapMessageToItem(raw, 7, { format: 'raw', downloadAttachments: false, attachmentPrefix: '' });
    expect(Buffer.from(String(rawItem.json.raw), 'base64').equals(raw)).toBe(true);
  });

  it('critérios de busca do n8n viram a busca do imapflow', () => {
    expect(imapCriteriaToSearch('["UNSEEN"]')).toEqual({ seen: false });
    expect(imapCriteriaToSearch('["ALL"]')).toEqual({ all: true });
    expect(imapCriteriaToSearch('[]')).toEqual({ all: true });
    const since = imapCriteriaToSearch('["UNSEEN", ["SINCE", "May 20, 2024"], ["FROM", "a@b.com"], "!FLAGGED"]');
    expect(since).toMatchObject({ seen: false, from: 'a@b.com', not: { flagged: true } });
    expect(since.since).toBeInstanceOf(Date);
    expect(imapCriteriaToSearch('[["OR", "SEEN", ["SUBJECT", "nota"]], ["HEADER", "X-Tipo", "nfe"]]')).toEqual({ or: [{ seen: true }, { subject: 'nota' }], header: { 'X-Tipo': 'nfe' } });
    expect(imapCriteriaToSearch('[["FROM", "a"], ["FROM", "b"]]')).toEqual({ not: { or: [{ not: { from: 'a' } }, { not: { from: 'b' } }] } });
    expect(() => imapCriteriaToSearch('["XPTO"]')).toThrow(/Critério de busca inválido/);
    expect(() => imapCriteriaToSearch('não é json')).toThrow(/JSON/);
  });

  it('execução manual sem itens explica que precisa escutar', async () => {
    await expect(emailReadImap.execute(execCtx({}))).rejects.toThrow(/fluxo ativo.*Escutar teste/);
    expect(listenTriggerNodes.map((n) => n.description.type)).toEqual(['rssFeedReadTrigger', 'emailReadImap', 'localFileTrigger', 'sseTrigger']);
  });
});

// ---------------------------------------------------------------------
describe('importador do n8n', () => {
  const convert = (type: string, parameters: Record<string, unknown>, typeVersion = 1) => {
    const warnings: string[] = [];
    const node = { id: '1', name: 'N', type: `n8n-nodes-base.${type}`, typeVersion, position: [0, 0], parameters } as unknown as N8nNode;
    const ctx: Ctx = { node, params: parameters, warn: (m) => warnings.push(m), options: {}, timezone: 'America/Sao_Paulo' };
    return { result: converters[type]!(ctx), warnings };
  };

  it('RSS com pollTimes', () => {
    const { result } = convert('rssFeedReadTrigger', { feedUrl: 'https://x/feed', pollTimes: { item: [{ mode: 'everyHour', minute: 5 }, { mode: 'everyWeek', hour: 8, weekday: 3 }] } });
    expect(result!.type).toBe('rssFeedReadTrigger');
    expect(result!.parameters.feedUrl).toBe('https://x/feed');
    expect(pollTimesToCrons(result!.parameters.pollTimes!)).toEqual(['0 5 * * * *', '0 0 8 * * 3']);
    expect(pollTimesToCrons(convert('rssFeedReadTrigger', {}).result!.parameters.pollTimes!)).toEqual(['0 * * * * *']);
  });

  it('IMAP com opções', () => {
    const { result, warnings } = convert(
      'emailReadImap',
      { format: 'resolved', dataPropertyAttachmentsPrefixName: 'anexo_', options: { customEmailConfig: '["ALL"]', forceReconnect: 30, trackLastMessageId: false, allowUnauthorizedCerts: true } },
      2,
    );
    expect(result).toEqual({
      type: 'emailReadImap',
      parameters: {
        connection: '',
        mailbox: 'INBOX',
        postProcessAction: 'read',
        format: 'resolved',
        downloadAttachments: false,
        dataPropertyAttachmentsPrefixName: 'anexo_',
        customEmailConfig: '["ALL"]',
        trackLastMessageId: false,
        forceReconnect: 30,
      },
    });
    expect(warnings.join(' ')).toMatch(/conexão do tipo IMAP/);
    expect(warnings.join(' ')).toMatch(/certificado inválido/);
  });

  it('Local File Trigger e SSE', () => {
    const { result, warnings } = convert('localFileTrigger', { triggerOn: 'folder', path: '/data/in', events: ['add', 'unlink'], options: { usePolling: true, depth: 0, ignored: '**/*.tmp', ignoreInitial: false } });
    expect(result!.parameters).toMatchObject({ triggerOn: 'folder', path: '/data/in', events: ['add', 'unlink'], usePolling: true, depth: '0', ignored: '**/*.tmp', ignoreInitial: false, followSymlinks: true });
    expect(warnings[0]).toMatch(/FILES_DIRS/);
    expect(convert('sseTrigger', { url: 'https://x/sse' }).result).toEqual({ type: 'sseTrigger', parameters: { url: 'https://x/sse' } });
  });
});
