import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import { converters } from '../src/n8n/convert-transform.js';
import type { Ctx } from '../src/n8n/import.js';
import { NodeRegistry } from '../src/registry.js';
import { limit, removeDuplicates, renameKeys, sort, summarize } from '../src/nodes/transform.js';
import { manualTrigger } from '../src/nodes/triggers.js';
import type { JsonObject } from '../src/types.js';

const registry = new NodeRegistry([manualTrigger, limit, sort, removeDuplicates, renameKeys, summarize]);

const run = async (type: string, parameters: JsonObject, items: JsonObject[]) => {
  const result = await executeWorkflow({
    workflow: {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'n', name: 'Nó', type, position: { x: 0, y: 0 }, parameters },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'n', toInput: 0 }],
    },
    executionId: 'x',
    mode: 'manual',
    triggerItems: items.map((json) => ({ json })),
    registry,
  });
  const nodeRun = result.runs.find((r) => r.nodeId === 'n');
  return { result, out: (nodeRun?.output[0] ?? []).map((i) => i.json), error: result.error?.message, meta: nodeRun?.meta };
};

const convert = (type: string, parameters: Record<string, unknown>, typeVersion = 1) => {
  const warnings: string[] = [];
  const ctx: Ctx = {
    node: { name: 'N', type: `n8n-nodes-base.${type}`, typeVersion, parameters },
    params: parameters,
    warn: (m) => warnings.push(m),
    options: {},
    timezone: 'America/Sao_Paulo',
  };
  return { converted: converters[type](ctx), warnings };
};

const nums = [1, 2, 3, 4, 5].map((n) => ({ n }));

describe('Limit', () => {
  it('mantém os primeiros ou os últimos', async () => {
    expect((await run('limit', { maxItems: 2, keep: 'firstItems' }, nums)).out).toEqual([{ n: 1 }, { n: 2 }]);
    expect((await run('limit', { maxItems: 2, keep: 'lastItems' }, nums)).out).toEqual([{ n: 4 }, { n: 5 }]);
    expect((await run('limit', { maxItems: 10 }, nums)).out).toHaveLength(5);
  });
  it('recusa máximo inválido', async () => {
    expect((await run('limit', { maxItems: 0 }, nums)).error).toMatch(/a partir de 1/);
  });
});

describe('Sort', () => {
  const people = [
    { nome: 'bruno', end: { cidade: 'Recife' }, idade: 30 },
    { nome: 'Ana', end: { cidade: 'Belém' }, idade: 30 },
    { nome: 'carla', end: { cidade: 'Aracaju' }, idade: 25 },
  ];
  it('ordena por vários campos, sem diferenciar maiúsculas, com caminho de ponto', async () => {
    const r = await run(
      'sort',
      {
        type: 'simple',
        sortFields: [
          { fieldName: 'idade', order: 'descending' },
          { fieldName: 'nome', order: 'ascending' },
        ],
      },
      people,
    );
    expect(r.out.map((p) => p.nome)).toEqual(['Ana', 'bruno', 'carla']);
    const byCity = await run('sort', { type: 'simple', sortFields: [{ fieldName: 'end.cidade', order: 'ascending' }] }, people);
    expect(byCity.out.map((p) => p.nome)).toEqual(['carla', 'Ana', 'bruno']);
  });
  it('números em ordem numérica', async () => {
    const r = await run('sort', { type: 'simple', sortFields: [{ fieldName: 'v', order: 'ascending' }] }, [{ v: 10 }, { v: 9 }, { v: 100 }]);
    expect(r.out).toEqual([{ v: 9 }, { v: 10 }, { v: 100 }]);
  });
  it('notação de ponto desligada usa a chave exata e dá erro com dica', async () => {
    const items = [{ 'a.b': 2 }, { 'a.b': 1 }];
    const ok = await run('sort', { type: 'simple', sortFields: [{ fieldName: 'a.b', order: 'ascending' }], disableDotNotation: true }, items);
    expect(ok.out).toEqual([{ 'a.b': 1 }, { 'a.b': 2 }]);
    const err = await run('sort', { type: 'simple', sortFields: [{ fieldName: 'x.y', order: 'ascending' }], disableDotNotation: true }, items);
    expect(err.error).toMatch(/"x.y" não existe/);
  });
  it('erro sem campos', async () => {
    expect((await run('sort', { type: 'simple', sortFields: [] }, nums)).error).toMatch(/Nenhum campo/);
  });
  it('aleatória mantém os mesmos itens', async () => {
    const r = await run('sort', { type: 'random' }, nums);
    expect(r.out.map((i) => i.n).sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('por código, rodando no isolate', async () => {
    const r = await run('sort', { type: 'code', code: 'fieldName = "n";\nreturn b.json[fieldName] - a.json[fieldName];' }, nums);
    expect(r.error).toBeUndefined();
    expect(r.out.map((i) => i.n)).toEqual([5, 4, 3, 2, 1]);
    expect((await run('sort', { type: 'code', code: 'a - b' }, nums)).error).toMatch(/return/);
  });
});

describe('Remove Duplicates', () => {
  it('todos os campos: mantém a primeira ocorrência, objetos com chaves em outra ordem são iguais', async () => {
    const r = await run('removeDuplicates', { compare: 'allFields' }, [
      { a: 1, o: { x: 1, y: 2 } },
      { a: 2, o: { x: 1, y: 2 } },
      { o: { y: 2, x: 1 }, a: 1 },
    ]);
    expect(r.out).toEqual([
      { a: 1, o: { x: 1, y: 2 } },
      { a: 2, o: { x: 1, y: 2 } },
    ]);
  });
  it('todos os campos exige os mesmos campos em todos os itens, como no n8n', async () => {
    const r = await run('removeDuplicates', { compare: 'allFields' }, [{ a: 1, b: 2 }, { a: 1 }]);
    expect(r.error).toMatch(/"b" falta/);
    const t = await run('removeDuplicates', { compare: 'allFields' }, [{ a: 1 }, { a: '1' }]);
    expect(t.error).toMatch(/mesmo tipo/);
  });
  it('campos escolhidos, com caminho e removendo os outros', async () => {
    const items = [
      { id: 1, cli: { email: 'a@x' }, nome: 'A' },
      { id: 2, cli: { email: 'b@x' }, nome: 'B' },
      { id: 3, cli: { email: 'a@x' }, nome: 'C' },
    ];
    const r = await run('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'cli.email' }, items);
    expect(r.out.map((i) => i.id)).toEqual([1, 2]);
    const p = await run('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'cli.email, nome', removeOtherFields: true }, [items[0], items[0]]);
    expect(p.out).toEqual([{ cli: { email: 'a@x' }, nome: 'A' }]);
  });
  it('todos menos alguns (inclusive objeto inteiro)', async () => {
    const items = [
      { id: 1, sku: 'X', meta: { t: 1 } },
      { id: 2, sku: 'X', meta: { t: 2 } },
      { id: 3, sku: 'Y', meta: { t: 3 } },
    ];
    const r = await run('removeDuplicates', { compare: 'allFieldsExcept', fieldsToExclude: 'id, meta' }, items);
    expect(r.out.map((i) => i.id)).toEqual([1, 3]);
  });
  it('nulos não quebram a validação', async () => {
    const r = await run('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'e' }, [{ e: null }, { e: 'a' }, { e: null }]);
    expect(r.out).toEqual([{ e: null }, { e: 'a' }]);
  });
});

describe('Rename Keys', () => {
  it('renomeia campos, inclusive aninhados, e ignora os que não existem', async () => {
    const r = await run(
      'renameKeys',
      {
        keys: [
          { currentKey: 'nome', newKey: 'name' },
          { currentKey: 'end.cep', newKey: 'endereco.cep' },
          { currentKey: 'naoExiste', newKey: 'x' },
        ],
      },
      [{ nome: 'A', end: { cep: '1', rua: 'R' } }],
    );
    expect(r.out).toEqual([{ name: 'A', end: { rua: 'R' }, endereco: { cep: '1' } }]);
  });
  it('por expressão regular, com grupos, maiúsculas e profundidade', async () => {
    const item = { Nome_cliente: 1, sub: { nome_x: 2, lista: [{ nome_y: 3 }] } };
    const all = await run('renameKeys', { keys: [], regexReplacements: [{ searchRegex: 'nome_(\\w+)', replaceRegex: '$1', caseInsensitive: true, depth: -1 }] }, [item]);
    expect(all.out).toEqual([{ cliente: 1, sub: { x: 2, lista: [{ y: 3 }] } }]);
    const top = await run('renameKeys', { keys: [], regexReplacements: [{ searchRegex: 'nome_(\\w+)', replaceRegex: '$1', caseInsensitive: false, depth: 0 }] }, [item]);
    expect(top.out).toEqual([item]);
    const lvl1 = await run('renameKeys', { keys: [], regexReplacements: [{ searchRegex: 'nome_(\\w+)', replaceRegex: '$1', depth: 1 }] }, [item]);
    expect(lvl1.out).toEqual([{ Nome_cliente: 1, sub: { x: 2, lista: [{ nome_y: 3 }] } }]);
  });
  it('regex inválida dá erro claro', async () => {
    expect((await run('renameKeys', { keys: [], regexReplacements: [{ searchRegex: '(' }] }, [{ a: 1 }])).error).toMatch(/inválida/);
  });
});

describe('Summarize', () => {
  const sales = [
    { uf: 'SP', cidade: 'Santos', valor: 10, id: 1, tag: 'a' },
    { uf: 'SP', cidade: 'Campinas', valor: 5, id: 2, tag: 'b' },
    { uf: 'RJ', cidade: 'Niterói', valor: 7, id: 3, tag: '' },
    { uf: 'SP', cidade: 'Santos', valor: '3', id: 4, tag: 'a' },
  ];
  const all = [
    { aggregation: 'sum', field: 'valor' },
    { aggregation: 'count', field: 'id' },
    { aggregation: 'average', field: 'valor' },
    { aggregation: 'min', field: 'valor' },
    { aggregation: 'max', field: 'id' },
    { aggregation: 'countUnique', field: 'tag' },
    { aggregation: 'append', field: 'tag' },
    { aggregation: 'concatenate', field: 'tag', separateBy: 'other', customSeparator: '|' },
  ];
  it('sem agrupar: um item com os nomes do n8n', async () => {
    const r = await run('summarize', { fieldsToSummarize: all }, sales);
    expect(r.out).toEqual([
      {
        sum_valor: 22,
        count_id: 4,
        average_valor: 22 / 3,
        min_valor: '3', // como no n8n: compara com < do JavaScript, então "3" < 5
        max_id: 4,
        unique_count_tag: 2,
        appended_tag: ['a', 'b', 'a'],
        concatenated_tag: 'a|b|a',
      },
    ]);
  });
  it('incluir vazios', async () => {
    const r = await run('summarize', { fieldsToSummarize: [{ aggregation: 'count', field: 'tag', includeEmpty: true }, { aggregation: 'append', field: 'tag', includeEmpty: true }] }, sales);
    expect(r.out).toEqual([{ count_tag: 4, appended_tag: ['a', 'b', '', 'a'] }]);
  });
  it('agrupa por vários campos, em itens separados ou num item só', async () => {
    const fieldsToSummarize = [{ aggregation: 'count', field: 'id' }];
    const r = await run('summarize', { fieldsToSummarize, fieldsToSplitBy: 'uf, cidade' }, sales);
    expect(r.out).toEqual([
      { count_id: 2, cidade: 'Santos', uf: 'SP' },
      { count_id: 1, cidade: 'Campinas', uf: 'SP' },
      { count_id: 1, cidade: 'Niterói', uf: 'RJ' },
    ]);
    const single = await run('summarize', { fieldsToSummarize, fieldsToSplitBy: 'uf, cidade', outputFormat: 'singleItem' }, sales);
    expect(single.out).toEqual([{ SP: { Santos: { count_id: 2 }, Campinas: { count_id: 1 } }, RJ: { Niterói: { count_id: 1 } } }]);
  });
  it('campo com ponto vira sublinhado e ignora itens sem valor de agrupamento', async () => {
    const items = [{ p: { v: 1 }, g: 'x' }, { p: { v: 2 }, g: '' }, { p: { v: 4 } }];
    const r = await run('summarize', { fieldsToSummarize: [{ aggregation: 'sum', field: 'p.v' }], fieldsToSplitBy: 'g', skipEmptySplitFields: true }, items);
    expect(r.out).toEqual([{ sum_p_v: 1, g: 'x' }]);
    const notSkipped = await run('summarize', { fieldsToSummarize: [{ aggregation: 'sum', field: 'p.v' }], fieldsToSplitBy: 'g' }, items);
    expect(notSkipped.out).toEqual([{ sum_p_v: 1, g: 'x' }, { sum_p_v: 2, g: '' }, { sum_p_v: 4 }]);
  });
  it('campo inexistente: continua com aviso ou dá erro', async () => {
    const ok = await run('summarize', { fieldsToSummarize: [{ aggregation: 'sum', field: 'nada' }] }, sales);
    expect(ok.out).toEqual([{ sum_nada: 0 }]);
    expect(ok.meta?.hints).toEqual(['O campo "nada" não existe em nenhum item']);
    const err = await run('summarize', { fieldsToSummarize: [{ aggregation: 'sum', field: 'nada' }], continueIfFieldNotFound: false }, sales);
    expect(err.error).toMatch(/não existe/);
    expect((await run('summarize', { fieldsToSummarize: [{ aggregation: 'sum', field: '' }] }, sales)).error).toMatch(/pelo menos um campo/);
  });
});

describe('conversores do n8n', () => {
  it('Limit', () => {
    expect(convert('limit', { maxItems: 3, keep: 'lastItems' }).converted).toEqual({ type: 'limit', parameters: { maxItems: 3, keep: 'lastItems' } });
    expect(convert('limit', {}).converted).toEqual({ type: 'limit', parameters: { maxItems: 1, keep: 'firstItems' } });
  });
  it('Sort simples, aleatório e código', () => {
    expect(
      convert('sort', { sortFieldsUi: { sortField: [{ fieldName: 'a.b', order: 'descending' }, { fieldName: 'c' }] }, options: { disableDotNotation: true } }).converted,
    ).toEqual({
      type: 'sort',
      parameters: {
        type: 'simple',
        sortFields: [
          { fieldName: 'a.b', order: 'descending' },
          { fieldName: 'c', order: 'ascending' },
        ],
        disableDotNotation: true,
      },
    });
    expect(convert('sort', { type: 'random' }).converted).toEqual({ type: 'sort', parameters: { type: 'random' } });
    const code = convert('sort', { type: 'code', code: 'return 0;' });
    expect(code.converted).toEqual({ type: 'sort', parameters: { type: 'code', code: 'return 0;' } });
    expect(code.warnings).toHaveLength(1);
  });
  it('Remove Duplicates v1 e v2', () => {
    expect(convert('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'email', options: { removeOtherFields: true } }, 1.1).converted).toEqual({
      type: 'removeDuplicates',
      parameters: { compare: 'selectedFields', fieldsToCompare: 'email', disableDotNotation: false, removeOtherFields: true },
    });
    expect(convert('removeDuplicates', { operation: 'removeDuplicateInputItems', compare: 'allFieldsExcept', fieldsToExclude: 'id' }, 2).converted).toEqual({
      type: 'removeDuplicates',
      parameters: { compare: 'allFieldsExcept', fieldsToExclude: 'id', disableDotNotation: false, removeOtherFields: false },
    });
    expect(convert('removeDuplicates', {}, 2).converted?.parameters.compare).toBe('allFields');
    for (const operation of ['removeItemsSeenInPreviousExecutions', 'clearDeduplicationHistory']) {
      const c = convert('removeDuplicates', { operation }, 2);
      expect(c.converted).toBeNull();
      expect(c.warnings[0]).toMatch(/entre execuções/);
    }
  });
  it('Rename Keys com regex', () => {
    expect(
      convert('renameKeys', {
        keys: { key: [{ currentKey: 'a', newKey: 'b' }] },
        additionalOptions: { regexReplacement: { replacements: [{ searchRegex: 'x(.)', replaceRegex: 'y$1', options: { caseInsensitive: true, depth: 0 } }, { searchRegex: 'z', replaceRegex: 'w' }] } },
      }).converted,
    ).toEqual({
      type: 'renameKeys',
      parameters: {
        keys: [{ currentKey: 'a', newKey: 'b' }],
        regexReplacements: [
          { searchRegex: 'x(.)', replaceRegex: 'y$1', caseInsensitive: true, depth: 0 },
          { searchRegex: 'z', replaceRegex: 'w', caseInsensitive: false, depth: -1 },
        ],
      },
    });
    expect(convert('renameKeys', {}).converted?.parameters).toEqual({ keys: [], regexReplacements: [] });
  });
  it('Summarize v1 e v1.1', () => {
    const params = {
      fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'v' }, { aggregation: 'concatenate', field: 't', separateBy: 'other', customSeparator: ';', includeEmpty: true }] },
      fieldsToSplitBy: 'uf',
      options: { outputFormat: 'singleItem', skipEmptySplitFields: true },
    };
    const v11 = convert('summarize', params, 1.1).converted!;
    expect(v11).toEqual({
      type: 'summarize',
      parameters: {
        fieldsToSummarize: [
          { aggregation: 'sum', field: 'v', includeEmpty: false, separateBy: ',', customSeparator: '' },
          { aggregation: 'concatenate', field: 't', includeEmpty: true, separateBy: 'other', customSeparator: ';' },
        ],
        fieldsToSplitBy: 'uf',
        outputFormat: 'singleItem',
        skipEmptySplitFields: true,
        disableDotNotation: false,
        continueIfFieldNotFound: true,
      },
    });
    expect(convert('summarize', params, 1).converted?.parameters.continueIfFieldNotFound).toBe(false);
  });
  it('Item Lists antigo', () => {
    expect(convert('itemLists', { operation: 'limit', maxItems: 2 }).converted?.type).toBe('limit');
    expect(convert('itemLists', { operation: 'sort', type: 'random' }).converted).toEqual({ type: 'sort', parameters: { type: 'random' } });
    expect(
      convert('itemLists', { operation: 'removeDuplicates', compare: 'selectedFields', fieldsToCompare: { fields: [{ fieldName: 'a' }, { fieldName: 'b.c' }] } }).converted?.parameters.fieldsToCompare,
    ).toBe('a, b.c');
    expect(convert('itemLists', { operation: 'removeDuplicates', compare: 'allFieldsExcept', fieldsToExclude: 'x, y' }, 3).converted?.parameters.fieldsToExclude).toBe('x, y');
    const s = convert('itemLists', { operation: 'summarize', fieldsToSummarize: { values: [{ aggregation: 'count', field: 'id' }] } }, 3).converted!;
    expect(s.type).toBe('summarize');
    expect(s.parameters.continueIfFieldNotFound).toBe(false);
    expect(convert('itemLists', { operation: 'splitOutItems', fieldToSplitOut: 'linhas' }).converted?.type).toBe('splitOut');
    expect(convert('itemLists', { operation: 'aggregateItems', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'sku' }] } }).converted?.type).toBe('aggregate');
    expect(convert('itemLists', { operation: 'concatenateItems', aggregate: 'aggregateAllItemData' }).converted?.type).toBe('aggregate');
    expect(convert('itemLists', { operation: 'nada' }).converted).toBeNull();
  });
});
