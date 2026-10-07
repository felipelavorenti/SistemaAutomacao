import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as fflate from 'fflate';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBinary } from '../src/binary.js';
import { executeWorkflow } from '../src/executor.js';
import { converters } from '../src/n8n/convert-files-disk.js';
import type { Ctx, N8nNode } from '../src/n8n/import.js';
import { compression, createTar, boundedUntar, decodeBmp, editImage, encodeBmp, parseColor, readWriteFile, resizeTarget, wrapText } from '../src/nodes/files-disk.js';
import { manualTrigger } from '../src/nodes/triggers.js';
import { NodeRegistry } from '../src/registry.js';
import type { Item, JsonObject, WorkflowDefinition } from '../src/types.js';

const registry = new NodeRegistry([manualTrigger, compression, editImage, readWriteFile]);

async function run(type: string, parameters: JsonObject, items: Item[] = [{ json: {} }], filesDirs: string[] = []) {
  const workflow: WorkflowDefinition = {
    nodes: [
      { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'n', name: 'Nó', type, position: { x: 0, y: 0 }, parameters },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'n', toInput: 0 }],
  };
  return executeWorkflow({ workflow, executionId: 'x', mode: 'manual', registry, triggerItems: items, filesDirs });
}

async function output(type: string, parameters: JsonObject, items?: Item[], filesDirs?: string[]) {
  const r = await run(type, parameters, items, filesDirs);
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return r.lastOutput;
}

async function failure(type: string, parameters: JsonObject, items?: Item[], filesDirs?: string[]) {
  const r = await run(type, parameters, items, filesDirs);
  expect(r.status).toBe('error');
  return r.error?.message ?? '';
}

const text = (s: string, fileName: string) => toBinary(Buffer.from(s), { fileName });
const buf = (item: Item, prop = 'data') => Buffer.from(item.binary![prop]!.data, 'base64');

// ---------------------------------------------------------------------
describe('Compression', () => {
  const input: Item[] = [{ json: { id: 1 }, binary: { data: text('olá mundo '.repeat(50), 'a.txt'), data2: text('segundo', 'b.csv') } }];

  it('zip: compacta vários arquivos e descompacta de volta', async () => {
    const [zipped] = await output('compression', { operation: 'compress', binaryPropertyName: 'data, data2', outputFormat: 'zip', fileName: 'pacote.zip', binaryPropertyOutput: 'zip' }, input);
    expect(zipped!.json).toEqual({ id: 1 });
    expect(Object.keys(zipped!.binary!)).toEqual(['zip']);
    expect(zipped!.binary!.zip).toMatchObject({ fileName: 'pacote.zip', mimeType: 'application/zip', fileExtension: 'zip' });
    const entries = fflate.unzipSync(buf(zipped!, 'zip'));
    expect(Object.keys(entries).sort()).toEqual(['a.txt', 'b.csv']);

    const [unzipped] = await output('compression', { operation: 'decompress', binaryPropertyName: 'zip', outputPrefix: 'file_' }, [zipped!]);
    expect(Object.keys(unzipped!.binary!).sort()).toEqual(['file_0', 'file_1']);
    const byName = Object.fromEntries(Object.values(unzipped!.binary!).map((b) => [b.fileName, Buffer.from(b.data, 'base64').toString()]));
    expect(byName).toEqual({ 'a.txt': 'olá mundo '.repeat(50), 'b.csv': 'segundo' });
    expect(unzipped!.binary!.file_0!.mimeType).toMatch(/text\//);
  });

  it('zip: entradas em subpastas ganham directory e __MACOSX fica de fora', async () => {
    const zip = Buffer.from(fflate.zipSync({ 'pasta/x.json': fflate.strToU8('{"a":1}'), '__MACOSX/._x': fflate.strToU8('lixo'), 'vazia/': new Uint8Array() }));
    const [out] = await output('compression', { operation: 'decompress' }, [{ json: {}, binary: { data: toBinary(zip, { fileName: 'z.zip' }) } }]);
    expect(Object.keys(out!.binary!)).toEqual(['file_0']);
    expect(out!.binary!.file_0).toMatchObject({ fileName: 'x.json', directory: 'pasta', mimeType: 'application/json' });
  });

  it('gzip: compacta cada arquivo e descompacta de volta', async () => {
    const [gz] = await output('compression', { operation: 'compress', binaryPropertyName: 'data,data2', outputFormat: 'gzip' }, input);
    expect(Object.keys(gz!.binary!)).toEqual(['data', 'data1']);
    expect(gz!.binary!.data).toMatchObject({ fileName: 'a.txt.gz', mimeType: 'application/gzip' });
    expect(gz!.binary!.data1!.fileName).toBe('b.csv.gz');
    expect(Buffer.from(fflate.gunzipSync(buf(gz!))).toString()).toBe('olá mundo '.repeat(50));

    const [back] = await output('compression', { operation: 'decompress', binaryPropertyName: 'data, data1', outputPrefix: 'f' }, [gz!]);
    expect(back!.binary!.f0).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain' });
    expect(back!.binary!.f1).toMatchObject({ fileName: 'b.csv', mimeType: 'text/csv' });
    expect(buf(back!, 'f1').toString()).toBe('segundo');
  });

  it('gzip com nome informado', async () => {
    const [gz] = await output('compression', { operation: 'compress', binaryPropertyName: 'data', outputFormat: 'gzip', fileName: 'saida.gz', binaryPropertyOutput: 'out' }, input);
    expect(gz!.binary!.out!.fileName).toBe('saida.txt.gz');
  });

  it('tar e tar.gz: ida e volta, inclusive nome longo', async () => {
    const long = `${'pasta/'.repeat(30)}arquivo.txt`;
    const items: Item[] = [{ json: {}, binary: { data: text('um', 'a.txt'), data2: text('dois', long) } }];
    for (const format of ['tar', 'targz']) {
      const fileName = format === 'tar' ? 'p.tar' : 'p.tar.gz';
      const [packed] = await output('compression', { operation: 'compress', binaryPropertyName: 'data,data2', outputFormat: format, fileName }, items);
      const [unpacked] = await output('compression', { operation: 'decompress' }, [packed!]);
      const files = Object.values(unpacked!.binary!).map((b) => [b.directory ? `${b.directory}/${b.fileName}` : b.fileName, Buffer.from(b.data, 'base64').toString()]);
      expect(files).toEqual([
        ['a.txt', 'um'],
        [long, 'dois'],
      ]);
    }
  });

  it('tar: ignora caminhos que saem da raiz', async () => {
    const tar = await createTar([{ fileName: '../fora.txt', data: Buffer.from('x') }, { fileName: 'ok.txt', data: Buffer.from('y') }], false);
    expect(Object.keys(await boundedUntar(tar))).toEqual(['ok.txt']);
  });

  it('erros claros: formato não suportado, sem arquivo, sem extensão', async () => {
    expect(await failure('compression', { operation: 'decompress' }, [{ json: {}, binary: { data: text('x', 'a.rar') } }])).toMatch(/Formato "\.rar" não suportado/);
    expect(await failure('compression', { operation: 'decompress' }, [{ json: {} }])).toMatch(/não tem arquivo/);
    expect(await failure('compression', { operation: 'decompress' }, [{ json: {}, binary: { data: { data: 'eA==', mimeType: 'application/octet-stream' } } }])).toMatch(/não tem extensão/);
    expect(await failure('compression', { operation: 'decompress' }, [{ json: {}, binary: { data: text('não é zip', 'a.zip') } }])).toMatch(/Não foi possível descompactar o zip/);
  });
});

// ---------------------------------------------------------------------
describe('Edit Image', () => {
  let png: Buffer;
  let overlay: Buffer;
  const meta = async (item: Item, prop = 'data') => sharp(buf(item, prop)).metadata();
  const pixel = async (item: Item, x: number, y: number, prop = 'data') => {
    const { data, info } = await sharp(buf(item, prop)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const o = (y * info.width + x) * 4;
    return [data[o], data[o + 1], data[o + 2], data[o + 3]];
  };
  const imageItem = (): Item => ({ json: { id: 7 }, binary: { data: toBinary(png, { fileName: 'foto.png' }), over: toBinary(overlay, { fileName: 'o.png' }) } });

  beforeAll(async () => {
    png = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
    overlay = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  });

  it('create: imagem nova em PNG com os padrões do n8n', async () => {
    const [out] = await output('editImage', { operation: 'create' });
    const m = await meta(out!);
    expect([m.format, m.width, m.height]).toEqual(['png', 50, 50]);
    expect(out!.binary!.data).toMatchObject({ mimeType: 'image/png', fileExtension: 'png' });
    expect(await pixel(out!, 1, 1)).toEqual([255, 255, 255, 255]);
    const [custom] = await output('editImage', { operation: 'create', width: 30, height: 20, backgroundColor: '#ff0000', format: 'jpeg', fileName: 'novo.jpg' });
    const m2 = await meta(custom!);
    expect([m2.format, m2.width, m2.height]).toEqual(['jpeg', 30, 20]);
    expect(custom!.binary!.data).toMatchObject({ fileName: 'novo.jpg', mimeType: 'image/jpeg' });
  });

  it('information: formato e tamanho', async () => {
    const [out] = await output('editImage', { operation: 'information' }, [imageItem()]);
    expect(out!.json).toMatchObject({ format: 'PNG', size: { width: 200, height: 100 }, Geometry: '200x100', depth: 8, hasAlpha: true });
    expect(out!.binary!.data!.data).toBe(png.toString('base64'));
  });

  it('blur e border', async () => {
    const [blurred] = await output('editImage', { operation: 'blur', blur: 5, sigma: 2 }, [imageItem()]);
    const m = await meta(blurred!);
    expect([m.format, m.width, m.height]).toEqual(['png', 200, 100]);
    const [bordered] = await output('editImage', { operation: 'border', borderWidth: 10, borderHeight: 5, borderColor: '#00ff00' }, [imageItem()]);
    const mb = await meta(bordered!);
    expect([mb.width, mb.height]).toEqual([220, 110]);
    expect(await pixel(bordered!, 2, 2)).toEqual([0, 255, 0, 255]);
    expect(await pixel(bordered!, 100, 50)).toEqual([0, 0, 255, 255]);
    expect(bordered!.json).toEqual({ id: 7 });
    expect(bordered!.binary!.over).toBeDefined();
  });

  it('composite: sobrepõe na posição, inclusive saindo da borda', async () => {
    const [out] = await output('editImage', { operation: 'composite', dataPropertyNameComposite: 'over', positionX: 10, positionY: 20 }, [imageItem()]);
    expect([(await meta(out!)).width, (await meta(out!)).height]).toEqual([200, 100]);
    expect(await pixel(out!, 15, 25)).toEqual([255, 0, 0, 255]);
    expect(await pixel(out!, 5, 5)).toEqual([0, 0, 255, 255]);
    const [edge] = await output('editImage', { operation: 'composite', dataPropertyNameComposite: 'over', positionX: -20, positionY: 90 }, [imageItem()]);
    expect(await pixel(edge!, 5, 95)).toEqual([255, 0, 0, 255]);
    expect(await pixel(edge!, 25, 95)).toEqual([0, 0, 255, 255]);
    expect(await failure('editImage', { operation: 'composite', dataPropertyNameComposite: 'over', operator: 'Bumpmap' }, [imageItem()])).toMatch(/operador "Bumpmap" não existe/);
  });

  it('crop: corta e limita à imagem', async () => {
    const [out] = await output('editImage', { operation: 'crop', width: 50, height: 40, positionX: 10, positionY: 10 }, [imageItem()]);
    expect([(await meta(out!)).width, (await meta(out!)).height]).toEqual([50, 40]);
    const [clamped] = await output('editImage', { operation: 'crop', width: 500, height: 500, positionX: 150, positionY: 0 }, [imageItem()]);
    expect([(await meta(clamped!)).width, (await meta(clamped!)).height]).toEqual([50, 100]);
  });

  it('draw: retângulo, círculo e linha', async () => {
    const [rect] = await output('editImage', { operation: 'draw', primitive: 'rectangle', color: '#ff000000', startPositionX: 10, startPositionY: 10, endPositionX: 50, endPositionY: 50 }, [imageItem()]);
    expect(await pixel(rect!, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(await pixel(rect!, 80, 30)).toEqual([0, 0, 255, 255]);
    const [circle] = await output('editImage', { operation: 'draw', primitive: 'circle', color: 'yellow', startPositionX: 100, startPositionY: 50, endPositionX: 120, endPositionY: 50 }, [imageItem()]);
    expect(await pixel(circle!, 100, 50)).toEqual([255, 255, 0, 255]);
    expect(await pixel(circle!, 100, 80)).toEqual([0, 0, 255, 255]);
    const [line] = await output('editImage', { operation: 'draw', primitive: 'line', color: '#ffffff', startPositionX: 0, startPositionY: 10, endPositionX: 199, endPositionY: 10 }, [imageItem()]);
    expect((await pixel(line!, 100, 10))[1]).toBeGreaterThan(200);
    expect((await meta(line!)).width).toBe(200);
  });

  it('resize: opções de proporção do n8n', async () => {
    const size = async (params: JsonObject) => {
      const [out] = await output('editImage', { operation: 'resize', ...params }, [imageItem()]);
      const m = await meta(out!);
      return [m.width, m.height];
    };
    expect(await size({ width: 50, height: 50, resizeOption: 'ignoreAspectRatio' })).toEqual([50, 50]);
    expect(await size({ width: 50, height: 50, resizeOption: 'percent' })).toEqual([100, 50]);
    expect(await size({ width: 100, height: 100, resizeOption: 'minimumArea' })).toEqual([200, 100]);
    expect(await size({ width: 50, height: 50, resizeOption: 'minimumArea' })).toEqual([100, 50]);
    expect(await size({ width: 100, height: 100, resizeOption: 'onlyIfLarger' })).toEqual([100, 50]);
    expect(await size({ width: 1000, height: 1000, resizeOption: 'onlyIfLarger' })).toEqual([200, 100]);
    expect(await size({ width: 400, height: 400, resizeOption: 'onlyIfSmaller' })).toEqual([400, 200]);
    expect(await size({ width: 100, height: 100, resizeOption: 'onlyIfSmaller' })).toEqual([200, 100]);
    expect(await size({ width: 50, height: 100, resizeOption: 'maximumArea' })).toEqual([100, 50]);
    // Padrão do n8n: 500x500, área máxima (não aumenta).
    expect(await size({})).toEqual([200, 100]);
    expect(resizeTarget(1000, 1000, 100, 100, 'maximumArea')).toEqual({ width: 100, height: 100 });
  });

  it('rotate e shear', async () => {
    const [r90] = await output('editImage', { operation: 'rotate', rotate: 90 }, [imageItem()]);
    expect([(await meta(r90!)).width, (await meta(r90!)).height]).toEqual([100, 200]);
    const [r45] = await output('editImage', { operation: 'rotate', rotate: 45 }, [imageItem()]);
    const m45 = await meta(r45!);
    expect(m45.width).toBeGreaterThanOrEqual(212);
    expect(m45.height).toBeGreaterThanOrEqual(212);
    expect((await pixel(r45!, 0, 0))[3]).toBe(0);
    const [sheared] = await output('editImage', { operation: 'shear', degreesX: 45, degreesY: 0 }, [imageItem()]);
    const ms = await meta(sheared!);
    expect(ms.width).toBeGreaterThanOrEqual(299);
    expect(ms.width).toBeLessThanOrEqual(301);
    expect(ms.height).toBe(100);
  });

  it('text: escreve o texto alinhado', async () => {
    const white = await sharp({ create: { width: 200, height: 100, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const [out] = await output('editImage', { operation: 'text', text: 'Olá <mundo> & cia', fontSize: 30, fontColor: '#000000', positionX: 0, positionY: 0 }, [
      { json: {}, binary: { data: toBinary(white, { fileName: 'b.png' }) } },
    ]);
    const m = await meta(out!);
    expect([m.width, m.height]).toEqual([200, 100]);
    const { data } = await sharp(buf(out!)).raw().toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 128) dark++;
    expect(dark).toBeGreaterThan(50);
    expect(wrapText('um dois três quatro', 8)).toEqual(['um dois', 'três', 'quatro']);
  });

  it('transparent: a cor vira transparente', async () => {
    const [out] = await output('editImage', { operation: 'transparent', color: '#0000ff' }, [imageItem()]);
    expect((await pixel(out!, 10, 10))[3]).toBe(0);
    expect((await meta(out!)).width).toBe(200);
  });

  it('multiStep: etapas em ordem, campos vazios valem o padrão', async () => {
    const [out] = await output(
      'editImage',
      {
        operation: 'multiStep',
        operations: [
          { operation: 'resize', width: 100, height: 100, resizeOption: 'ignoreAspectRatio' },
          { operation: 'border', borderWidth: null, borderHeight: '', borderColor: '' },
          { operation: 'crop', width: 60, height: 50, positionX: null, positionY: null },
        ],
        format: 'webp',
        destinationKey: 'editada',
      },
      [imageItem()],
    );
    const m = await meta(out!, 'editada');
    expect([m.format, m.width, m.height]).toEqual(['webp', 60, 50]);
    expect(out!.binary!.editada).toMatchObject({ mimeType: 'image/webp', fileExtension: 'webp' });
    // Como no n8n: o campo de saída novo não herda o nome do arquivo de entrada.
    expect(out!.binary!.editada!.fileName).toBeUndefined();
    expect(out!.binary!.data!.data).toBe(png.toString('base64'));
  });

  it('BMP: lê e grava', async () => {
    const raw = { data: Buffer.alloc(3 * 2 * 4, 255), width: 3, height: 2 };
    raw.data[0] = 10;
    const bmp = encodeBmp(raw);
    const decoded = decodeBmp(bmp);
    expect([decoded.width, decoded.height, decoded.data[0], decoded.data[3]]).toEqual([3, 2, 10, 255]);
    const [out] = await output('editImage', { operation: 'resize', width: 200, height: 200, resizeOption: 'percent' }, [{ json: {}, binary: { data: toBinary(bmp, { fileName: 'x.bmp' }) } }]);
    expect(out!.binary!.data).toMatchObject({ mimeType: 'image/bmp', fileExtension: 'bmp' });
    const back = decodeBmp(buf(out!));
    expect([back.width, back.height]).toEqual([6, 4]);
  });

  it('cores do GraphicsMagick e erros', async () => {
    expect(parseColor('#ff000000')).toEqual({ r: 255, g: 0, b: 0, alpha: 1 });
    expect(parseColor('#ffffffff').alpha).toBe(0);
    expect(parseColor('transparent').alpha).toBe(0);
    expect(() => parseColor('azulzinho')).toThrow(/Cor inválida/);
    expect(await failure('editImage', { operation: 'blur', blur: 'abc' }, [imageItem()])).toMatch(/"blur" precisa ser um número/);
    expect(await failure('editImage', { operation: 'blur' }, [{ json: {} }])).toMatch(/não tem arquivo/);
    expect(await failure('editImage', { operation: 'blur' }, [{ json: {}, binary: { data: text('x', 'a.png') } }])).toMatch(/Não foi possível abrir a imagem/);
  });
});

// ---------------------------------------------------------------------
describe('Read/Write Files from Disk', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'info8n-files-'));
    root = path.join(base, 'files');
    outside = path.join(base, 'fora');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, 'a.csv'), 'x,y\n1,2\n');
    await writeFile(path.join(root, 'b.txt'), 'texto');
    await writeFile(path.join(root, 'sub', 'c.csv'), 'z\n3\n');
    await writeFile(path.join(root, 'rel[1].txt'), 'colchetes');
    await writeFile(path.join(outside, 'segredo.txt'), 'não pode');
    await symlink(outside, path.join(root, 'atalho'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('lê um arquivo e devolve binário e dados no JSON', async () => {
    const out = await output('readWriteFile', { operation: 'read', fileSelector: path.join(root, 'a.csv') }, undefined, [root]);
    expect(out).toHaveLength(1);
    expect(out[0]!.json).toEqual({ mimeType: 'text/csv', fileType: 'text', fileName: 'a.csv', fileExtension: 'csv', fileSize: '8 B' });
    expect(out[0]!.binary!.data).toMatchObject({ fileName: 'a.csv', directory: root });
    expect(buf(out[0]!).toString()).toBe('x,y\n1,2\n');
  });

  it('glob: um item por arquivo, caminho relativo começa na primeira pasta', async () => {
    const out = await output('readWriteFile', { operation: 'read', fileSelector: '**/*.csv', dataPropertyName: 'arq' }, undefined, [root]);
    expect(out.map((i) => i.json.fileName)).toEqual(['a.csv', 'c.csv']);
    expect(out[1]!.binary!.arq!.directory).toBe(path.join(root, 'sub'));
    const braces = await output('readWriteFile', { operation: 'read', fileSelector: `${root}/*.{txt,csv}` }, undefined, [root]);
    expect(braces.map((i) => i.json.fileName)).toEqual(['a.csv', 'b.txt', 'rel[1].txt']);
  });

  it('colchetes literais por padrão; desligado vira classe', async () => {
    const lit = await output('readWriteFile', { operation: 'read', fileSelector: 'rel[1].txt' }, undefined, [root]);
    expect(buf(lit[0]!).toString()).toBe('colchetes');
    const cls = await output('readWriteFile', { operation: 'read', fileSelector: '[ab].*', literalBrackets: false }, undefined, [root]);
    expect(cls.map((i) => i.json.fileName)).toEqual(['a.csv', 'b.txt']);
  });

  it('troca nome, extensão e tipo do arquivo lido', async () => {
    const [out] = await output('readWriteFile', { operation: 'read', fileSelector: 'b.txt', fileName: 'n.dat', fileExtension: 'dat', mimeType: 'application/x-teste' }, undefined, [root]);
    expect(out!.json).toMatchObject({ fileName: 'n.dat', fileExtension: 'dat', mimeType: 'application/x-teste' });
  });

  it('recusa caminhos fora das pastas, com "..", por link simbólico e sem pasta liberada', async () => {
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: path.join(outside, 'segredo.txt') }, undefined, [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: '../fora/segredo.txt' }, undefined, [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: `${root}/../fora/*.txt` }, undefined, [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: 'atalho/segredo.txt' }, undefined, [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: '/etc/passwd' }, undefined, [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: 'a.csv' }, undefined, [])).toMatch(/FILES_DIRS no \.env/);
    expect(await failure('readWriteFile', { operation: 'read', fileSelector: 'nada*.xyz' }, undefined, [root])).toMatch(/Nenhum arquivo encontrado/);
    const item: Item = { json: {}, binary: { data: text('x', 'x.txt') } };
    expect(await failure('readWriteFile', { operation: 'write', fileName: '../fora/novo.txt' }, [item], [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'write', fileName: 'atalho/novo.txt' }, [item], [root])).toMatch(/fora das pastas liberadas/);
    expect(await failure('readWriteFile', { operation: 'write', fileName: 'x.txt' }, [item], [])).toMatch(/FILES_DIRS/);
    expect(await failure('readWriteFile', { operation: 'write', fileName: 'repo/.git/hooks/pre-commit' }, [item], [root])).toMatch(/pasta \.git/);
    expect(await failure('readWriteFile', { operation: 'write', fileName: 'repo/.GIT/config' }, [item], [root])).toMatch(/pasta \.git/);
  });

  it('grava, cria a pasta, acrescenta e devolve o item com fileName', async () => {
    const item: Item = { json: { id: 3 }, binary: { data: text('linha 1\n', 'l.txt') } };
    const [out] = await output('readWriteFile', { operation: 'write', fileName: 'saida/log.txt' }, [item], [root]);
    expect(out!.json).toEqual({ id: 3, fileName: 'saida/log.txt' });
    expect(out!.binary!.data).toBeDefined();
    await output('readWriteFile', { operation: 'write', fileName: path.join(root, 'saida', 'log.txt'), append: true }, [item], [root]);
    expect(await readFile(path.join(root, 'saida', 'log.txt'), 'utf8')).toBe('linha 1\nlinha 1\n');
    await output('readWriteFile', { operation: 'write', fileName: 'saida/log.txt' }, [item], [root]);
    expect(await readFile(path.join(root, 'saida', 'log.txt'), 'utf8')).toBe('linha 1\n');
    expect(await failure('readWriteFile', { operation: 'write', fileName: 'y.txt', dataPropertyName: 'outro' }, [item], [root])).toMatch(/não tem o arquivo "outro"/);
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

  it('Compression', () => {
    expect(convert('compression', {}, 1.1).result).toEqual({ type: 'compression', parameters: { operation: 'decompress', binaryPropertyName: 'data', outputPrefix: 'file_' } });
    expect(convert('compression', { operation: 'compress', fileName: 'a.zip' }, 1.1).result).toEqual({
      type: 'compression',
      parameters: { operation: 'compress', binaryPropertyName: 'data', outputFormat: 'zip', fileName: 'a.zip', binaryPropertyOutput: 'data' },
    });
    const v1 = convert('compression', { operation: 'compress', outputFormat: 'gzip', outputPrefix: 'gz' }, 1);
    expect(v1.result!.parameters).toMatchObject({ outputFormat: 'gzip', binaryPropertyOutput: 'gz' });
    expect(v1.warnings.join()).toMatch(/V1 com gzip/);
  });

  it('Edit Image: operação simples com padrões do n8n, opções e V1 do texto', () => {
    expect(convert('editImage', { operation: 'resize', width: 100, options: { format: 'png', quality: 80, destinationKey: 'img' } }, 1.1).result).toEqual({
      type: 'editImage',
      parameters: { operation: 'resize', dataPropertyName: 'data', width: 100, height: 500, resizeOption: 'maximumArea', destinationKey: 'img', format: 'png', quality: 80 },
    });
    expect(convert('editImage', {}, 1.1).result!.parameters).toMatchObject({ operation: 'border', borderWidth: 10, borderHeight: 10, borderColor: '#000000' });
    const text = convert('editImage', { operation: 'text', text: 'oi', options: { font: '/usr/share/fonts/Arial.ttf' } }, 1);
    expect(text.result!.parameters).toMatchObject({ text: 'oi', horizontalAlignment: 'west', verticalAlignment: 'north', positionX: 50 });
    expect(text.warnings.join()).toMatch(/fonte/);
    expect(convert('editImage', { operation: 'information' }).result).toEqual({ type: 'editImage', parameters: { operation: 'information', dataPropertyName: 'data' } });
  });

  it('Edit Image: Multi Step', () => {
    const { result } = convert(
      'editImage',
      { operation: 'multiStep', operations: { operations: [{ operation: 'create', width: 10 }, { operation: 'draw', primitive: 'circle' }, { foo: 1 }] } },
      1.1,
    );
    expect(result!.parameters.operations).toEqual([
      { operation: 'create', backgroundColor: '#ffffff00', width: 10, height: 50 },
      { operation: 'draw', primitive: 'circle', color: '#ff000000', startPositionX: 50, startPositionY: 50, endPositionX: 250, endPositionY: 250, cornerRadius: 0 },
    ]);
  });

  it('Read/Write Files from Disk e nós antigos avisam da pasta liberada', () => {
    const read = convert('readWriteFile', { fileSelector: '/home/node/*.csv', options: { dataPropertyName: 'f', literalBrackets: false } }, 1.1);
    expect(read.result).toEqual({
      type: 'readWriteFile',
      parameters: { operation: 'read', fileSelector: '/home/node/*.csv', dataPropertyName: 'f', fileName: '', fileExtension: '', mimeType: '', literalBrackets: false },
    });
    expect(read.warnings.join()).toMatch(/pasta liberada em FILES_DIRS/);
    expect(convert('readWriteFile', { operation: 'write', fileName: '/data/a.txt', options: { append: true } }, 1).result).toEqual({
      type: 'readWriteFile',
      parameters: { operation: 'write', fileName: '/data/a.txt', dataPropertyName: 'data', append: true },
    });
    const old = convert('readBinaryFile', { filePath: '/data/x*.txt', dataPropertyName: 'arq' });
    expect(old.result).toEqual({ type: 'readWriteFile', parameters: { operation: 'read', fileSelector: '/data/x\\*.txt', dataPropertyName: 'arq', literalBrackets: true } });
    expect(old.warnings.join()).toMatch(/pasta liberada/);
    expect(convert('readBinaryFiles', { fileSelector: '*.jpg' }).result!.parameters).toMatchObject({ operation: 'read', fileSelector: '*.jpg', literalBrackets: false });
    expect(convert('writeBinaryFile', { fileName: 'a.bin', options: { append: true } }).result).toEqual({
      type: 'readWriteFile',
      parameters: { operation: 'write', fileName: 'a.bin', dataPropertyName: 'data', append: true },
    });
  });
});
