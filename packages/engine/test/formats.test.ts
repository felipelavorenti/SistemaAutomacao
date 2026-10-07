import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { Ctx, N8nNode } from '../src/n8n/import.js';
import { converters, momentToLuxon } from '../src/n8n/convert-formats.js';
import type { ConnectionData } from '../src/node-types.js';
import { cryptoNode, dateTime, formatPem, html, htmlToText, markdown, parseDate, totp, xml } from '../src/nodes/formats.js';
import { manualTrigger } from '../src/nodes/triggers.js';
import { NodeRegistry } from '../src/registry.js';
import type { JsonObject, WorkflowDefinition } from '../src/types.js';

const registry = new NodeRegistry([manualTrigger, dateTime, cryptoNode, html, markdown, xml, totp]);

async function run(type: string, parameters: JsonObject, items: JsonObject[] = [{}], connections: Record<string, ConnectionData> = {}) {
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
    triggerItems: items.map((json) => ({ json })),
    getConnection: async (id) => {
      const c = connections[id];
      if (!c) throw new Error(`conexão ${id} não existe`);
      return c;
    },
  });
}

async function output(type: string, parameters: JsonObject, items: JsonObject[] = [{}], connections: Record<string, ConnectionData> = {}) {
  const r = await run(type, parameters, items, connections);
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return r.lastOutput.map((i) => i.json);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
describe('Date & Time', () => {
  const SP = { timezone: 'America/Sao_Paulo' };

  it('pega a data atual no fuso do nó, com e sem hora', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 9, 15, 30, 0));
    expect(await output('dateTime', { operation: 'getCurrentDate', ...SP })).toEqual([{ currentDate: '2026-04-09T12:30:00.000-03:00' }]);
    expect(await output('dateTime', { operation: 'getCurrentDate', includeTime: false, outputFieldName: 'hoje', timezone: 'UTC' })).toEqual([
      { hoje: '2026-04-09T00:00:00.000Z' },
    ]);
  });

  it('recusa fuso inválido', async () => {
    const r = await run('dateTime', { operation: 'getCurrentDate', timezone: 'Lua/Base' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/fuso horário Lua\/Base não é válido/);
  });

  it('soma e subtrai tempo; data sem fuso é lida no fuso do nó', async () => {
    expect(
      await output('dateTime', { operation: 'addToDate', magnitude: '={{ $json.d }}', timeUnit: 'months', duration: 1, ...SP }, [{ d: '2026-01-31T10:00:00-03:00' }]),
    ).toEqual([{ newDate: '2026-02-28T10:00:00.000-03:00' }]);
    expect(await output('dateTime', { operation: 'subtractFromDate', magnitude: '2026-03-10 08:00', timeUnit: 'hours', duration: 2, ...SP })).toEqual([
      { newDate: '2026-03-10T06:00:00.000-03:00' },
    ]);
    // Data em UTC é convertida para o fuso do nó.
    expect(await output('dateTime', { operation: 'addToDate', magnitude: '2026-03-10T12:00:00Z', timeUnit: 'days', duration: 0, ...SP })).toEqual([
      { newDate: '2026-03-10T09:00:00.000-03:00' },
    ]);
  });

  it('inclui os campos de entrada quando pedido', async () => {
    const out = await output('dateTime', { operation: 'addToDate', magnitude: '={{ $json.d }}', timeUnit: 'days', duration: 2, includeInputFields: true, outputFieldName: 'prazo', ...SP }, [
      { id: 1, d: '2026-01-01' },
    ]);
    expect(out).toEqual([{ id: 1, d: '2026-01-01', prazo: '2026-01-03T00:00:00.000-03:00' }]);
  });

  it('formata com formatos prontos, personalizados e timestamps, como o n8n', async () => {
    const fmt = (date: unknown, extra: JsonObject) => output('dateTime', { operation: 'formatDate', date: date as string, ...SP, ...extra });
    expect(await fmt('2026-04-09T15:30:00Z', {})).toEqual([{ formattedDate: '04/09/2026' }]);
    expect(await fmt('2026-04-09T15:30:00Z', { format: 'dd/MM/yyyy' })).toEqual([{ formattedDate: '09/04/2026' }]);
    // Sem "usar o fuso do nó", o n8n formata em UTC (ou no "+hh" da própria data).
    expect(await fmt('2026-04-09T15:30:00Z', { format: 'custom', customFormat: 'dd/MM/yyyy HH:mm' })).toEqual([{ formattedDate: '09/04/2026 15:30' }]);
    expect(await fmt('2026-04-09T15:30:00Z', { format: 'custom', customFormat: 'dd/MM/yyyy HH:mm', useWorkflowTimezone: true })).toEqual([{ formattedDate: '09/04/2026 12:30' }]);
    expect(await fmt('2026-04-09T10:00:00+05:00', { format: 'custom', customFormat: 'HH:mm' })).toEqual([{ formattedDate: '10:00' }]);
    expect(await fmt('2026-01-01T00:00:00Z', { format: 'X' })).toEqual([{ formattedDate: '1767225600' }]);
    expect(await fmt('2026-01-01T00:00:00Z', { format: 'x' })).toEqual([{ formattedDate: '1767225600000' }]);
    // Timestamps em segundos (menos de 12 dígitos) e em milissegundos.
    expect(await fmt('1767225600', { format: 'yyyy-MM-dd' })).toEqual([{ formattedDate: '2026-01-01' }]);
    expect(await fmt('1767225600000', { format: 'yyyy-MM-dd' })).toEqual([{ formattedDate: '2026-01-01' }]);
    expect(await fmt('20260409', { format: 'yyyy-MM-dd', fromFormat: 'yyyyMMdd' })).toEqual([{ formattedDate: '2026-04-09' }]);
    expect(await fmt('Thu, 09 Apr 2026 15:30:00 GMT', { format: 'yyyy-MM-dd HH:mm' })).toEqual([{ formattedDate: '2026-04-09 15:30' }]);
  });

  it('formatar data nula devolve nulo e data inválida dá erro', async () => {
    expect(await output('dateTime', { operation: 'formatDate', date: '={{ $json.x }}', ...SP }, [{ x: null }])).toEqual([{ formattedDate: null }]);
    const r = await run('dateTime', { operation: 'formatDate', date: 'não é data', ...SP });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Formato de data inválido/);
  });

  it('arredonda para baixo e para cima (início do mês seguinte, como o n8n)', async () => {
    const d = '2026-04-09T15:30:00-03:00';
    expect(await output('dateTime', { operation: 'roundDate', date: d, ...SP })).toEqual([{ roundedDate: '2026-04-01T00:00:00.000-03:00' }]);
    expect(await output('dateTime', { operation: 'roundDate', date: d, toNearest: 'hour', ...SP })).toEqual([{ roundedDate: '2026-04-09T15:00:00.000-03:00' }]);
    expect(await output('dateTime', { operation: 'roundDate', date: d, mode: 'roundUp', to: 'month', ...SP })).toEqual([{ roundedDate: '2026-05-01T00:00:00.000-03:00' }]);
  });

  it('calcula o tempo entre datas em objeto ou ISO', async () => {
    const base = { operation: 'getTimeBetweenDates', startDate: '2026-01-01T00:00:00-03:00', endDate: '2026-01-02T06:30:00-03:00', ...SP };
    expect(await output('dateTime', { ...base, units: ['day', 'hour'] })).toEqual([{ timeDifference: { days: 1, hours: 6.5 } }]);
    expect(await output('dateTime', { ...base, units: ['day', 'hour', 'minute'], isoString: true })).toEqual([{ timeDifference: 'P1DT6H30M' }]);
    expect(await output('dateTime', base)).toEqual([{ timeDifference: { days: 1.2708333333333333 } }]);
  });

  it('extrai partes da data', async () => {
    const d = '2026-04-09T15:30:00-03:00';
    expect(await output('dateTime', { operation: 'extractDate', date: d, ...SP })).toEqual([{ datePart: 4 }]);
    expect(await output('dateTime', { operation: 'extractDate', date: d, part: 'week', ...SP })).toEqual([{ datePart: 15 }]);
    expect(await output('dateTime', { operation: 'extractDate', date: d, part: 'hour', ...SP })).toEqual([{ datePart: 15 }]);
    expect(await output('dateTime', { operation: 'extractDate', date: d, part: 'year', timezone: 'Asia/Tokyo' })).toEqual([{ datePart: 2026 }]);
  });

  it('parseDate segue as regras do n8n para números', () => {
    expect(parseDate(1767225600.5).toMillis()).toBe(1767225600500);
    expect(parseDate('1767225600', { timezone: 'UTC' }).toISO()).toBe('2026-01-01T00:00:00.000Z');
    expect(() => parseDate('')).toThrow(/Informe a data/);
  });
});

// ---------------------------------------------------------------------
describe('Crypto', () => {
  it('gera hash em hex e base64', async () => {
    expect(await output('crypto', { action: 'hash', type: 'MD5', value: 'abc' }, [{ id: 1 }])).toEqual([{ id: 1, data: '900150983cd24fb0d6963f7d28e17f72' }]);
    expect(await output('crypto', { action: 'hash', value: '={{ $json.t }}', dataPropertyName: 'h' }, [{ t: 'abc' }])).toEqual([
      { t: 'abc', h: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    ]);
    expect(await output('crypto', { action: 'hash', type: 'SHA1', value: 'abc', encoding: 'base64' })).toEqual([{ data: 'qZk+NkcGgWq6PiVxeFDCbJzQ2J0=' }]);
    const [sha3] = await output('crypto', { action: 'hash', type: 'SHA3-256', value: '' });
    expect(sha3!.data).toBe('a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  });

  it('gera HMAC com o segredo e grava em caminho com pontos', async () => {
    const out = await output('crypto', {
      action: 'hmac',
      type: 'SHA256',
      value: 'The quick brown fox jumps over the lazy dog',
      secret: 'key',
      dataPropertyName: 'assinatura.hmac',
    });
    expect(out).toEqual([{ assinatura: { hmac: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8' } }]);
    const r = await run('crypto', { action: 'hmac', value: 'x' });
    expect(r.error?.message).toMatch(/segredo/);
  });

  it('assina com a chave privada da conexão (inclusive colada numa linha só)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const oneLine = pem.replace(/\n/g, ' ');
    const conn = { k: { id: 'k', type: 'cryptoPrivateKey', data: { privateKey: oneLine } } };
    const [out] = await output('crypto', { action: 'sign', value: 'pedido 42', connection: 'k', algorithm: 'RSA-SHA256', encoding: 'base64' }, [{}], conn);
    const verify = createVerify('RSA-SHA256');
    verify.update('pedido 42');
    expect(verify.verify(publicKey, String(out!.data), 'base64')).toBe(true);

    const semChave = await run('crypto', { action: 'sign', value: 'x', connection: 'k' }, [{}], { k: { id: 'k', type: 'cryptoPrivateKey', data: {} } });
    expect(semChave.error?.message).toMatch(/não tem chave privada/);
  });

  it('formatPem refaz as quebras de linha', () => {
    expect(formatPem('-----BEGIN PRIVATE KEY----- AAAA BBBB -----END PRIVATE KEY-----')).toBe('-----BEGIN PRIVATE KEY-----\nAAAABBBB\n-----END PRIVATE KEY-----\n');
  });

  it('gera UUID e textos aleatórios do tamanho pedido', async () => {
    const [u] = await output('crypto', { action: 'generate' });
    expect(u!.data).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [h] = await output('crypto', { action: 'generate', encodingType: 'hex', stringLength: 10 });
    expect(h!.data).toMatch(/^[0-9a-f]{10}$/);
    const [b] = await output('crypto', { action: 'generate', encodingType: 'base64', stringLength: 20 });
    expect(b!.data).toMatch(/^\w{1,20}$/);
    const [a] = await output('crypto', { action: 'generate', encodingType: 'ascii', stringLength: 8 });
    expect(String(a!.data)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------
describe('HTML', () => {
  const page = `
    <div id="main">
      <h1 class="titulo">Promoção</h1>
      <ul>
        <li><a href="/a" class="link">Produto A</a></li>
        <li><a href="/b" class="link">Produto B</a></li>
      </ul>
      <input name="q" value="busca">
      <select name="s" multiple><option value="1" selected>1</option><option value="2" selected>2</option></select>
      <p class="desc">  Linha   1
        <img src="x.png" alt="foto"> </p>
      <p class="desc">Linha 2</p>
    </div>`;

  it('gera HTML com expressões por item', async () => {
    const out = await output('html', { operation: 'generateHtmlTemplate', html: '=<p>Olá {{ $json.nome }}</p>' }, [{ nome: 'Ana' }, { nome: 'Bia' }]);
    expect(out).toEqual([{ html: '<p>Olá Ana</p>' }, { html: '<p>Olá Bia</p>' }]);
  });

  it('extrai texto, HTML, atributos, valores e listas', async () => {
    const out = await output(
      'html',
      {
        operation: 'extractHtmlContent',
        dataPropertyName: 'pagina.corpo',
        extractionValues: [
          { key: 'titulo', cssSelector: '.titulo', returnValue: 'text' },
          { key: 'links', cssSelector: 'a.link', returnValue: 'attribute', attribute: 'href', returnArray: true },
          { key: 'nomes', cssSelector: 'a.link', returnValue: 'text', returnArray: true },
          { key: 'busca', cssSelector: 'input[name=q]', returnValue: 'value' },
          { key: 'selecao', cssSelector: 'select', returnValue: 'value' },
          { key: 'primeiroItem', cssSelector: 'li', returnValue: 'html' },
          { key: 'descricao', cssSelector: '.desc', returnValue: 'text', returnArray: true },
          { key: 'semImagem', cssSelector: '.desc', returnValue: 'text', skipSelectors: 'img' },
          { key: 'nada', cssSelector: '.naoexiste', returnValue: 'attribute', attribute: 'href' },
        ],
      },
      [{ pagina: { corpo: page } }],
    );
    expect(out).toEqual([
      {
        titulo: 'Promoção',
        links: ['/a', '/b'],
        // Como no n8n, o texto vem do HTML interno de cada elemento (o link em si não entra).
        nomes: ['Produto A', 'Produto B'],
        busca: 'busca',
        selecao: '1,2',
        primeiroItem: '<a href="/a" class="link">Produto A</a>',
        descricao: ['Linha 1 foto [x.png]', 'Linha 2'],
        semImagem: 'Linha 1',
      },
    ]);
  });

  it('sem limpar o texto mantém as quebras entre blocos', async () => {
    const out = await output(
      'html',
      { operation: 'extractHtmlContent', extractionValues: [{ key: 't', cssSelector: '#main', returnValue: 'text' }], cleanUpText: false },
      [{ data: page }],
    );
    expect(out[0]!.t).toBe('PROMOÇÃO\n\n * Produto A [/a]\n * Produto B [/b]\n\n12\n\nLinha 1 foto [x.png]\n\nLinha 2');
  });

  it('uma lista de HTMLs vira um item para cada; campo ausente dá erro', async () => {
    const out = await output('html', { operation: 'extractHtmlContent', extractionValues: [{ key: 'b', cssSelector: 'b' }] }, [{ data: ['<b>1</b>', '<b>2</b>'] }]);
    expect(out).toEqual([{ b: '1' }, { b: '2' }]);
    const r = await run('html', { operation: 'extractHtmlContent', extractionValues: [{ key: 'b', cssSelector: 'b' }] }, [{ outro: 1 }]);
    expect(r.error?.message).toMatch(/não tem o campo "data"/);
  });

  it('htmlToText formata listas numeradas, quebras e links', () => {
    expect(htmlToText('<ol><li>um</li><li>dois<br>linha</li></ol><a href="mailto:a@b.c">fale</a> <a href="#topo">topo</a>')).toBe('1. um\n2. dois\nlinha\n\nfale [a@b.c] topo');
  });

  it('converte os itens numa tabela HTML como o n8n', async () => {
    const out = await output('html', { operation: 'convertToHtmlTable', customStyling: true, capitalize: true, caption: 'Pedidos', tableAttributes: 'border="1"' }, [
      { codigo_pedido: 1, pago: true },
      { codigo_pedido: 2, pago: false, obs: 'x' },
    ]);
    expect(out).toEqual([
      {
        table:
          '<table  border="1"><caption>Pedidos</caption><thead  ><tr><th>Codigo Pedido</th><th>Pago</th><th>Obs</th></tr></thead><tbody>' +
          '<tr  ><td  >1</td><td  ><input type="checkbox" checked="checked"/></td><td  >undefined</td></tr>' +
          '<tr  ><td  >2</td><td  ><input type="checkbox" /></td><td  >x</td></tr></tbody></table>',
      },
    ]);
    const [styled] = await output('html', { operation: 'convertToHtmlTable', rowAttributes: '=data-id="{{ $json.id }}"' }, [{ id: 7 }]);
    expect(styled!.table).toContain("<table style='border-spacing:0; font-family:helvetica,arial,sans-serif' >");
    expect(styled!.table).toContain('<tr  data-id="7">');
  });
});

// ---------------------------------------------------------------------
describe('Markdown', () => {
  it('converte HTML em Markdown com as opções', async () => {
    const out = await output('markdown', { mode: 'htmlToMarkdown', html: '={{ $json.h }}', destinationKey: 'email.md' }, [
      { h: '<h1>Oi</h1><p><strong>forte</strong> e <em>leve</em></p><ul><li>a</li></ul>' },
    ]);
    expect(out).toEqual([{ h: '<h1>Oi</h1><p><strong>forte</strong> e <em>leve</em></p><ul><li>a</li></ul>', email: { md: '# Oi\n\n**forte** e _leve_\n\n* a' } }]);
    const [custom] = await output('markdown', {
      mode: 'htmlToMarkdown',
      html: '<p><b>x</b> <i>y</i></p><ul><li>a</li></ul><pre><code>c</code></pre><script>z</script>',
      bulletMarker: '-',
      strongDelimiter: '__',
      emDelimiter: '*',
      codeBlockStyle: 'indented',
      ignore: 'script',
      textReplace: [{ pattern: 'a', replacement: 'b' }],
    });
    expect(custom!.data).toBe('__x__ *y*\n\n- b\n\n    c');
  });

  it('converte Markdown em HTML com as opções do showdown', async () => {
    expect(await output('markdown', { mode: 'markdownToHtml', markdown: '# Oi\n\n**x**' })).toEqual([{ data: '<h1 id="oi">Oi</h1>\n<p><strong>x</strong></p>' }]);
    const [opts] = await output('markdown', {
      mode: 'markdownToHtml',
      markdown: '# Oi\n~~velho~~ https://a.com\n\n| a |\n|---|\n| 1 |',
      noHeaderId: true,
      strikethrough: true,
      simplifiedAutoLink: true,
      openLinksInNewWindow: true,
      tables: true,
      headerLevelStart: 2,
    });
    expect(opts!.data).toContain('<h2>Oi</h2>');
    expect(opts!.data).toContain('<del>velho</del>');
    expect(opts!.data).toContain('<a href="https://a.com" rel="noopener noreferrer" target="_blank">https://a.com</a>');
    expect(opts!.data).toContain('<table>');
  });
});

// ---------------------------------------------------------------------
describe('XML', () => {
  const doc = '<?xml version="1.0"?><pedido id="7"><item>a</item><item>b</item><cliente><nome> Ana </nome></cliente></pedido>';

  it('converte XML em JSON com os padrões do n8n', async () => {
    expect(await output('xml', { mode: 'xmlToJson' }, [{ data: doc }])).toEqual([{ pedido: { id: '7', item: ['a', 'b'], cliente: { nome: ' Ana ' } } }]);
  });

  it('respeita as opções do xml2js', async () => {
    const [out] = await output('xml', { mode: 'xmlToJson', dataPropertyName: 'x', mergeAttrs: false, explicitRoot: false, trim: true, attrkey: 'attrs' }, [{ x: doc }]);
    expect(out).toEqual({ attrs: { id: '7' }, item: ['a', 'b'], cliente: { nome: 'Ana' } });
    const [arr] = await output('xml', { mode: 'xmlToJson', explicitArray: true, ignoreAttrs: true, normalizeTags: true }, [{ data: '<A><B>1</B></A>' }]);
    expect(arr).toEqual({ a: { b: ['1'] } });
  });

  it('converte JSON em XML', async () => {
    const [out] = await output('xml', { mode: 'jsonToxml', headless: true, rootName: 'cliente' }, [{ nome: 'Ana', $: { id: 1 } }]);
    expect(out).toEqual({ data: '<cliente id="1">\n  <nome>Ana</nome>\n</cliente>' });
    const [full] = await output('xml', { mode: 'jsonToxml', cdata: true, dataPropertyName: 'xml' }, [{ t: 'a < b' }]);
    expect(full!.xml).toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<t><![CDATA[a < b]]></t>');
    // Com uma chave só e o nome de raiz padrão, o xml2js usa a chave como raiz (igual no n8n).
    const [two] = await output('xml', { mode: 'jsonToxml', headless: true }, [{ a: 1, b: 2 }]);
    expect(two!.data).toBe('<root>\n  <a>1</a>\n  <b>2</b>\n</root>');
  });

  it('dá erro com campo ausente, XML inválido ou chave proibida', async () => {
    expect((await run('xml', { mode: 'xmlToJson' }, [{ outro: 1 }])).error?.message).toMatch(/não tem o campo "data"/);
    expect((await run('xml', { mode: 'xmlToJson' }, [{ data: '<a><b></a>' }])).error?.message).toMatch(/XML inválido/);
    expect((await run('xml', { mode: 'xmlToJson', attrkey: '__proto__' }, [{ data: '<a/>' }])).error?.message).toMatch(/não é permitida/);
  });
});

// ---------------------------------------------------------------------
describe('TOTP', () => {
  // Segredo do RFC 6238 ("12345678901234567890" em base32).
  const conn = { t: { id: 't', type: 'totp', data: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', label: 'Info8n:ana' } } };

  it('gera o código e os segundos restantes para cada item', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(59_000);
    expect(await output('totp', { connection: 't', digits: 8 }, [{}], conn)).toEqual([{ token: '94287082', secondsRemaining: expect.any(Number) }]);
    vi.spyOn(Date, 'now').mockReturnValue(45_000);
    expect(await output('totp', { connection: 't' }, [{ a: 1 }, { a: 2 }], conn)).toEqual([
      { token: '287082', secondsRemaining: 15 },
      { token: '287082', secondsRemaining: 15 },
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(59_000);
    const [sha256] = await output('totp', { connection: 't', digits: 8, algorithm: 'SHA256' }, [{}], {
      t: { id: 't', type: 'totp', data: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA', label: '' } },
    });
    expect(sha256!.token).toBe('46119246');
  });

  it('recusa rótulo sem "emissor:usuário"', async () => {
    const r = await run('totp', { connection: 't' }, [{}], { t: { id: 't', type: 'totp', data: { secret: 'GEZDGNBV', label: 'ana' } } });
    expect(r.error?.message).toMatch(/emissor:usuário/);
  });
});

// ---------------------------------------------------------------------
describe('conversores do n8n (formatos)', () => {
  const ctxOf = (type: string, parameters: Record<string, unknown>, typeVersion = 1) => {
    const warnings: string[] = [];
    const node: N8nNode = { name: 'N', type: `n8n-nodes-base.${type}`, typeVersion, parameters };
    const ctx: Ctx = { node, params: parameters, warn: (m) => warnings.push(m), options: {}, timezone: 'America/Sao_Paulo' };
    return { ctx, warnings };
  };
  const convert = (type: string, parameters: Record<string, unknown>, typeVersion = 1) => {
    const { ctx, warnings } = ctxOf(type, parameters, typeVersion);
    return { result: converters[type]!(ctx), warnings };
  };

  it('Date & Time V2: todas as operações', () => {
    expect(convert('dateTime', { includeTime: false, options: { timezone: 'UTC', includeInputFields: true } }, 2).result).toEqual({
      type: 'dateTime',
      parameters: { operation: 'getCurrentDate', outputFieldName: 'currentDate', includeInputFields: true, timezone: 'UTC', includeTime: false },
    });
    expect(convert('dateTime', { operation: 'addToDate', magnitude: '={{ $json.d }}', timeUnit: 'hours', duration: 3, outputFieldName: 'x' }, 2).result!.parameters).toEqual({
      operation: 'addToDate',
      outputFieldName: 'x',
      includeInputFields: false,
      timezone: 'America/Sao_Paulo',
      magnitude: '={{ $json.d }}',
      timeUnit: 'hours',
      duration: 3,
    });
    expect(convert('dateTime', { operation: 'subtractFromDate', magnitude: 'd' }, 2).result!.parameters).toMatchObject({ operation: 'subtractFromDate', outputFieldName: 'newDate', timeUnit: 'days', duration: 0 });
    expect(
      convert('dateTime', { operation: 'formatDate', date: 'd', format: 'custom', customFormat: 'dd/MM', options: { fromFormat: 'yyyyMMdd', timezone: true } }, 2).result!.parameters,
    ).toMatchObject({ operation: 'formatDate', outputFieldName: 'formattedDate', format: 'custom', customFormat: 'dd/MM', fromFormat: 'yyyyMMdd', useWorkflowTimezone: true });
    expect(convert('dateTime', { operation: 'formatDate', date: 'd' }, 2).result!.parameters).toMatchObject({ format: 'MM/dd/yyyy', useWorkflowTimezone: false });
    expect(convert('dateTime', { operation: 'roundDate', date: 'd', mode: 'roundUp' }, 2).result!.parameters).toMatchObject({ mode: 'roundUp', to: 'month', outputFieldName: 'roundedDate' });
    expect(convert('dateTime', { operation: 'getTimeBetweenDates', startDate: 'a', endDate: 'b', units: ['hour'], options: { isoString: true } }, 2).result!.parameters).toMatchObject({
      units: ['hour'],
      isoString: true,
      outputFieldName: 'timeDifference',
    });
    expect(convert('dateTime', { operation: 'extractDate', date: 'd', part: 'week' }, 2).result!.parameters).toMatchObject({ part: 'week', outputFieldName: 'datePart' });
  });

  it('Date & Time V1: formatar e calcular', () => {
    const fmt = convert('dateTime', { value: '={{ $json.d }}', dataPropertyName: 'quando', toFormat: 'YYYY-MM-DD' });
    expect(fmt.result).toEqual({
      type: 'dateTime',
      parameters: { outputFieldName: 'quando', includeInputFields: true, timezone: 'America/Sao_Paulo', operation: 'formatDate', date: '={{ $json.d }}', format: 'yyyy-MM-dd', useWorkflowTimezone: true },
    });
    const custom = convert('dateTime', { value: 'x', custom: true, toFormat: 'DD/MM/YYYY [às] HH:mm', options: { toTimezone: 'UTC' } });
    expect(custom.result!.parameters).toMatchObject({ format: 'custom', customFormat: "dd/MM/yyyy 'às' HH:mm", timezone: 'UTC', useWorkflowTimezone: true });
    expect(custom.warnings.join(' ')).toMatch(/moment/);
    const calc = convert('dateTime', { action: 'calculate', value: 'x', operation: 'subtract', duration: 2, timeUnit: 'weeks' });
    expect(calc.result!.parameters).toMatchObject({ operation: 'subtractFromDate', magnitude: 'x', duration: 2, timeUnit: 'weeks', outputFieldName: 'data', includeInputFields: true });
    expect(calc.warnings.join(' ')).toMatch(/UTC/);
    expect(momentToLuxon('dddd, D [de] MMMM YYYY h:mm A')).toBe("cccc, d 'de' MMMM yyyy h:mm a");
  });

  it('Crypto: hash, hmac, sign, generate e o que não dá', () => {
    expect(convert('crypto', { type: 'SHA512', value: 'v', dataPropertyName: 'h', encoding: 'base64' }, 2).result).toEqual({
      type: 'crypto',
      parameters: { action: 'hash', dataPropertyName: 'h', type: 'SHA512', value: 'v', encoding: 'base64' },
    });
    expect(convert('crypto', { value: 'v' }, 1).result!.parameters).toMatchObject({ type: 'MD5' });
    const hmac = convert('crypto', { action: 'hmac', value: 'v', secret: 's' }, 1);
    expect(hmac.result!.parameters).toMatchObject({ action: 'hmac', secret: 's', type: 'MD5' });
    expect(hmac.warnings).toEqual([]);
    expect(convert('crypto', { action: 'hmac', value: 'v' }, 2).warnings.join(' ')).toMatch(/Segredo/);
    const sign = convert('crypto', { action: 'sign', value: 'v', algorithm: 'RSA-SHA512', privateKey: 'segredo' }, 1);
    expect(sign.result!.parameters).toEqual({ action: 'sign', dataPropertyName: 'data', value: 'v', algorithm: 'RSA-SHA512', encoding: 'hex', connection: '' });
    expect(sign.warnings.join(' ')).toMatch(/Chave privada/);
    expect(convert('crypto', { action: 'generate', encodingType: 'hex', stringLength: 8 }, 2).result!.parameters).toEqual({ action: 'generate', dataPropertyName: 'data', encodingType: 'hex', stringLength: 8 });
    const bin = convert('crypto', { action: 'hash', binaryData: true }, 2);
    expect(bin.result).toBeNull();
    expect(bin.warnings.join(' ')).toMatch(/binário/);
    expect(convert('crypto', { action: 'encrypt' }, 2).result).toBeNull();
  });

  it('HTML: modelo, extração, tabela e o antigo HTML Extract', () => {
    expect(convert('html', { html: '<p>{{ $json.a }}</p>' }, 1.2).result).toEqual({ type: 'html', parameters: { operation: 'generateHtmlTemplate', html: '=<p>{{ $json.a }}</p>' } });
    expect(convert('html', { html: '<p>fixo</p>' }, 1.2).result!.parameters.html).toBe('<p>fixo</p>');
    const ex = convert(
      'html',
      { operation: 'extractHtmlContent', dataPropertyName: 'body', extractionValues: { values: [{ key: 'k', cssSelector: 'a', returnValue: 'attribute', attribute: 'href', returnArray: true }] }, options: { cleanUpText: false } },
      1.2,
    );
    expect(ex.result).toEqual({
      type: 'html',
      parameters: {
        operation: 'extractHtmlContent',
        sourceData: 'json',
        dataPropertyName: 'body',
        extractionValues: [{ key: 'k', cssSelector: 'a', returnValue: 'attribute', attribute: 'href', skipSelectors: '', returnArray: true }],
        trimValues: true,
        cleanUpText: false,
      },
    });
    expect(ex.warnings).toEqual([]);
    expect(convert('html', { operation: 'extractHtmlContent', sourceData: 'binary' }, 1.2).result).toBeNull();
    expect(convert('html', { operation: 'convertToHtmlTable', options: { capitalize: true, caption: 'C' } }, 1.2).result!.parameters).toEqual({
      operation: 'convertToHtmlTable',
      capitalize: true,
      customStyling: false,
      caption: 'C',
      tableAttributes: '',
      headerAttributes: '',
      rowAttributes: '',
      cellAttributes: '',
    });
    const old = convert('htmlExtract', { extractionValues: { values: [{ key: 't', cssSelector: 'h1' }] } });
    expect(old.result!.parameters).toMatchObject({ operation: 'extractHtmlContent', dataPropertyName: 'data', extractionValues: [{ key: 't', cssSelector: 'h1', returnValue: 'text' }] });
    expect(old.warnings.join(' ')).toMatch(/versão nova/);
  });

  it('Markdown: os dois modos e opções sem equivalente', () => {
    const toMd = convert('markdown', { html: '={{ $json.h }}', options: { bulletMarker: '-', codeBlockStyle: 'fence', textReplace: { values: [{ pattern: 'a', replacement: 'b' }] }, globalEscape: { value: {} } } });
    expect(toMd.result).toEqual({
      type: 'markdown',
      parameters: { mode: 'htmlToMarkdown', destinationKey: 'data', html: '={{ $json.h }}', bulletMarker: '-', codeBlockStyle: 'fence', textReplace: [{ pattern: 'a', replacement: 'b' }] },
    });
    expect(toMd.warnings).toHaveLength(2);
    const toHtml = convert('markdown', { mode: 'markdownToHtml', markdown: 'm', destinationKey: 'k', options: { tables: true, ghMentions: true } });
    expect(toHtml.result!.parameters).toEqual({ mode: 'markdownToHtml', destinationKey: 'k', markdown: 'm', tables: true });
    expect(toHtml.warnings.join(' ')).toMatch(/ghMentions/);
  });

  it('XML e TOTP', () => {
    expect(convert('xml', { mode: 'jsonToxml', dataPropertyName: 'x', options: { headless: true, explicitArray: true } }).result).toEqual({
      type: 'xml',
      parameters: { mode: 'jsonToxml', dataPropertyName: 'x', headless: true },
    });
    expect(convert('xml', { options: { explicitArray: true, mergeAttrs: false } }).result!.parameters).toEqual({ mode: 'xmlToJson', dataPropertyName: 'data', explicitArray: true, mergeAttrs: false });
    const t = convert('totp', { options: { digits: 8 } });
    expect(t.result).toEqual({ type: 'totp', parameters: { operation: 'generateSecret', connection: '', algorithm: 'SHA1', digits: 8, period: 30 } });
    expect(t.warnings.join(' ')).toMatch(/TOTP/);
  });
});
