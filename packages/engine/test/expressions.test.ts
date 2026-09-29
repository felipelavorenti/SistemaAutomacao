import { afterAll, describe, expect, it } from 'vitest';
import { ExpressionSandbox } from '../src/expressions/sandbox.js';
import { parseTemplate, TemplateSyntaxError } from '../src/expressions/template.js';

describe('parseTemplate', () => {
  it('separa texto e código', () => {
    expect(parseTemplate('Bearer {{ $json.token }}!')).toEqual([
      { kind: 'text', value: 'Bearer ' },
      { kind: 'code', value: '$json.token' },
      { kind: 'text', value: '!' },
    ]);
  });

  it('respeita chaves e aspas dentro do código', () => {
    expect(parseTemplate("{{ {a: {b: '}}'}} }}")).toEqual([{ kind: 'code', value: "{a: {b: '}}'}}" }]);
  });

  it('acusa expressão sem fechamento', () => {
    expect(() => parseTemplate('{{ $json.a ')).toThrow(TemplateSyntaxError);
  });
});

describe('ExpressionScope', () => {
  const sandbox = new ExpressionSandbox({ timeoutMs: 200 });
  afterAll(() => sandbox.dispose());

  const scope = () =>
    sandbox.createScope({
      nodeOutputs: { Login: [{ json: { token: 'abc' } }] },
      execution: { id: 'exec-1', mode: 'manual' },
      vars: { baseUrl: 'https://erp' },
    });

  it('devolve o valor bruto quando o campo é uma única expressão', async () => {
    const s = await scope();
    expect(await s.resolve('={{ $json.itens }}', [{ json: { itens: [1, 2] } }], 0)).toEqual([1, 2]);
    s.release();
  });

  it('aceita .toJsonString() como no n8n', async () => {
    const s = await scope();
    const input = [{ json: { sku: 'A', precos: [1, 2] } }];
    expect(await s.resolve('={{ $json.toJsonString() }}', input, 0)).toBe('{"sku":"A","precos":[1,2]}');
    expect(await s.resolve('={{ $json.precos.toJsonString() }}', input, 0)).toBe('[1,2]');
    expect(await s.resolve('={{ $json.sku.toJsonString() }}', input, 0)).toBe('"A"');
    expect(await s.resolve('={{ Object.keys($json) }}', input, 0)).toEqual(['sku', 'precos']);
    s.release();
  });

  it('monta texto com várias expressões', async () => {
    const s = await scope();
    const value = await s.resolve("={{ $vars.baseUrl }}/pedidos/{{ $json.id }}?t={{ $node['Login'].json.token }}", [{ json: { id: 7 } }], 0);
    expect(value).toBe('https://erp/pedidos/7?t=abc');
    s.release();
  });

  it('usa o item atual pelo índice', async () => {
    const s = await scope();
    const input = [{ json: { n: 1 } }, { json: { n: 2 } }];
    expect(await s.resolve('={{ $json.n * 10 }}', input, 1)).toBe(20);
    expect(await s.resolve('={{ $input.all().length }}', input, 0)).toBe(2);
    s.release();
  });

  it('resolve expressões dentro de listas e objetos, e deixa valores fixos como estão', async () => {
    const s = await scope();
    const value = await s.resolve([{ name: 'Authorization', value: "=Bearer {{ $('Login').first().json.token }}" }, { name: 'x', value: 'fixo {{ não avalia }}' }], [], 0);
    expect(value).toEqual([
      { name: 'Authorization', value: 'Bearer abc' },
      { name: 'x', value: 'fixo {{ não avalia }}' },
    ]);
    s.release();
  });

  it('explica o erro quando o nó citado não rodou', async () => {
    const s = await scope();
    await expect(s.resolve("={{ $node['Outro'].json }}", [], 0)).rejects.toThrow(/Outro/);
    s.release();
  });

  it('interrompe laço infinito pelo tempo limite', async () => {
    const s = await scope();
    await expect(s.resolve('={{ (() => { while (true) {} })() }}', [], 0)).rejects.toThrow(/Erro na expressão/);
    s.release();
  });

  it('não dá acesso ao processo do servidor', async () => {
    const s = await scope();
    expect(await s.resolve('={{ typeof process }}', [], 0)).toBe('undefined');
    expect(await s.resolve('={{ typeof require }}', [], 0)).toBe('undefined');
    s.release();
  });
});
