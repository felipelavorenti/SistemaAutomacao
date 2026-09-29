import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { SubworkflowResult } from '../src/node-types.js';
import type { Connection, Item, NodeInstance, WorkflowDefinition } from '../src/types.js';

const node = (id: string, type: string, parameters: NodeInstance['parameters'] = {}, name = id): NodeInstance => ({
  id,
  name,
  type,
  position: { x: 0, y: 0 },
  parameters,
});
const link = (from: string, to: string, fromOutput = 0, toInput = 0): Connection => ({ from, fromOutput, to, toInput });
const trigger = node('t', 'manualTrigger', {}, 'Início');
const items = (...list: Record<string, unknown>[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));

function run(workflow: WorkflowDefinition, input: Item[] = [], extra: Partial<Parameters<typeof executeWorkflow>[0]> = {}) {
  return executeWorkflow({ workflow, executionId: 'x', mode: 'manual', triggerItems: input, ...extra });
}

describe('Split Out e Aggregate', () => {
  it('quebra a lista em itens e junta de volta', async () => {
    const wf: WorkflowDefinition = {
      nodes: [
        trigger,
        node('s', 'splitOut', { field: 'pedido.itens', include: 'all', destination: 'item' }, 'Split'),
        node('a', 'aggregate', { mode: 'fields', fields: [{ field: 'item.sku', outputName: 'skus' }, { field: 'numero', outputName: '' }] }, 'Agg'),
      ],
      connections: [link('t', 's'), link('s', 'a')],
    };
    const result = await run(wf, items({ numero: 7, pedido: { itens: [{ sku: 'A' }, { sku: 'B' }] } }));
    expect(result.status).toBe('success');
    expect(result.runs[1].output[0].map((i) => i.json)).toEqual([
      { numero: 7, pedido: {}, item: { sku: 'A' } },
      { numero: 7, pedido: {}, item: { sku: 'B' } },
    ]);
    expect(result.lastOutput).toEqual([{ json: { skus: ['A', 'B'], numero: [7, 7] } }]);
  });

  it('objetos viram o próprio item e expressão pode entregar a lista', async () => {
    const wf: WorkflowDefinition = { nodes: [trigger, node('s', 'splitOut', { field: '={{ $json.lista }}' })], connections: [link('t', 's')] };
    const result = await run(wf, items({ lista: [{ a: 1 }, { a: 2 }] }));
    expect(result.lastOutput.map((i) => i.json)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('Aggregate com os itens inteiros', async () => {
    const wf: WorkflowDefinition = { nodes: [trigger, node('a', 'aggregate', { mode: 'all', destination: 'linhas' })], connections: [link('t', 'a')] };
    const result = await run(wf, items({ a: 1 }, { a: 2 }));
    expect(result.lastOutput).toEqual([{ json: { linhas: [{ a: 1 }, { a: 2 }] } }]);
  });
});

describe('Merge', () => {
  const source = (id: string, code: string) => node(id, 'code', { mode: 'all', jsCode: code });
  const wf = (parameters: NodeInstance['parameters']): WorkflowDefinition => ({
    nodes: [
      trigger,
      source('p', 'return [{ id: 1, nome: "Arroz" }, { id: 2, nome: "Feijão" }, { id: 3, nome: "Sal" }];'),
      source('e', 'return [{ produtoId: 2, estoque: 5 }, { produtoId: 1, estoque: 9 }];'),
      node('m', 'merge', parameters),
    ],
    connections: [link('t', 'p'), link('t', 'e'), link('p', 'm', 0, 0), link('e', 'm', 0, 1)],
  });

  it('emenda as duas entradas', async () => {
    const result = await run(wf({ mode: 'append' }));
    expect(result.lastOutput).toHaveLength(5);
    expect(result.runs.filter((r) => r.nodeId === 'm')).toHaveLength(1);
  });

  it('combina por campo, só os que combinam ou todos da entrada 1', async () => {
    const inner = await run(wf({ mode: 'fields', field1: 'id', field2: 'produtoId', join: 'inner' }));
    expect(inner.lastOutput.map((i) => i.json)).toEqual([
      { id: 1, nome: 'Arroz', produtoId: 1, estoque: 9 },
      { id: 2, nome: 'Feijão', produtoId: 2, estoque: 5 },
    ]);
    const left = await run(wf({ mode: 'fields', field1: 'id', field2: 'produtoId', join: 'left' }));
    expect(left.lastOutput).toHaveLength(3);
  });

  it('combina pela posição e escolhe entrada', async () => {
    const pos = await run(wf({ mode: 'position' }));
    expect(pos.lastOutput.map((i) => i.json)).toEqual([
      { id: 1, nome: 'Arroz', produtoId: 2, estoque: 5 },
      { id: 2, nome: 'Feijão', produtoId: 1, estoque: 9 },
    ]);
    const choose = await run(wf({ mode: 'choose', output: 'input2' }));
    expect(choose.lastOutput).toHaveLength(2);
  });

  it('roda com o que chegou quando uma entrada não recebe itens', async () => {
    const def = wf({ mode: 'append' });
    def.nodes[2] = source('e', 'return [];');
    const result = await run(def);
    expect(result.status).toBe('success');
    expect(result.lastOutput).toHaveLength(3);
  });
});

describe('Loop', () => {
  it('processa em lotes e entrega tudo no concluído', async () => {
    const wf: WorkflowDefinition = {
      nodes: [
        trigger,
        node('l', 'loop', { batchSize: 2 }, 'Loop'),
        node('c', 'code', { mode: 'each', jsCode: 'return { ...$json, dobro: $json.n * 2, lote: $("Loop").all().length };' }, 'Dobra'),
        node('f', 'aggregate', { mode: 'fields', fields: [{ field: 'dobro' }] }, 'Fim'),
      ],
      connections: [link('t', 'l'), link('l', 'c', 1), link('c', 'l'), link('l', 'f', 0)],
    };
    const result = await run(wf, items({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }));
    expect(result.status).toBe('success');
    expect(result.lastOutput).toEqual([{ json: { dobro: [2, 4, 6, 8, 10] } }]);
    expect(result.runs.filter((r) => r.nodeId === 'c').map((r) => r.output[0].map((i) => i.json.lote))).toEqual([[2, 2], [2, 2], [1]]);
  });

  it('segue para o próximo lote quando o ramo não devolve nada', async () => {
    const wf: WorkflowDefinition = {
      nodes: [
        trigger,
        node('l', 'loop', { batchSize: 1 }),
        node('i', 'if', { conditions: [{ left: '={{ $json.n }}', operator: 'gt', right: '1' }] }),
        node('f', 'aggregate', { mode: 'fields', fields: [{ field: 'n' }] }),
      ],
      connections: [link('t', 'l'), link('l', 'i', 1), link('i', 'l', 0), link('l', 'f', 0)],
    };
    const result = await run(wf, items({ n: 1 }, { n: 2 }, { n: 3 }));
    expect(result.status).toBe('success');
    expect(result.lastOutput).toEqual([{ json: { n: [2, 3] } }]);
  });

  it('loop dentro de loop', async () => {
    const wf: WorkflowDefinition = {
      nodes: [
        trigger,
        node('o', 'loop', { batchSize: 1 }, 'Externo'),
        node('s', 'splitOut', { field: 'filhos', include: 'all', destination: 'filho' }),
        node('i', 'loop', { batchSize: 1 }, 'Interno'),
        node('c', 'code', { mode: 'each', jsCode: 'return { par: $json.nome + $json.filho };' }),
        node('a', 'aggregate', { mode: 'fields', fields: [{ field: 'par' }] }),
        node('f', 'aggregate', { mode: 'fields', fields: [{ field: 'par' }] }, 'Final'),
      ],
      connections: [
        link('t', 'o'),
        link('o', 's', 1),
        link('s', 'i'),
        link('i', 'c', 1),
        link('c', 'i'),
        link('i', 'a', 0),
        link('a', 'o'),
        link('o', 'f', 0),
      ],
    };
    const result = await run(wf, items({ nome: 'A', filhos: [1, 2] }, { nome: 'B', filhos: [3] }));
    expect(result.status).toBe('success');
    expect(result.lastOutput).toEqual([{ json: { par: [['A1', 'A2'], ['B3']] } }]);
  });

  it('para um ciclo sem fim pelo limite de execuções', async () => {
    const wf: WorkflowDefinition = {
      nodes: [trigger, node('a', 'code', { jsCode: 'return $input.all();' }), node('b', 'code', { jsCode: 'return $input.all();' })],
      connections: [link('t', 'a'), link('a', 'b'), link('b', 'a')],
    };
    const result = await run(wf, [], { maxNodeRuns: 50 });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('limite de 50');
  });
});

describe('Code', () => {
  it('modo todos os itens, com console.log e await', async () => {
    const wf: WorkflowDefinition = {
      nodes: [trigger, node('c', 'code', { mode: 'all', jsCode: 'console.log("total", $input.all().length);\nconst x = await Promise.resolve(3);\nreturn [{ json: { x } }, { y: 1 }];' })],
      connections: [link('t', 'c')],
    };
    const result = await run(wf, items({ a: 1 }, { a: 2 }));
    expect(result.lastOutput).toEqual([{ json: { x: 3 } }, { json: { y: 1 } }]);
    expect(result.runs[1].meta).toEqual({ logs: ['total 2'] });
  });

  it('erro do código vira erro do nó, com os logs', async () => {
    const wf: WorkflowDefinition = {
      nodes: [trigger, node('c', 'code', { jsCode: 'console.log("antes");\nthrow new Error("deu ruim");' })],
      connections: [link('t', 'c')],
    };
    const result = await run(wf);
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ message: 'deu ruim', details: { logs: ['antes'] }, nodeName: 'c' });
  });

  it('retorno inválido e laço infinito', async () => {
    const bad = await run({ nodes: [trigger, node('c', 'code', { jsCode: 'return [1, 2];' })], connections: [link('t', 'c')] });
    expect(bad.error?.message).toContain('deve devolver objetos');
    const forever = { ...node('c', 'code', { jsCode: 'while (true) {}' })!, settings: { timeoutMs: 300 } };
    const slow = await run({ nodes: [trigger, forever], connections: [link('t', 'c')] });
    expect(slow.status).toBe('error');
    expect(slow.error?.message).toMatch(/tempo limite/);
  });
});

describe('Stop and Error', () => {
  it('interrompe com a mensagem ou com o objeto', async () => {
    const msg = await run({ nodes: [trigger, node('s', 'stopAndError', { message: '=Pedido {{ $json.id }} sem preço' })], connections: [link('t', 's')] }, items({ id: 9 }));
    expect(msg.error).toMatchObject({ message: 'Pedido 9 sem preço', nodeName: 's' });
    const obj = await run({
      nodes: [trigger, node('s', 'stopAndError', { errorType: 'object', errorObject: '={{ { message: "Falhou", codigo: $json.id } }}' })],
      connections: [link('t', 's')],
    }, items({ id: 4 }));
    expect(obj.error).toMatchObject({ message: 'Falhou', details: { message: 'Falhou', codigo: 4 } });
  });
});

describe('Execute Workflow', () => {
  it('executa o subfluxo e devolve a saída, uma vez ou por item', async () => {
    const calls: { workflowId: string; items: Item[] }[] = [];
    const executeSubworkflow = async ({ workflowId, items: list }: { workflowId: string; items: Item[] }): Promise<SubworkflowResult> => {
      calls.push({ workflowId, items: list });
      return { executionId: `sub-${calls.length}`, status: 'success', output: list.map((i) => ({ json: { ...i.json, ok: true } })) };
    };
    const wf = (mode: string): WorkflowDefinition => ({
      nodes: [trigger, node('e', 'executeWorkflow', { workflowId: 'wf-9', mode })],
      connections: [link('t', 'e')],
    });
    const once = await run(wf('once'), items({ a: 1 }, { a: 2 }), { executeSubworkflow });
    expect(once.lastOutput).toEqual(items({ a: 1, ok: true }, { a: 2, ok: true }));
    expect(calls).toHaveLength(1);
    const each = await run(wf('each'), items({ a: 1 }, { a: 2 }), { executeSubworkflow });
    expect(each.runs[1].meta).toEqual({ subExecutionIds: ['sub-2', 'sub-3'] });
    expect(each.lastOutput).toHaveLength(2);
  });

  it('erro do subfluxo traz o nó e os detalhes da API', async () => {
    const executeSubworkflow = async (): Promise<SubworkflowResult> => ({
      executionId: 'sub-1',
      status: 'error',
      output: [],
      error: { message: 'A API respondeu 422', nodeName: 'Alterar preço', details: { statusCode: 422, body: { mensagem: 'Preço inválido' } } },
    });
    const result = await run({ nodes: [trigger, node('e', 'executeWorkflow', { workflowId: 'wf-9' })], connections: [link('t', 'e')] }, [], { executeSubworkflow });
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({
      message: 'O subfluxo falhou no nó "Alterar preço": A API respondeu 422',
      details: { subExecutionId: 'sub-1', node: 'Alterar preço', details: { statusCode: 422, body: { mensagem: 'Preço inválido' } } },
    });
  });

  it('o gatilho do subfluxo entrega os itens recebidos', async () => {
    const result = await executeWorkflow({
      workflow: { nodes: [node('g', 'executeWorkflowTrigger')], connections: [] },
      executionId: 'x',
      mode: 'subworkflow',
      triggerItems: items({ a: 1 }),
    });
    expect(result.lastOutput).toEqual(items({ a: 1 }));
  });
});
