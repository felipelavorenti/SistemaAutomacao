import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { JsonObject, WorkflowDefinition } from '../src/types.js';

const run = async (parameters: JsonObject, items: JsonObject[]) => {
  const workflow: WorkflowDefinition = {
    nodes: [
      {
        id: 't',
        name: 'Início',
        type: 'manualTrigger',
        position: { x: 0, y: 0 },
        parameters: {},
      },
      {
        id: 'e',
        name: 'Edit Fields',
        type: 'editFields',
        position: { x: 0, y: 0 },
        parameters,
      },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'e', toInput: 0 }],
  };
  const result = await executeWorkflow({
    workflow,
    executionId: 'x',
    mode: 'manual',
    triggerItems: items.map((json) => ({ json })),
  });
  return result;
};

describe('Edit Fields', () => {
  it('define campos com tipo e só eles saem, como no n8n', async () => {
    const r = await run(
      {
        mode: 'manual',
        assignments: [
          { name: 'codigo', type: 'string', value: '={{ $json.id }}' },
          { name: 'preco', type: 'number', value: '={{ $json.valor }}' },
          { name: 'ativo', type: 'boolean', value: 'true' },
          {
            name: 'cliente.nome',
            type: 'string',
            value: '=Loja {{ $json.id }}',
          },
          { name: 'tags', type: 'array', value: '["a","b"]' },
        ],
      },
      [{ id: 7, valor: '12.5', senha: 'x' }],
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.lastOutput[0]!.json).toEqual({
      codigo: '7',
      preco: 12.5,
      ativo: true,
      cliente: { nome: 'Loja 7' },
      tags: ['a', 'b'],
    });
  });

  it('mantém os outros campos: todos, só os escolhidos ou todos menos alguns', async () => {
    const input = [{ id: 1, nome: 'A', senha: 's', end: { cidade: 'X', cep: '1' } }];
    const set = [{ name: 'novo', type: 'number', value: '2' }];
    const all = await run(
      {
        mode: 'manual',
        assignments: set,
        includeOtherFields: true,
        include: 'all',
      },
      input,
    );
    expect(all.lastOutput[0]!.json).toEqual({ ...input[0], novo: 2 });
    const selected = await run(
      {
        mode: 'manual',
        assignments: set,
        includeOtherFields: true,
        include: 'selected',
        includeFields: 'id, end.cidade',
      },
      input,
    );
    expect(selected.lastOutput[0]!.json).toEqual({
      id: 1,
      end: { cidade: 'X' },
      novo: 2,
    });
    const except = await run(
      {
        mode: 'manual',
        assignments: set,
        includeOtherFields: true,
        include: 'except',
        excludeFields: 'senha',
      },
      input,
    );
    expect(except.lastOutput[0]!.json).toEqual({
      id: 1,
      nome: 'A',
      end: { cidade: 'X', cep: '1' },
      novo: 2,
    });
  });

  it('modo JSON e sem dot notation', async () => {
    const r = await run(
      {
        mode: 'raw',
        jsonOutput: '={{ ({ "a.b": $json.id, total: $json.id * 2 }) }}',
        dotNotation: false,
      },
      [{ id: 3 }],
    );
    expect(r.lastOutput[0]!.json).toEqual({ 'a.b': 3, total: 6 });
  });

  it('para com erro de conversão, ou mantém o valor se pedir para ignorar', async () => {
    const params = {
      mode: 'manual',
      assignments: [{ name: 'n', type: 'number', value: 'abc' }],
    };
    const failed = await run(params, [{}]);
    expect(failed.status).toBe('error');
    expect(failed.error?.message).toMatch(/"n" não pôde ser convertido para number/);
    const ignored = await run({ ...params, ignoreConversionErrors: true }, [{}]);
    expect(ignored.lastOutput[0]!.json).toEqual({ n: 'abc' });
  });
});
