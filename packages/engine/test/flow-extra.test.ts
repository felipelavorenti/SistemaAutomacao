import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import { converters } from '../src/n8n/convert-flow-extra.js';
import type { Ctx, N8nNode } from '../src/n8n/import.js';
import { resolveOutputs, type NodeExecuteContext, type NodeType } from '../src/node-types.js';
import { compareDatasets, datasetEquals, executionData, filter, noOp, switchNode, wait, waitFor } from '../src/nodes/flow-extra.js';
import { manualTrigger } from '../src/nodes/triggers.js';
import { NodeRegistry } from '../src/registry.js';
import type { Item, JsonObject, JsonValue, WorkflowDefinition } from '../src/types.js';

const registry = new NodeRegistry([manualTrigger, filter, switchNode, compareDatasets, wait, noOp, executionData]);

/** Roda Início → nó, com os itens informados. */
async function run(type: string, parameters: JsonObject, items: JsonObject[], options: { signal?: AbortSignal; canWait?: boolean } = {}) {
  const workflow: WorkflowDefinition = {
    nodes: [
      { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'n', name: 'Nó', type, position: { x: 0, y: 0 }, parameters },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'n', toInput: 0 }],
  };
  const result = await executeWorkflow({ workflow, executionId: 'x', mode: 'manual', triggerItems: items.map((json) => ({ json })), registry, signal: options.signal, canWait: options.canWait });
  const nodeRun = result.runs.find((r) => r.nodeId === 'n');
  return { result, nodeRun, output: (nodeRun?.output ?? []).map((items) => items.map((i) => i.json)) };
}

/** Contexto mínimo para chamar o nó direto (sem expressões). */
function fakeCtx(type: NodeType, parameters: JsonObject, inputs: Item[][], signal = new AbortController().signal): NodeExecuteContext {
  const defaults = Object.fromEntries(type.description.properties.map((p) => [p.name, p.default]));
  const fail = () => {
    throw new Error('não usado');
  };
  return {
    node: { id: 'n', name: 'Nó', type: type.description.type, position: { x: 0, y: 0 }, parameters },
    inputs,
    getParam: async (name) => (parameters[name] !== undefined ? parameters[name]! : (defaults[name] ?? null)),
    getConnection: fail,
    getFile: fail,
    getApiEndpoint: fail,
    database: fail,
    runCode: fail,
    runPython: fail,
    executeWorkflow: fail,
    state: {},
    meta: {},
    signal,
    filesDirs: [],
    mode: 'manual',
    resumeUrl: 'http://localhost:3000/webhook-waiting/x',
    resumeFormUrl: 'http://localhost:3000/form-waiting/x',
    publicUrl: 'http://localhost:3000',
    // Como num subfluxo: não pode pausar, então espera no próprio worker.
    putToWait: () => false,
    sendResponse: () => undefined,
  };
}

const items = (...list: JsonObject[]): Item[] => list.map((json) => ({ json }));

describe('Filter', () => {
  it('deixa passar só os itens que atendem às condições (E)', async () => {
    const { output, result } = await run(
      'filter',
      {
        combinator: 'and',
        conditions: [
          { left: '={{ $json.uf }}', operator: 'equals', right: 'SP' },
          { left: '={{ $json.valor }}', operator: 'gt', right: '10' },
        ],
      },
      [
        { uf: 'SP', valor: 20 },
        { uf: 'SP', valor: 5 },
        { uf: 'RJ', valor: 50 },
      ],
    );
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(output).toEqual([[{ uf: 'SP', valor: 20 }]]);
  });

  it('combina com OU e ignora maiúsculas quando pedido', async () => {
    const params = {
      combinator: 'or',
      conditions: [
        { left: '={{ $json.uf }}', operator: 'equals', right: 'sp' },
        { left: '={{ $json.nome }}', operator: 'regex', right: '^ana' },
      ],
    };
    const data = [{ uf: 'SP', nome: 'x' }, { uf: 'RJ', nome: 'ANA' }, { uf: 'MG', nome: 'Bia' }];
    expect((await run('filter', params, data)).output).toEqual([[]]);
    expect((await run('filter', { ...params, ignoreCase: true }, data)).output).toEqual([[data[0], data[1]]]);
  });
});

describe('Switch', () => {
  const rules = [
    { left: '={{ $json.prioridade }}', operator: 'equals', right: 'alta', outputKey: 'urgente' },
    { left: '={{ $json.valor }}', operator: 'gt', right: '100', outputKey: '' },
  ];

  it('tem uma saída por regra, mais "Outros" com a saída extra', () => {
    expect(resolveOutputs(switchNode.description, { rules })).toEqual({ count: 2, names: ['urgente', '1'] });
    expect(resolveOutputs(switchNode.description, { rules, fallbackOutput: 'extra' })).toEqual({ count: 3, names: ['urgente', '1', 'Outros'] });
    expect(resolveOutputs(switchNode.description, { mode: 'expression', numberOutputs: 3 }).count).toBe(3);
    expect(resolveOutputs(switchNode.description, {}).count).toBe(1);
  });

  const data = [
    { id: 1, prioridade: 'alta', valor: 500 },
    { id: 2, prioridade: 'baixa', valor: 500 },
    { id: 3, prioridade: 'baixa', valor: 5 },
  ];
  const ids = (out: JsonObject[][]) => out.map((list) => list.map((j) => j.id));

  it('manda para a primeira regra que bate e descarta o resto', async () => {
    const { output, result } = await run('switch', { mode: 'rules', rules }, data);
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(ids(output)).toEqual([[1], [2]]);
  });

  it('com "todas as regras", o item vai para cada regra que bate', async () => {
    expect(ids((await run('switch', { rules, allMatchingOutputs: true }, data)).output)).toEqual([[1], [1, 2]]);
  });

  it('saída extra e saída de uma regra para os itens sem regra', async () => {
    expect(ids((await run('switch', { rules, fallbackOutput: 'extra' }, data)).output)).toEqual([[1], [2], [3]]);
    expect(ids((await run('switch', { rules, fallbackOutput: 'output', fallbackIndex: 0 }, data)).output)).toEqual([[1, 3], [2]]);
    const bad = await run('switch', { rules, fallbackOutput: 'output', fallbackIndex: 5 }, data);
    expect(bad.result.status).toBe('error');
    expect(bad.result.error?.message).toMatch(/saída 5 .*não existe/);
  });

  it('ignora maiúsculas quando pedido', async () => {
    const r = [{ left: '={{ $json.uf }}', operator: 'equals', right: 'sp', outputKey: '' }];
    expect((await run('switch', { rules: r }, [{ uf: 'SP' }])).output).toEqual([[]]);
    expect((await run('switch', { rules: r, ignoreCase: true }, [{ uf: 'SP' }])).output).toEqual([[{ uf: 'SP' }]]);
  });

  it('modo expressão: cada item vai para a saída calculada', async () => {
    const { output, result } = await run('switch', { mode: 'expression', numberOutputs: 3, output: '={{ $json.n }}' }, [{ n: 2 }, { n: 0 }, { n: 2 }]);
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(output).toEqual([[{ n: 0 }], [], [{ n: 2 }, { n: 2 }]]);
  });

  it('modo expressão: saída fora da faixa é erro claro', async () => {
    const r = await run('switch', { mode: 'expression', numberOutputs: 2, output: '={{ $json.n }}' }, [{ n: 2 }]);
    expect(r.result.status).toBe('error');
    expect(r.result.error?.message).toBe('A saída 2 do item 0 não existe; use um número de 0 a 1');
    const nan = await run('switch', { mode: 'expression', numberOutputs: 2, output: '={{ $json.n }}' }, [{ n: 'x' }]);
    expect(nan.result.error?.message).toMatch(/precisa ser um número inteiro/);
  });
});

describe('Compare Datasets', () => {
  const a = items({ id: 1, nome: 'Ana', cidade: 'SP' }, { id: 2, nome: 'Bia', cidade: 'RJ' }, { id: 3, nome: 'Caio', cidade: 'BH' }, {});
  const b = items({ codigo: 2, nome: 'Bia', cidade: 'RJ' }, { codigo: 3, nome: 'Caio', cidade: 'POA' }, { codigo: 4, nome: 'Duda' });
  const compare = async (parameters: JsonObject, inA = a, inB = b) =>
    (await compareDatasets.execute(fakeCtx(compareDatasets, { mergeByFields: [{ field1: 'id', field2: 'codigo' }], ...parameters }, [inA, inB]))).map((list) =>
      list.map((i) => i.json),
    );

  it('separa nas 4 saídas: só em A, iguais, diferentes e só em B', async () => {
    const [onlyA, same, different, onlyB] = await compare({ skipFields: 'id, codigo' });
    expect(onlyA).toEqual([{ id: 1, nome: 'Ana', cidade: 'SP' }]);
    expect(same).toEqual([{ id: 2, nome: 'Bia', cidade: 'RJ' }]);
    expect(different).toEqual([
      {
        keys: { id: 3 },
        same: { nome: 'Caio' },
        different: { cidade: { inputA: 'BH', inputB: 'POA' } },
        skipped: { id: { inputA: 3, inputB: null }, codigo: { inputA: null, inputB: 3 } },
      },
    ]);
    expect(onlyB).toEqual([{ codigo: 4, nome: 'Duda' }]);
  });

  it('sem ignorar os campos de casamento, nomes diferentes deixam o par diferente', async () => {
    const [, same, different] = await compare({});
    expect(same).toEqual([]);
    expect(different).toHaveLength(2);
  });

  it('resolve: versão de A, de B e mistura', async () => {
    const skip = { skipFields: 'id,codigo' };
    expect((await compare({ ...skip, resolve: 'preferInput1' }))[2]).toEqual([{ id: 3, nome: 'Caio', cidade: 'BH' }]);
    expect((await compare({ ...skip, resolve: 'preferInput2' }))[2]).toEqual([{ codigo: 3, nome: 'Caio', cidade: 'POA' }]);
    expect((await compare({ ...skip, resolve: 'mix', preferWhenMix: 'input1', exceptWhenMix: 'cidade' }))[2]).toEqual([{ id: 3, nome: 'Caio', cidade: 'POA' }]);
  });

  it('comparação tolerante aceita 2 e "2"', async () => {
    const inA = items({ id: 2, qtd: 5 });
    const inB = items({ id: '2', qtd: '5' });
    const params = { mergeByFields: [{ field1: 'id', field2: 'id' }] };
    expect((await compare(params, inA, inB)).map((l) => l.length)).toEqual([1, 0, 0, 1]);
    expect((await compare({ ...params, fuzzyCompare: true }, inA, inB)).map((l) => l.length)).toEqual([0, 1, 0, 0]);
    expect(datasetEquals(true, null, '')).toBe(true);
    expect(datasetEquals(true, true, 'TRUE')).toBe(true);
    expect(datasetEquals(true, { x: 1 }, '{"x":1}')).toBe(true);
    expect(datasetEquals(false, 1, '1')).toBe(false);
  });

  it('vários pares: só o primeiro ou todos', async () => {
    const inA = items({ id: 1, v: 'x' });
    const inB = items({ id: 1, v: 'x' }, { id: 1, v: 'y' });
    const params = { mergeByFields: [{ field1: 'id', field2: 'id' }], resolve: 'preferInput2' };
    expect(await compare(params, inA, inB)).toEqual([[], [{ id: 1, v: 'x' }], [], [{ id: 1, v: 'y' }]]);
    expect(await compare({ ...params, multipleMatches: 'all' }, inA, inB)).toEqual([[], [{ id: 1, v: 'x' }], [{ id: 1, v: 'y' }], []]);
  });

  it('ignora campo aninhado e casa por caminho com ponto', async () => {
    const inA = items({ cli: { id: 7 }, end: { rua: 'A', cep: '1' } });
    const inB = items({ cli: { id: 7 }, end: { rua: 'B', cep: '2' } });
    const [, , different] = await compare({ mergeByFields: [{ field1: 'cli.id', field2: 'cli.id' }], skipFields: 'end.cep' }, inA, inB);
    expect(different).toEqual([
      {
        keys: { 'cli.id': 7 },
        same: { cli: { id: 7 } },
        different: { end: { inputA: { rua: 'A' }, inputB: { rua: 'B' } } },
        skipped: { end: { inputA: { cep: '1' }, inputB: { cep: '2' } } },
      },
    ]);
  });

  it('exige os campos para casar', async () => {
    await expect(compare({ mergeByFields: [{ field1: '', field2: '' }] })).rejects.toThrow(/pelo menos um par/);
    await expect(compare({ mergeByFields: [{ field1: 'id', field2: '' }] })).rejects.toThrow(/par 1/);
  });
});

describe('Wait', () => {
  it('espera o intervalo e repassa os itens', async () => {
    const started = Date.now();
    const { output, nodeRun } = await run('wait', { resume: 'timeInterval', amount: 0.2, unit: 'seconds' }, [{ a: 1 }]);
    expect(nodeRun?.error).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(output).toEqual([[{ a: 1 }]]);
    expect(nodeRun?.status).toBe('success');
  });

  it('tem tempo limite padrão de uns 24 dias e recusa esperas maiores', async () => {
    expect(wait.description.defaultTimeoutMs).toBe(2_147_483_647);
    await expect(wait.execute(fakeCtx(wait, { amount: 30, unit: 'days' }, [[]]))).rejects.toThrow(/espera máxima dentro de um subfluxo é de 24 dias/);
  });

  it('data passada não espera; data com fuso é aceita', async () => {
    const started = Date.now();
    const r = await run('wait', { resume: 'specificTime', dateTime: '2020-01-01T00:00:00', timezone: 'America/Sao_Paulo' }, [{ a: 1 }]);
    expect(r.output).toEqual([[{ a: 1 }]]);
    expect(r.nodeRun?.meta?.waitUntil).toBe('2020-01-01T03:00:00.000Z');
    const iso = await run('wait', { resume: 'specificTime', dateTime: '2020-01-01T00:00:00Z' }, [{ a: 1 }]);
    expect(iso.nodeRun?.meta?.waitUntil).toBe('2020-01-01T00:00:00.000Z');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('espera até a data e hora no fuso do nó', async () => {
    const ctx = fakeCtx(wait, { resume: 'specificTime', dateTime: new Date(Date.now() + 300).toISOString(), timezone: 'UTC' }, [items({ a: 1 })]);
    const started = Date.now();
    await wait.execute(ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('espera longa pausa a execução e a retomada segue do Wait com os mesmos itens', async () => {
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'w', name: 'Espera', type: 'wait', position: { x: 0, y: 0 }, parameters: { resume: 'timeInterval', amount: 2, unit: 'hours' } },
        { id: 'n', name: 'Depois', type: 'noOp', position: { x: 0, y: 0 }, parameters: {} },
      ],
      connections: [
        { from: 't', fromOutput: 0, to: 'w', toInput: 0 },
        { from: 'w', fromOutput: 0, to: 'n', toInput: 0 },
      ],
    };
    const started = Date.now();
    const paused = await executeWorkflow({ workflow, executionId: 'x', mode: 'manual', triggerItems: [{ json: { a: 1 } }], registry });
    expect(paused.status).toBe('waiting');
    expect(paused.wait).toMatchObject({ kind: 'time', nodeName: 'Espera' });
    expect(Date.parse(paused.wait!.until!) - started).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
    expect(paused.runs.map((r) => r.nodeName)).toEqual(['Início']);
    // O estado vai para o banco como JSON.
    const state = JSON.parse(JSON.stringify(paused.resumeState));
    const resumed = await executeWorkflow({ workflow, executionId: 'x', mode: 'manual', registry, resume: { state } });
    expect(resumed.status).toBe('success');
    expect(resumed.runs.map((r) => r.nodeName)).toEqual(['Início', 'Espera', 'Depois']);
    expect(resumed.lastOutput).toEqual([{ json: { a: 1 } }]);
    expect(resumed.startedAt).toBe(paused.startedAt);
  });

  it('pausa esperando webhook e segue com os dados que chegaram', async () => {
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'w', name: 'Espera', type: 'wait', position: { x: 0, y: 0 }, parameters: { resume: 'webhook', httpMethod: 'POST' } },
        { id: 'n', name: 'Depois', type: 'noOp', position: { x: 0, y: 0 }, parameters: {} },
      ],
      connections: [
        { from: 't', fromOutput: 0, to: 'w', toInput: 0 },
        { from: 'w', fromOutput: 0, to: 'n', toInput: 0 },
      ],
    };
    const paused = await executeWorkflow({ workflow, executionId: 'abc', mode: 'manual', triggerItems: [{ json: { a: 1 } }], registry, publicUrl: 'https://info8n.local/' });
    expect(paused.status).toBe('waiting');
    expect(paused.wait).toMatchObject({ kind: 'webhook', config: { httpMethod: 'POST' } });
    expect(paused.wait!.until).toBeUndefined();
    const resumed = await executeWorkflow({
      workflow,
      executionId: 'abc',
      mode: 'manual',
      registry,
      resume: { state: paused.resumeState!, data: { kind: 'webhook', items: [{ json: { body: { ok: true } } }] } },
    });
    expect(resumed.lastOutput).toEqual([{ json: { body: { ok: true } } }]);
    // Sem webhook (o limite de tempo acabou), seguem os itens de antes.
    const timeout = await executeWorkflow({ workflow, executionId: 'abc', mode: 'manual', registry, resume: { state: paused.resumeState! } });
    expect(timeout.lastOutput).toEqual([{ json: { a: 1 } }]);
  });

  it('$execution.resumeUrl usa o endereço público', async () => {
    const { output } = await run('noOp', {}, [{}]);
    expect(output).toEqual([[{}]]);
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'n', name: 'Nó', type: 'executionData', position: { x: 0, y: 0 }, parameters: { dataToSave: [{ key: 'url', value: '={{ $execution.resumeUrl }}' }] } },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'n', toInput: 0 }],
    };
    const result = await executeWorkflow({ workflow, executionId: 'e1', mode: 'manual', registry, publicUrl: 'https://info8n.local/' });
    expect(result.runs[1]!.meta).toEqual({ executionData: { url: 'https://info8n.local/webhook-waiting/e1' } });
  });

  it('cancelar a execução interrompe a espera', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const { result } = await run('wait', { resume: 'timeInterval', amount: 1, unit: 'hours' }, [{ a: 1 }], { signal: controller.signal, canWait: false });
    expect(result.status).toBe('canceled');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('o abort limpa o timer e rejeita', async () => {
    const controller = new AbortController();
    const p = waitFor(60_000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(waitFor(10, aborted.signal)).rejects.toThrow();
  });

  it('erros claros de parâmetro', async () => {
    await expect(wait.execute(fakeCtx(wait, { amount: -1 }, [[]]))).rejects.toThrow(/maior ou igual a 0/);
    await expect(wait.execute(fakeCtx(wait, { resume: 'specificTime', dateTime: 'amanhã' }, [[]]))).rejects.toThrow(/Data e hora inválidas/);
  });
});

describe('No Operation e Execution Data', () => {
  it('No Operation repassa os itens', async () => {
    expect((await run('noOp', {}, [{ a: 1 }, { a: 2 }])).output).toEqual([[{ a: 1 }, { a: 2 }]]);
  });

  it('Execution Data grava os pares (o último item vence) e repassa os itens', async () => {
    const { output, nodeRun } = await run(
      'executionData',
      { dataToSave: [{ key: 'pedido', value: '={{ $json.n }}' }, { key: 'texto', value: 'x'.repeat(600) }, { key: '', value: 'ignorado' }] },
      [{ n: 1 }, { n: 2 }],
    );
    expect(output).toEqual([[{ n: 1 }, { n: 2 }]]);
    expect(nodeRun?.meta?.executionData).toEqual({ pedido: '2', texto: 'x'.repeat(512) });
  });

  it('Execution Data corta a chave em 50, limita a 10 chaves e valida a chave', async () => {
    const longKey = 'k'.repeat(60);
    const ctx = fakeCtx(executionData, { dataToSave: [{ key: longKey, value: 1 }] }, [items({})]);
    await executionData.execute(ctx);
    expect(ctx.meta.executionData).toEqual({ ['k'.repeat(50)]: '1' });

    const eleven = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    await expect(executionData.execute(fakeCtx(executionData, { dataToSave: eleven }, [items({})]))).rejects.toThrow(/máximo 10/);
    await expect(executionData.execute(fakeCtx(executionData, { dataToSave: [{ key: 'código', value: 'v' }] }, [items({})]))).rejects.toThrow(/letras sem acento/);
  });
});

// ---------- Conversores ----------

function convert(type: string, parameters: Record<string, unknown>, typeVersion = 1) {
  const warnings: string[] = [];
  const node: N8nNode = { name: 'N', type: `n8n-nodes-base.${type}`, typeVersion, parameters };
  const ctx: Ctx = { node, params: parameters, warn: (m) => warnings.push(m), options: {}, timezone: 'America/Sao_Paulo' };
  return { converted: converters[type]!(ctx), warnings };
}

const v2Condition = (left: JsonValue, operation: string, right: JsonValue) => ({ leftValue: left, rightValue: right, operator: { type: 'string', operation } });

describe('conversores do n8n', () => {
  it('Filter v2 vira filter com as condições do If e ignorar maiúsculas', () => {
    const { converted, warnings } = convert(
      'filter',
      {
        conditions: {
          options: { caseSensitive: true },
          combinator: 'or',
          conditions: [v2Condition('={{ $json.uf }}', 'equals', 'SP'), v2Condition('={{ $json.n }}', 'gt', 3)],
        },
        options: { ignoreCase: true },
      },
      2.2,
    );
    expect(warnings).toEqual([]);
    expect(converted).toMatchObject({
      type: 'filter',
      parameters: {
        combinator: 'or',
        ignoreCase: true,
        conditions: [
          { left: '={{ $json.uf }}', operator: 'equals', right: 'SP' },
          { left: '={{ $json.n }}', operator: 'gt', right: 3 },
        ],
      },
    });
    expect(converted!.outputMap!(0)).toBe(0);
    expect(converted!.outputMap!(1)).toBeNull();
  });

  it('Filter v1 (condições por tipo)', () => {
    const { converted } = convert('filter', { combineConditions: 'OR', conditions: { string: [{ value1: '={{ $json.a }}', operation: 'contains', value2: 'x' }] } });
    expect(converted?.parameters).toEqual({ combinator: 'or', ignoreCase: false, conditions: [{ left: '={{ $json.a }}', operator: 'contains', right: 'x' }] });
  });

  it('Switch v3 com regras, nomes, saída extra e todas as regras', () => {
    const { converted, warnings } = convert(
      'switch',
      {
        rules: {
          values: [
            { conditions: { options: { caseSensitive: false }, combinator: 'and', conditions: [v2Condition('={{ $json.p }}', 'equals', 'alta')] }, renameOutput: true, outputKey: 'urgente' },
            {
              conditions: { combinator: 'or', conditions: [v2Condition('={{ $json.v }}', 'gt', 100), v2Condition('={{ $json.v }}', 'lt', 0)] },
            },
          ],
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'Resto', allMatchingOutputs: true },
      },
      3.2,
    );
    expect(converted?.parameters).toEqual({
      mode: 'rules',
      rules: [
        { left: '={{ $json.p }}', operator: 'equals', right: 'alta', outputKey: 'urgente' },
        { left: '={{ $json.v }}', operator: 'gt', right: 100, outputKey: '' },
      ],
      fallbackOutput: 'extra',
      allMatchingOutputs: true,
      ignoreCase: true,
    });
    expect(warnings).toEqual([expect.stringMatching(/regra 2 tinha 2 condições combinadas com OU/), expect.stringMatching(/"Resto".*"Outros"/)]);
    expect(resolveOutputs(switchNode.description, converted!.parameters).names).toEqual(['urgente', '1', 'Outros']);
  });

  it('Switch v3 com saída de uma regra para os itens sem regra e modo expressão', () => {
    const rules = { values: [{ conditions: { conditions: [v2Condition('a', 'equals', 'a')] } }] };
    expect(convert('switch', { rules, options: { fallbackOutput: 0 } }, 3).converted?.parameters).toMatchObject({ fallbackOutput: 'output', fallbackIndex: 0 });
    expect(convert('switch', { mode: 'expression', numberOutputs: 3, output: '={{ $json.n }}' }, 3.2).converted?.parameters).toEqual({
      mode: 'expression',
      numberOutputs: 3,
      output: '={{ $json.n }}',
    });
  });

  it('Switch v2: regras com value1/value2 e saída de reserva', () => {
    const { converted, warnings } = convert(
      'switch',
      {
        dataType: 'string',
        value1: '={{ $json.uf }}',
        rules: { rules: [{ operation: 'equal', value2: 'SP', outputKey: 'sp' }, { operation: 'notStartsWith', value2: 'R' }, { operation: 'notRegex', value2: 'x' }] },
        fallbackOutput: 1,
      },
      2,
    );
    expect(converted?.parameters).toEqual({
      mode: 'rules',
      rules: [
        { left: '={{ $json.uf }}', operator: 'equals', right: 'SP', outputKey: 'sp' },
        { left: '={{ $json.uf }}', operator: 'regex', right: '^(?!R)', outputKey: '' },
        { left: '={{ $json.uf }}', operator: 'equals', right: 'x', outputKey: '' },
      ],
      fallbackOutput: 'output',
      fallbackIndex: 1,
      allMatchingOutputs: false,
      ignoreCase: false,
    });
    expect(warnings).toEqual([expect.stringMatching(/"notRegex" não existe/)]);
    expect(converted?.outputMap).toBeUndefined();
    expect(convert('switch', { mode: 'expression', outputsAmount: 6, output: '={{ 1 }}' }, 2).converted?.parameters.numberOutputs).toBe(6);
  });

  it('Switch v1: regras com saída própria viram uma saída por regra, com o mapa das ligações', () => {
    const { converted, warnings } = convert('switch', {
      dataType: 'number',
      value1: '={{ $json.n }}',
      rules: { rules: [{ operation: 'smaller', value2: 10, output: 2 }, { operation: 'larger', value2: 100, output: 0 }, { operation: 'equal', value2: 50, output: 0 }] },
      fallbackOutput: 3,
    });
    expect(converted?.parameters).toMatchObject({
      rules: [
        { operator: 'lt', right: 10 },
        { operator: 'gt', right: 100 },
        { operator: 'equals', right: 50 },
      ],
      fallbackOutput: 'extra',
    });
    expect([0, 1, 2, 3].map((i) => converted!.outputMap!(i))).toEqual([1, null, 0, 3]);
    expect(warnings).toEqual([expect.stringMatching(/mesma saída \(0\)/)]);
    expect(convert('switch', { mode: 'expression', output: '={{ 2 }}' }).converted?.parameters.numberOutputs).toBe(4);
  });

  it('Compare Datasets', () => {
    const { converted, warnings } = convert(
      'compareDatasets',
      {
        mergeByFields: { values: [{ field1: 'id', field2: 'codigo' }] },
        resolve: 'mix',
        preferWhenMix: 'input2',
        exceptWhenMix: 'preco',
        fuzzyCompare: true,
        options: { skipFields: 'atualizado', multipleMatches: 'all', disableDotNotation: true },
      },
      2.3,
    );
    expect(converted).toEqual({
      type: 'compareDatasets',
      parameters: {
        mergeByFields: [{ field1: 'id', field2: 'codigo' }],
        resolve: 'mix',
        preferWhenMix: 'input2',
        exceptWhenMix: 'preco',
        fuzzyCompare: true,
        skipFields: 'atualizado',
        multipleMatches: 'all',
      },
    });
    expect(warnings).toEqual([expect.stringMatching(/Disable Dot Notation/)]);
    // v1: padrão "versão de B" e comparação tolerante nas opções.
    const v1 = convert('compareDatasets', { mergeByFields: { values: [{ field1: 'a', field2: 'b' }] }, options: { fuzzyCompare: true } }, 1);
    expect(v1.converted?.parameters).toMatchObject({ resolve: 'preferInput2', fuzzyCompare: true, multipleMatches: 'first' });
    expect(convert('compareDatasets', {}, 2.3).converted?.parameters).toMatchObject({ resolve: 'includeBoth', mergeByFields: [{ field1: '', field2: '' }] });
  });

  it('Wait: intervalo, data com e sem fuso, webhook e formulário', () => {
    expect(convert('wait', { amount: 30, unit: 'minutes' }, 1.1).converted).toEqual({ type: 'wait', parameters: { resume: 'timeInterval', amount: 30, unit: 'minutes' } });
    expect(convert('wait', {}, 1.1).converted?.parameters).toEqual({ resume: 'timeInterval', amount: 5, unit: 'seconds' });
    expect(convert('wait', {}, 1).converted?.parameters).toEqual({ resume: 'timeInterval', amount: 1, unit: 'hours' });
    expect(convert('wait', { resume: 'specificTime', dateTime: '2026-11-01T12:00:00.000Z' }, 1.1).converted?.parameters).toEqual({
      resume: 'specificTime',
      dateTime: '2026-11-01T09:00:00',
      timezone: 'America/Sao_Paulo',
    });
    expect(convert('wait', { resume: 'specificTime', dateTime: '2026-11-01 08:30:00' }, 1.1).converted?.parameters.dateTime).toBe('2026-11-01T08:30:00');
    const expr = convert('wait', { resume: 'specificTime', dateTime: '={{ $json.quando }}' }, 1.1);
    expect(expr.converted?.parameters.dateTime).toBe('={{ $json.quando }}');
    expect(expr.warnings).toEqual([expect.stringMatching(/expressão/)]);
    const hook = convert('wait', { resume: 'webhook', httpMethod: 'POST', options: { webhookSuffix: 'ok' }, limitWaitTime: true, resumeAmount: 2, resumeUnit: 'days' }, 1.1);
    expect(hook.converted?.parameters).toMatchObject({ resume: 'webhook', httpMethod: 'POST', webhookSuffix: 'ok', limitWaitTime: true, resumeAmount: 2, resumeUnit: 'days' });
    expect(hook.warnings).toEqual([expect.stringMatching(/resumeUrl/)]);
    const form = convert('wait', { resume: 'form', formTitle: 'Aprovar', formFields: { values: [{ fieldLabel: 'Ok?', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Sim' }, { option: 'Não' }] } }] } }, 1.1);
    expect(form.converted?.parameters).toMatchObject({ resume: 'form', formTitle: 'Aprovar', formFields: [{ fieldLabel: 'Ok?', fieldType: 'dropdown', fieldOptions: 'Sim\nNão' }] });
  });

  it('No Operation e Execution Data', () => {
    expect(convert('noOp', {}).converted).toEqual({ type: 'noOp', parameters: {} });
    expect(convert('executionData', { dataToSave: { values: [{ key: 'pedido', value: '={{ $json.id }}' }] } }).converted).toEqual({
      type: 'executionData',
      parameters: { dataToSave: [{ key: 'pedido', value: '={{ $json.id }}' }] },
    });
    expect(convert('executionData', {}).converted?.parameters).toEqual({ dataToSave: [{ key: '', value: '' }] });
  });
});
