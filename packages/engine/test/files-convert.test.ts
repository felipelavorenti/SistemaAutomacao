import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { toBinary } from '../src/binary.js';
import { executeWorkflow } from '../src/executor.js';
import { converters } from '../src/n8n/convert-files-convert.js';
import type { Ctx, N8nNode } from '../src/n8n/import.js';
import { fileConvertNodes, flattenObject, parseIcsCalendar } from '../src/nodes/files-convert.js';
import { manualTrigger } from '../src/nodes/triggers.js';
import { NodeRegistry } from '../src/registry.js';
import type { Item, JsonObject, WorkflowDefinition } from '../src/types.js';

const registry = new NodeRegistry([manualTrigger, ...fileConvertNodes]);

async function run(type: string, parameters: JsonObject, items: Item[] = [{ json: {} }]) {
  const workflow: WorkflowDefinition = {
    nodes: [
      { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'n', name: 'Nó', type, position: { x: 0, y: 0 }, parameters },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'n', toInput: 0 }],
  };
  return executeWorkflow({ workflow, executionId: 'x', mode: 'manual', registry, triggerItems: items });
}

async function output(type: string, parameters: JsonObject, items: Item[] = [{ json: {} }]) {
  const r = await run(type, parameters, items);
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return r.lastOutput;
}

async function failure(type: string, parameters: JsonObject, items: Item[] = [{ json: {} }]) {
  const r = await run(type, parameters, items);
  expect(r.status).toBe('error');
  return r.error!.message;
}

const fileItem = (content: Buffer | string, fileName: string, json: JsonObject = {}, property = 'data'): Item => ({
  json,
  binary: { [property]: toBinary(typeof content === 'string' ? Buffer.from(content, 'utf8') : content, { fileName }) },
});
const content = (item: Item, property = 'data') => Buffer.from(item.binary![property]!.data, 'base64');

/** PDF mínimo escrito à mão: uma página por lista de linhas, com Title/Author no Info. */
function makePdf(pages: string[][], info: Record<string, string> = {}): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const stream = lines.map((l, j) => `BT /F1 12 Tf 72 ${720 - j * 20} Td (${l}) Tj ET`).join('\n');
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const infoId = objs.length;
  objs[infoId] = `<< ${Object.entries(info)
    .map(([k, v]) => `/${k} (${v})`)
    .join(' ')} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PEOPLE: Item[] = [{ json: { id: 1, nome: 'Ana, Maria', ativo: true, end: { cidade: 'SP' } } }, { json: { id: 2, nome: 'Bruno "B"', extra: null } }];

// ---------------------------------------------------------------------
describe('Convert to File', () => {
  it('CSV: achata objetos, junta as colunas e põe aspas quando precisa', async () => {
    const [out] = await output('convertToFile', { operation: 'csv' }, PEOPLE);
    expect(out!.json).toEqual({});
    expect(out!.binary!.data).toMatchObject({ fileName: 'File.csv', mimeType: 'text/csv', fileExtension: 'csv' });
    expect(content(out!).toString()).toBe('id,nome,ativo,end.cidade,extra\n1,"Ana, Maria",TRUE,SP,\n2,"Bruno ""B""",,,');
    const [semCab] = await output('convertToFile', { operation: 'csv', headerRow: false, delimiter: ';', fileName: 'x.csv', binaryPropertyName: 'arq' }, PEOPLE);
    expect(content(semCab!, 'arq').toString()).toBe('1;Ana, Maria;TRUE;SP;\n2;"Bruno ""B""";;;');
  });

  it('CSV: ida e volta com Extract from File', async () => {
    const [file] = await output('convertToFile', { operation: 'csv' }, PEOPLE);
    const rows = await output('extractFromFile', { operation: 'csv' }, [file!]);
    expect(rows.map((r) => r.json)).toEqual([
      { id: '1', nome: 'Ana, Maria', ativo: 'TRUE', 'end.cidade': 'SP' },
      { id: '2', nome: 'Bruno "B"' },
    ]);
    const full = await output('extractFromFile', { operation: 'csv', includeEmptyCells: true }, [file!]);
    expect(full[1]!.json).toEqual({ id: '2', nome: 'Bruno "B"', ativo: '', 'end.cidade': '', extra: '' });
  });

  it('XLSX: ida e volta com tipos, aba e compactação', async () => {
    const [file] = await output('convertToFile', { operation: 'xlsx', sheetName: 'Pessoas', compression: true }, PEOPLE);
    expect(file!.binary!.data).toMatchObject({ fileName: 'File.xlsx', fileExtension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const rows = await output('extractFromFile', { operation: 'xlsx', sheetName: 'Pessoas' }, [file!]);
    expect(rows.map((r) => r.json)).toEqual([
      { id: 1, nome: 'Ana, Maria', ativo: true, 'end.cidade': 'SP' },
      { id: 2, nome: 'Bruno "B"' },
    ]);
    expect(await failure('extractFromFile', { operation: 'xlsx', sheetName: 'Outra' }, [file!])).toMatch(/não tem a aba "Outra". Abas: Pessoas/);
  });

  it('HTML e RTF: tabela de ida e volta', async () => {
    const items: Item[] = [{ json: { produto: 'Café <forte>', preço: 12.5 } }, { json: { produto: 'Pão\nfrancês', preço: 1 } }];
    const [html] = await output('convertToFile', { operation: 'html' }, items);
    expect(content(html!).toString()).toContain('<td>Café &lt;forte&gt;</td><td>12.5</td>');
    expect((await output('extractFromFile', { operation: 'html' }, [html!])).map((r) => r.json)).toEqual([
      { produto: 'Café <forte>', preço: 12.5 },
      { produto: 'Pão\nfrancês', preço: 1 },
    ]);
    const [rtf] = await output('convertToFile', { operation: 'rtf' }, items);
    expect(content(rtf!).toString('latin1')).toMatch(/^\{\\rtf1\\ansi\\trowd\\trautofit1\\cellx1\\cellx2\\pard\\intbl produto\\cell pre\\u231\?o\\cell\\pard\\intbl\\row/);
    expect((await output('extractFromFile', { operation: 'rtf' }, [rtf!])).map((r) => r.json)).toEqual([
      { produto: 'Café <forte>', preço: 12.5 },
      { produto: 'Pão\nfrancês', preço: 1 },
    ]);
    expect((await output('extractFromFile', { operation: 'rtf', rawData: true }, [rtf!]))[1]!.json).toEqual({ produto: 'Pão\nfrancês', preço: '1' });
  });

  it('JSON: um arquivo para todos ou um por item, com formatação e BOM', async () => {
    const items: Item[] = [{ json: { a: 1 } }, { json: { a: 2 } }];
    const [once] = await output('convertToFile', { operation: 'toJson' }, items);
    expect(content(once!).toString()).toBe('[{"a":1},{"a":2}]');
    expect(once!.binary!.data).toMatchObject({ fileName: 'file.json', mimeType: 'application/json' });
    const each = await output('convertToFile', { operation: 'toJson', mode: 'each', format: true, addBOM: true, fileName: '={{ "item" + $json.a + ".json" }}' }, items);
    expect(each).toHaveLength(2);
    expect(content(each[1]!).toString()).toBe('﻿{\n  "a": 2\n}');
    expect(each[1]!.binary!.data!.fileName).toBe('item2.json');
  });

  it('texto: campo vira arquivo na codificação pedida', async () => {
    const [out] = await output('convertToFile', { operation: 'toText', sourceProperty: 'doc.texto', encoding: 'windows1252' }, [{ json: { doc: { texto: 'ação' } } }]);
    expect(out!.binary!.data).toMatchObject({ fileName: 'file.txt', mimeType: 'text/plain' });
    expect(content(out!)).toEqual(iconv.encode('ação', 'windows1252'));
    expect(await failure('convertToFile', { operation: 'toText', sourceProperty: 'nada' })).toMatch(/O campo "nada" não existe/);
  });

  it('base64 vira arquivo (tipo pelo nome, pelo conteúdo ou informado)', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const items: Item[] = [{ json: { b: png.toString('base64') } }, { json: { b: `data:text/plain;base64,${Buffer.from('oi').toString('base64')}` } }];
    const out = await output('convertToFile', { operation: 'toBinary', sourceProperty: 'b' }, items);
    expect(out[0]!.binary!.data).toMatchObject({ mimeType: 'image/png', fileName: 'file.png' });
    expect(content(out[0]!)).toEqual(png);
    expect(content(out[1]!).toString()).toBe('oi');
    const [named] = await output('convertToFile', { operation: 'toBinary', sourceProperty: 'b', fileName: 'nota.pdf' }, [items[0]!]);
    expect(named!.binary!.data!.mimeType).toBe('application/pdf');
  });

  it('XLS e ODS dão erro claro', async () => {
    expect(await failure('convertToFile', { operation: 'xls' }, PEOPLE)).toMatch(/formato XLS não é suportado/);
    expect(await failure('extractFromFile', { operation: 'ods' }, [fileItem('x', 'a.ods')])).toMatch(/formato ODS não é suportado/);
  });

  it('ICS: evento a partir do item', async () => {
    const [out] = await output('convertToFile', { operation: 'iCal', title: '={{ $json.t }}', start: '2026-05-10T14:00:00', end: '', timezone: 'America/Sao_Paulo', uid: 'u1' }, [{ json: { t: 'Reunião' } }]);
    const text = content(out!).toString();
    expect(out!.binary!.data).toMatchObject({ fileName: 'event.ics', mimeType: 'text/calendar' });
    expect(text).toContain('SUMMARY:Reunião');
    expect(text).toContain('DTSTART:20260510T170000Z');
    expect(text).toContain('DTEND:20260510T170000Z');
  });
});

// ---------------------------------------------------------------------
describe('iCalendar', () => {
  it('cria o .ics com participantes, organizador, local e repetição', async () => {
    const [out] = await output('iCal', {
      title: 'Treinamento',
      start: '2026-03-02T09:30:00Z',
      end: '2026-03-02T11:00:00Z',
      timezone: 'UTC',
      description: 'Linha 1\nLinha 2',
      location: 'Sala 3',
      url: 'https://exemplo.com',
      uid: 'evt-1',
      sequence: 2,
      status: 'CONFIRMED',
      busyStatus: 'BUSY',
      calName: 'Equipe',
      recurrenceRule: 'FREQ=WEEKLY;COUNT=4',
      organizerName: 'Ana',
      organizerEmail: 'ana@x.com',
      geoLat: '-23.5',
      geoLon: '-46.6',
      attendees: [{ name: 'Bruno', email: 'bruno@x.com', rsvp: true }],
      fileName: 'treino.ics',
      binaryPropertyName: 'convite',
    });
    const text = content(out!, 'convite').toString();
    expect(out!.binary!.convite).toMatchObject({ fileName: 'treino.ics', mimeType: 'text/calendar' });
    for (const line of [
      'UID:evt-1',
      'SUMMARY:Treinamento',
      'DTSTART:20260302T093000Z',
      'DTEND:20260302T110000Z',
      'SEQUENCE:2',
      'STATUS:CONFIRMED',
      'X-WR-CALNAME:Equipe',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
      'LOCATION:Sala 3',
      'GEO:-23.5;-46.6',
      'ORGANIZER;CN="Ana":MAILTO:ana@x.com',
      'ATTENDEE;RSVP=TRUE;CN="Bruno":mailto:bruno@x.com',
    ]) {
      expect(text).toContain(line);
    }
  });

  it('dia inteiro: datas sem hora e fim no dia seguinte', async () => {
    const [out] = await output('iCal', { title: 'Feriado', start: '2026-11-20T10:00:00', end: '', allDay: true });
    const text = content(out!).toString();
    expect(text).toContain('DTSTART;VALUE=DATE:20261120');
    expect(text).toContain('DTEND;VALUE=DATE:20261121');
  });

  it('recusa data inválida', async () => {
    expect(await failure('iCal', { start: 'amanhã' })).toMatch(/Data de início inválida/);
    expect(await failure('iCal', { start: '' })).toMatch(/Informe a data de início/);
  });

  it('ida e volta: o .ics gerado é lido pelo Extract from File', async () => {
    const [ics] = await output('iCal', { title: 'Visita', start: '2026-01-15T08:00:00', end: '2026-01-15T09:00:00', uid: 'v1', organizerName: 'Ana', organizerEmail: 'ana@x.com' });
    const [out] = await output('extractFromFile', { operation: 'fromIcs' }, [ics!]);
    const cal = out!.json.data as JsonObject;
    expect(cal).toMatchObject({ version: '2.0', prodId: 'adamgibbons/ics', method: 'PUBLISH' });
    expect((cal.events as JsonObject[])[0]).toMatchObject({
      uid: 'v1',
      summary: 'Visita',
      start: { date: '2026-01-15T11:00:00.000Z', type: 'DATE-TIME' },
      end: { date: '2026-01-15T12:00:00.000Z', type: 'DATE-TIME' },
      organizer: { email: 'ana@x.com', name: 'Ana' },
    });
  });
});

// ---------------------------------------------------------------------
describe('Extract from File', () => {
  it('CSV: separador, codificação, BOM, linhas e sem cabeçalho', async () => {
    const csv = iconv.encode('﻿nome;cidade\nJoão;São Paulo\n\nMaria;\nPedro;Rio', 'utf8');
    expect((await output('extractFromFile', { operation: 'csv', delimiter: ';' }, [fileItem(csv, 'a.csv')]))[0]!.json).toEqual({ '﻿nome': 'João', cidade: 'São Paulo' });
    const rows = await output('extractFromFile', { operation: 'csv', delimiter: ';', enableBOM: true, maxRowCount: 2 }, [fileItem(csv, 'a.csv')]);
    expect(rows.map((r) => r.json)).toEqual([{ nome: 'João', cidade: 'São Paulo' }, { nome: 'Maria' }]);
    const latin = iconv.encode('a,b\nação,1', 'latin1');
    expect((await output('extractFromFile', { operation: 'csv', csvEncoding: 'latin1' }, [fileItem(latin, 'b.csv')]))[0]!.json).toEqual({ a: 'ação', b: '1' });
    const noHeader = await output('extractFromFile', { operation: 'csv', headerRow: false, fromLine: 2 }, [fileItem('x,y\n1,\n3,4', 'c.csv')]);
    expect(noHeader.map((r) => r.json)).toEqual([{ row: { '0': '1' } }, { row: { '0': '3', '1': '4' } }]);
    const withEmpty = await output('extractFromFile', { operation: 'csv', headerRow: false, includeEmptyCells: true }, [fileItem('1,\n3,4', 'c.csv')]);
    expect(withEmpty.map((r) => r.json)).toEqual([{ row: ['1', ''] }, { row: ['3', '4'] }]);
  });

  it('CSV: linhas com erro param o nó ou são puladas', async () => {
    const bad = fileItem('a,b\n1,2\n3\n4,5', 'd.csv');
    expect(await failure('extractFromFile', { operation: 'csv' }, [bad])).toMatch(/Não foi possível ler o CSV: Invalid Record Length/);
    expect((await output('extractFromFile', { operation: 'csv', skipRecordsWithErrors: true }, [bad])).map((r) => r.json)).toEqual([
      { a: '1', b: '2' },
      { a: '4', b: '5' },
    ]);
    expect(await failure('extractFromFile', { operation: 'csv', skipRecordsWithErrors: true, maxSkippedRecords: 0.5 }, [bad])).toMatch(/Linhas com erro demais/);
  });

  it('XLSX: datas, fórmulas, intervalo, células vazias e sem cabeçalho', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Dados');
    ws.getCell('B2').value = 'nome';
    ws.getCell('C2').value = 'data';
    ws.getCell('D2').value = 'nome';
    ws.getCell('B3').value = 'Ana';
    ws.getCell('C3').value = new Date(Date.UTC(2026, 0, 2));
    ws.getCell('D3').value = { formula: '1+1', result: 2 };
    ws.getCell('B4').value = 'Bia';
    wb.addWorksheet('Outra').getCell('A1').value = 'x';
    const file = fileItem(Buffer.from(await wb.xlsx.writeBuffer()), 'p.xlsx', { origem: 1 });

    const rows = await output('extractFromFile', { operation: 'xlsx' }, [file]);
    expect(rows.map((r) => r.json)).toEqual([{ nome: 'Ana', data: '2026-01-02T00:00:00.000Z', nome_1: 2 }, { nome: 'Bia' }]);
    expect(rows[0]!.binary).toBeUndefined();
    expect((await output('extractFromFile', { operation: 'xlsx', includeEmptyCells: true, rawData: true }, [file]))[1]!.json).toEqual({ nome: 'Bia', data: '', nome_1: '' });
    expect((await output('extractFromFile', { operation: 'xlsx', rawData: true }, [file]))[0]!.json.data).toBe(46024);
    expect((await output('extractFromFile', { operation: 'xlsx', range: 'B3:C4', headerRow: false }, [file])).map((r) => r.json)).toEqual([
      { row: ['Ana', '2026-01-02T00:00:00.000Z'] },
      { row: ['Bia'] },
    ]);
    expect((await output('extractFromFile', { operation: 'xlsx', range: '2' }, [file])).map((r) => r.json)).toEqual([{ Ana: 'Bia' }]);
    expect(await failure('extractFromFile', { operation: 'xlsx' }, [fileItem('a,b', 'x.csv')])).toMatch(/não está no formato XLSX/);
  });

  it('HTML: primeira tabela, com colspan', async () => {
    const html = '<p>x</p><table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td colspan="2">junto</td><td>3</td></tr></table><table><tr><td>2</td></tr></table>';
    expect((await output('extractFromFile', { operation: 'html' }, [fileItem(html, 't.html')])).map((r) => r.json)).toEqual([{ a: 'junto', c: 3 }]);
  });

  it('JSON, texto, XML e base64 no campo de saída, com "manter da entrada"', async () => {
    const input = fileItem('{"x":[1,2]}', 'a.json', { id: 7 });
    input.binary!.outro = toBinary(Buffer.from('z'), { fileName: 'z.txt' });
    const [json] = await output('extractFromFile', { operation: 'fromJson' }, [input]);
    expect(json!.json).toEqual({ data: { x: [1, 2] } });
    expect(Object.keys(json!.binary!)).toEqual(['outro']);
    const [kept] = await output('extractFromFile', { operation: 'fromJson', destinationKey: 'conteudo.json', keepSource: 'both' }, [input]);
    expect(kept!.json).toEqual({ id: 7, conteudo: { json: { x: [1, 2] } } });
    expect(Object.keys(kept!.binary!)).toEqual(['data', 'outro']);
    const [whole] = await output('extractFromFile', { operation: 'fromJson', destinationKey: '' }, [input]);
    expect(whole!.json).toEqual({ x: [1, 2] });
    expect(await failure('extractFromFile', { operation: 'fromJson' }, [fileItem('não é json', 'a.txt')])).toMatch(/não está em formato JSON/);

    const [text] = await output('extractFromFile', { operation: 'text', destinationKey: 'texto', keepSource: 'json' }, [fileItem('﻿olá', 'a.txt', { id: 1 })]);
    expect(text!.json).toEqual({ id: 1, texto: 'olá' });
    expect(text!.binary).toBeUndefined();
    const [latin] = await output('extractFromFile', { operation: 'text', encoding: 'latin1' }, [fileItem(iconv.encode('ação', 'latin1'), 'a.txt')]);
    expect(latin!.json.data).toBe('ação');
    const [xml] = await output('extractFromFile', { operation: 'xml' }, [fileItem('<a>1</a>', 'a.xml')]);
    expect(xml!.json.data).toBe('<a>1</a>');
    const [b64] = await output('extractFromFile', { operation: 'binaryToProperty', keepSource: 'binary' }, [fileItem('oi', 'a.txt')]);
    expect(b64!.json).toEqual({ data: Buffer.from('oi').toString('base64') });
    expect(b64!.binary!.data).toBeDefined();
  });

  it('base64 de ida e volta: arquivo -> campo -> arquivo', async () => {
    const original = Buffer.from([0, 1, 2, 250, 255]);
    const [prop] = await output('extractFromFile', { operation: 'binaryToProperty', destinationKey: 'b64' }, [fileItem(original, 'x.bin')]);
    const [back] = await output('convertToFile', { operation: 'toBinary', sourceProperty: 'b64', fileName: 'x.bin' }, [prop!]);
    expect(content(back!)).toEqual(original);
  });

  it('PDF: texto, metadados, máximo de páginas e páginas separadas', async () => {
    const pdf = fileItem(makePdf([['Ola mundo', 'Linha 2'], ['Pagina 2']], { Title: 'Teste', Author: 'Eu' }), 'doc.pdf', { id: 3 });
    const [out] = await output('extractFromFile', { operation: 'pdf' }, [pdf]);
    expect(out!.json).toMatchObject({ numpages: 2, numrender: 2, text: 'Ola mundo\nLinha 2\n\nPagina 2', info: { Title: 'Teste', Author: 'Eu', PDFFormatVersion: '1.4' } });
    expect(typeof out!.json.version).toBe('string');
    expect(out!.binary).toBeUndefined();
    const [some] = await output('extractFromFile', { operation: 'pdf', maxPages: 1, joinPages: false, keepSource: 'both' }, [pdf]);
    expect(some!.json).toMatchObject({ id: 3, text: ['Ola mundo\nLinha 2'] });
    expect(some!.binary!.data).toBeDefined();
    expect(await failure('extractFromFile', { operation: 'pdf' }, [fileItem('não é pdf', 'x.pdf')])).toMatch(/não é um PDF válido|Não foi possível ler o PDF/);
  });

  it('erro claro quando o item não tem o arquivo', async () => {
    expect(await failure('extractFromFile', { operation: 'text' }, [{ json: {} }])).toMatch(/não tem arquivo/);
  });
});

// ---------------------------------------------------------------------
describe('leitura de ICS', () => {
  it('lê eventos com fuso, dia inteiro, repetição, alarmes e participantes', () => {
    const cal = parseIcsCalendar(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Teste//PT',
        'X-WR-CALNAME:Agenda',
        'BEGIN:VEVENT',
        'UID:1',
        'DTSTAMP:20260101T120000Z',
        'DTSTART;TZID=America/Sao_Paulo:20260110T090000',
        'DTEND;TZID=America/Sao_Paulo:20260110T100000',
        'SUMMARY:Consulta\\, retorno',
        'DESCRIPTION:Linha 1\\nLinha',
        ' 2',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,2TU;UNTIL=20260301;COUNT=3',
        'ATTENDEE;CN="Bia";RSVP=TRUE;PARTSTAT=ACCEPTED:mailto:bia@x.com',
        'CATEGORIES:a,b',
        'GEO:-23.5;-46.6',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        'END:VALARM',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:2',
        'DTSTART;VALUE=DATE:20260120',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    expect(cal).toMatchObject({ version: '2.0', prodId: '-//Teste//PT', name: 'Agenda' });
    const [e1, e2] = cal.events as JsonObject[];
    expect(e1).toEqual({
      uid: '1',
      stamp: { date: '2026-01-01T12:00:00.000Z', type: 'DATE-TIME' },
      start: { date: '2026-01-10T12:00:00.000Z', type: 'DATE-TIME', local: { date: '2026-01-10T09:00:00.000Z', timezone: 'America/Sao_Paulo', tzoffset: '-0300' } },
      end: { date: '2026-01-10T13:00:00.000Z', type: 'DATE-TIME', local: { date: '2026-01-10T10:00:00.000Z', timezone: 'America/Sao_Paulo', tzoffset: '-0300' } },
      summary: 'Consulta, retorno',
      description: 'Linha 1\nLinha2',
      recurrenceRule: { frequency: 'WEEKLY', byDay: [{ day: 'MO' }, { day: 'TU', occurrence: 2 }], until: { date: '2026-03-01T00:00:00.000Z', type: 'DATE' }, count: 3 },
      attendees: [{ email: 'bia@x.com', name: 'Bia', partstat: 'ACCEPTED', rsvp: true }],
      categories: ['a', 'b'],
      geo: { lat: -23.5, lon: -46.6 },
      alarms: [{ action: 'DISPLAY', trigger: { type: 'relative', value: { before: true, minutes: 15 } } }],
    });
    expect(e2).toEqual({ uid: '2', start: { date: '2026-01-20T00:00:00.000Z', type: 'DATE' } });
    expect(() => parseIcsCalendar('oi')).toThrow(/não é um calendário ICS/);
  });

  it('flattenObject achata como o n8n', () => {
    expect(flattenObject({ a: { b: 1, c: [1, { d: 2 }] }, e: null })).toEqual({ 'a.b': 1, 'a.c.0': 1, 'a.c.1.d': 2, e: null });
  });
});

// ---------------------------------------------------------------------
describe('conversores do n8n (arquivos)', () => {
  const convert = (type: string, parameters: Record<string, unknown>, typeVersion = 1) => {
    const warnings: string[] = [];
    const node: N8nNode = { name: 'N', type: `n8n-nodes-base.${type}`, typeVersion, parameters };
    const ctx: Ctx = { node, params: parameters, warn: (m) => warnings.push(m), options: {}, timezone: 'America/Sao_Paulo' };
    return { result: converters[type]!(ctx), warnings };
  };

  it('Convert to File: planilhas, JSON, texto, base64 e ICS', () => {
    expect(convert('convertToFile', {}).result).toEqual({
      type: 'convertToFile',
      parameters: { operation: 'csv', binaryPropertyName: 'data', headerRow: true, delimiter: ',', fileName: 'File.csv' },
    });
    expect(convert('convertToFile', { operation: 'xlsx', binaryPropertyName: 'x', options: { sheetName: 'S', compression: true, headerRow: false, fileName: '={{ $json.n }}' } }).result!.parameters).toEqual({
      operation: 'xlsx',
      binaryPropertyName: 'x',
      headerRow: false,
      sheetName: 'S',
      compression: true,
      fileName: '={{ $json.n }}',
    });
    expect(convert('convertToFile', { operation: 'toJson', mode: 'each', options: { format: true, encoding: 'latin1', addBOM: false, fileName: 'a.json' } }).result!.parameters).toEqual({
      operation: 'toJson',
      binaryPropertyName: 'data',
      mode: 'each',
      format: true,
      encoding: 'latin1',
      addBOM: false,
      fileName: 'a.json',
    });
    expect(convert('convertToFile', { operation: 'toText', sourceProperty: 'txt' }).result!.parameters).toEqual({ operation: 'toText', binaryPropertyName: 'data', sourceProperty: 'txt' });
    expect(convert('convertToFile', { operation: 'toBinary', sourceProperty: 'b', options: { mimeType: 'image/png' } }, 1.1).result!.parameters).toEqual({
      operation: 'toBinary',
      binaryPropertyName: 'data',
      sourceProperty: 'b',
      mimeType: 'image/png',
    });
    const v1 = convert('convertToFile', { operation: 'toBinary', sourceProperty: 'b', options: { dataIsBase64: false, encoding: 'utf8', mimeType: 'text/csv' } }, 1);
    expect(v1.result!.parameters).toMatchObject({ operation: 'toText', encoding: 'utf8' });
    expect(v1.warnings[0]).toMatch(/text\/plain/);
    const xls = convert('convertToFile', { operation: 'xls' });
    expect(xls.result).toBeNull();
    expect(xls.warnings[0]).toMatch(/XLS não é suportado/);
    const ical = convert('convertToFile', {
      operation: 'iCal',
      title: 'T',
      start: '={{ $json.s }}',
      end: '',
      additionalFields: {
        attendeesUi: { attendeeValues: [{ name: 'A', email: 'a@x', rsvp: true }] },
        organizerUi: { organizerValues: { name: 'O', email: 'o@x' } },
        geolocationUi: { geolocationValues: { lat: '1', lon: '2' } },
        status: 'CANCELLED',
        sequence: 3,
        fileName: 'e.ics',
        useWorkflowTimezone: true,
      },
    });
    expect(ical.result).toEqual({
      type: 'convertToFile',
      parameters: {
        operation: 'iCal',
        title: 'T',
        start: '={{ $json.s }}',
        end: '',
        allDay: false,
        binaryPropertyName: 'data',
        timezone: 'UTC',
        status: 'CANCELLED',
        fileName: 'e.ics',
        sequence: 3,
        organizerName: 'O',
        organizerEmail: 'o@x',
        geoLat: '1',
        geoLon: '2',
        attendees: [{ name: 'A', email: 'a@x', rsvp: true }],
      },
    });
    expect(ical.warnings[0]).toMatch(/fuso/);
  });

  it('iCalendar', () => {
    expect(convert('iCal', { title: 'X', start: 's', end: 'e', allDay: true }).result).toEqual({
      type: 'iCal',
      parameters: { operation: 'createEventFile', title: 'X', start: 's', end: 'e', allDay: true, binaryPropertyName: 'data', timezone: 'UTC' },
    });
  });

  it('Extract from File: planilhas, CSV, PDF e campos', () => {
    expect(
      convert(
        'extractFromFile',
        {
          operation: 'csv',
          binaryPropertyName: 'f',
          options: { delimiter: ';', encoding: 'latin1', enableBOM: true, headerRow: false, maxRowCount: 5, fromLine: 2, skipRecordsWithErrors: { value: { enabled: true, maxSkippedRecords: 3 } }, readAsString: true },
        },
        1.2,
      ).result!.parameters,
    ).toEqual({
      operation: 'csv',
      binaryPropertyName: 'f',
      headerRow: false,
      delimiter: ';',
      csvEncoding: 'latin1',
      enableBOM: true,
      maxRowCount: 5,
      fromLine: 2,
      skipRecordsWithErrors: true,
      maxSkippedRecords: 3,
    });
    expect(convert('extractFromFile', { operation: 'xlsx', options: { sheetName: 'S', range: 'A1:B2', includeEmptyCells: true } }, 1.2).result!.parameters).toEqual({
      operation: 'xlsx',
      binaryPropertyName: 'data',
      includeEmptyCells: true,
      sheetName: 'S',
      range: 'A1:B2',
    });
    const old = convert('extractFromFile', { operation: 'xlsx' }, 1.1);
    expect(old.result!.parameters.rawData).toBe(true);
    expect(old.warnings[0]).toMatch(/número serial/);
    expect(convert('extractFromFile', { operation: 'binaryToPropery', destinationKey: 'b64', options: { keepSource: 'both' } }).result!.parameters).toEqual({
      operation: 'binaryToProperty',
      binaryPropertyName: 'data',
      destinationKey: 'b64',
      keepSource: 'both',
    });
    expect(convert('extractFromFile', { operation: 'fromJson', options: { encoding: 'utf16', stripBOM: false } }).result!.parameters).toEqual({
      operation: 'fromJson',
      binaryPropertyName: 'data',
      destinationKey: 'data',
      encoding: 'utf16',
      stripBOM: false,
      keepSource: 'none',
    });
    expect(convert('extractFromFile', { operation: 'pdf', options: { joinPages: false, maxPages: 2, password: 'x', keepSource: 'json' } }).result!.parameters).toEqual({
      operation: 'pdf',
      binaryPropertyName: 'data',
      joinPages: false,
      maxPages: 2,
      password: 'x',
      keepSource: 'json',
    });
    expect(convert('extractFromFile', { operation: 'ods' }).result).toBeNull();
  });

  it('Spreadsheet File: ler e gravar', () => {
    expect(convert('spreadsheetFile', { operation: 'toFile', fileFormat: 'csv', options: { headerRow: false } }, 2).result).toEqual({
      type: 'convertToFile',
      parameters: { operation: 'csv', binaryPropertyName: 'data', headerRow: false, delimiter: ',', fileName: 'spreadsheet.csv' },
    });
    expect(convert('spreadsheetFile', { operation: 'toFile' }, 2).result).toBeNull();
    const auto = convert('spreadsheetFile', {}, 1);
    expect(auto.result).toEqual({ type: 'extractFromFile', parameters: { operation: 'xlsx', binaryPropertyName: 'data', rawData: true } });
    expect(auto.warnings[0]).toMatch(/ficou XLSX/);
    expect(convert('spreadsheetFile', { operation: 'fromFile', fileFormat: 'html', options: { rawData: true } }, 2).result).toEqual({
      type: 'extractFromFile',
      parameters: { operation: 'html', binaryPropertyName: 'data', rawData: true },
    });
    expect(convert('spreadsheetFile', { operation: 'fromFile', fileFormat: 'xls' }, 2).result).toBeNull();
  });

  it('Read PDF', () => {
    expect(convert('readPDF', { binaryPropertyName: 'pdf', encrypted: true, password: 's' }).result).toEqual({
      type: 'extractFromFile',
      parameters: { operation: 'pdf', binaryPropertyName: 'pdf', keepSource: 'binary', password: 's' },
    });
    expect(convert('readPDF', { password: 's' }).result!.parameters).toEqual({ operation: 'pdf', binaryPropertyName: 'data', keepSource: 'binary' });
  });

  it('Move Binary Data: os dois sentidos', () => {
    expect(convert('moveBinaryData', {}).result).toEqual({
      type: 'extractFromFile',
      parameters: { binaryPropertyName: 'data', operation: 'fromJson', destinationKey: '', keepSource: 'none' },
    });
    expect(convert('moveBinaryData', { setAllData: false, sourceKey: 'f', destinationKey: 'x', options: { keepAsBase64: true, keepSource: true } }).result!.parameters).toEqual({
      binaryPropertyName: 'f',
      operation: 'binaryToProperty',
      destinationKey: 'x',
      keepSource: 'both',
    });
    expect(convert('moveBinaryData', { setAllData: false, options: { encoding: 'latin1' } }).result!.parameters).toMatchObject({ operation: 'text', keepSource: 'json', encoding: 'latin1' });
    expect(convert('moveBinaryData', { setAllData: false, options: { jsonParse: true } }).result!.parameters.operation).toBe('fromJson');

    const all = convert('moveBinaryData', { mode: 'jsonToBinary', destinationKey: 'arq', options: { fileName: 'a.json' } });
    expect(all.result).toEqual({ type: 'convertToFile', parameters: { binaryPropertyName: 'arq', operation: 'toJson', mode: 'each', fileName: 'a.json' } });
    expect(all.warnings.at(-1)).toMatch(/devolve só o arquivo/);
    expect(convert('moveBinaryData', { mode: 'jsonToBinary', convertAllData: false, sourceKey: 'b', options: { dataIsBase64: true, mimeType: 'image/png' } }).result!.parameters).toEqual({
      binaryPropertyName: 'data',
      operation: 'toBinary',
      sourceProperty: 'b',
      mimeType: 'image/png',
    });
    const raw = convert('moveBinaryData', { mode: 'jsonToBinary', convertAllData: false, sourceKey: 't', options: { useRawData: true, encoding: 'utf8' } });
    expect(raw.result!.parameters).toEqual({ binaryPropertyName: 'data', operation: 'toText', sourceProperty: 't', encoding: 'utf8' });
  });

  it('o JSON convertido roda no nó: Move Binary Data com "Set All Data"', async () => {
    const { result } = convert('moveBinaryData', {});
    const [out] = await output(result!.type, result!.parameters, [fileItem('{"a":1}', 'x.json', { velho: true })]);
    expect(out!.json).toEqual({ a: 1 });
    expect(out!.binary).toBeUndefined();
  });
});
