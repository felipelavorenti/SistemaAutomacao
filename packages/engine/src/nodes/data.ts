import type { NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { getPath, isPlainObject, splitPath, withoutPath } from './paths.js';

export const splitOut: NodeType = {
  description: {
    type: 'splitOut',
    displayName: 'Split Out',
    description: 'Transforma uma lista de dentro do item em vários itens, um para cada elemento.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'field',
        displayName: 'Campo com a lista',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'pedido.itens',
        description: 'Caminho do campo dentro do item. Em modo Expressão, pode devolver a lista direto.',
      },
      {
        name: 'include',
        displayName: 'Outros campos do item',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Não incluir', value: 'none' },
          { name: 'Incluir em cada item novo', value: 'all' },
        ],
      },
      {
        name: 'destination',
        displayName: 'Nome do campo de destino',
        type: 'string',
        default: '',
        description: 'Onde fica cada elemento. Vazio: usa o nome do campo da lista. Objetos sem outros campos viram o próprio item.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const field = await ctx.getParam('field', i);
      const include = await ctx.getParam('include', i);
      const destinationParam = String((await ctx.getParam('destination', i)) ?? '').trim();
      const path = typeof field === 'string' ? field : '';
      const list = Array.isArray(field) ? field : getPath(input[i].json, path);
      if (list === undefined || list === null) continue;
      const elements = Array.isArray(list) ? list : [list];
      const destination = destinationParam || splitPath(path).at(-1) || 'valor';
      const rest = include === 'all' ? (path ? withoutPath(input[i].json, path) : input[i].json) : null;

      for (const element of elements) {
        if (!rest && isPlainObject(element) && !destinationParam) out.push({ json: element });
        else out.push({ json: { ...(rest ?? {}), [destination]: element } });
      }
    }
    return [out];
  },
};

export const aggregate: NodeType = {
  description: {
    type: 'aggregate',
    displayName: 'Aggregate',
    description: 'Junta todos os itens em um único item, com listas dos campos escolhidos.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'mode',
        displayName: 'Juntar',
        type: 'options',
        default: 'fields',
        options: [
          { name: 'Campos escolhidos', value: 'fields' },
          { name: 'Os itens inteiros', value: 'all' },
        ],
      },
      {
        name: 'fields',
        displayName: 'Campos',
        type: 'list',
        default: [{ field: '', outputName: '' }],
        showWhen: { mode: ['fields'] },
        fields: [
          { name: 'field', displayName: 'Campo', type: 'string', default: '', placeholder: 'sku' },
          { name: 'outputName', displayName: 'Nome na saída (opcional)', type: 'string', default: '' },
        ],
      },
      {
        name: 'destination',
        displayName: 'Nome do campo de saída',
        type: 'string',
        default: 'data',
        showWhen: { mode: ['all'] },
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    if (!input.length) return [[]];
    const mode = await ctx.getParam('mode', 0);
    if (mode === 'all') {
      const destination = String((await ctx.getParam('destination', 0)) || 'data');
      return [[{ json: { [destination]: input.map((i) => i.json) } }]];
    }

    const fields = await ctx.getParam('fields', 0);
    const list = (Array.isArray(fields) ? fields : []).filter(isPlainObject).filter((f) => String(f.field ?? '').trim());
    if (!list.length) throw new NodeOperationError('Informe pelo menos um campo para juntar');
    const result: JsonObject = {};
    for (const f of list) {
      const path = String(f.field).trim();
      const name = String(f.outputName ?? '').trim() || path;
      const values: JsonValue[] = [];
      for (const item of input) {
        const value = getPath(item.json, path);
        if (value !== undefined) values.push(value);
      }
      result[name] = values;
    }
    return [[{ json: result }]];
  },
};

export const merge: NodeType = {
  description: {
    type: 'merge',
    displayName: 'Merge',
    description: 'Junta os itens de duas entradas. Espera as duas chegarem antes de rodar.',
    group: 'data',
    inputs: 2,
    outputs: 1,
    inputNames: ['entrada 1', 'entrada 2'],
    properties: [
      {
        name: 'mode',
        displayName: 'Modo',
        type: 'options',
        default: 'append',
        options: [
          { name: 'Emendar (entrada 1 e depois entrada 2)', value: 'append' },
          { name: 'Combinar por campo em comum', value: 'fields' },
          { name: 'Combinar pela posição', value: 'position' },
          { name: 'Escolher uma das entradas', value: 'choose' },
        ],
      },
      { name: 'field1', displayName: 'Campo na entrada 1', type: 'string', default: '', placeholder: 'id', showWhen: { mode: ['fields'] } },
      { name: 'field2', displayName: 'Campo na entrada 2', type: 'string', default: '', placeholder: 'produtoId', showWhen: { mode: ['fields'] } },
      {
        name: 'join',
        displayName: 'Manter',
        type: 'options',
        default: 'inner',
        showWhen: { mode: ['fields'] },
        options: [
          { name: 'Só os itens que combinam', value: 'inner' },
          { name: 'Todos da entrada 1 (completa com a entrada 2 quando combina)', value: 'left' },
        ],
      },
      {
        name: 'includeUnpaired',
        displayName: 'Manter itens sem par',
        type: 'boolean',
        default: false,
        showWhen: { mode: ['position'] },
        description: 'Quando as entradas têm quantidades diferentes de itens.',
      },
      {
        name: 'output',
        displayName: 'Entrada que segue adiante',
        type: 'options',
        default: 'input1',
        showWhen: { mode: ['choose'] },
        options: [
          { name: 'Entrada 1', value: 'input1' },
          { name: 'Entrada 2', value: 'input2' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const a = ctx.inputs[0] ?? [];
    const b = ctx.inputs[1] ?? [];
    const mode = await ctx.getParam('mode', 0);

    if (mode === 'choose') return [(await ctx.getParam('output', 0)) === 'input2' ? b : a];

    if (mode === 'position') {
      const includeUnpaired = (await ctx.getParam('includeUnpaired', 0)) === true;
      const count = includeUnpaired ? Math.max(a.length, b.length) : Math.min(a.length, b.length);
      return [Array.from({ length: count }, (_, i) => ({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } }))];
    }

    if (mode === 'fields') {
      const field1 = String((await ctx.getParam('field1', 0)) ?? '').trim();
      const field2 = String((await ctx.getParam('field2', 0)) ?? '').trim();
      if (!field1 || !field2) throw new NodeOperationError('Informe o campo de cada entrada para combinar');
      const join = await ctx.getParam('join', 0);
      const key = (v: JsonValue | undefined) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
      const index = new Map<string, Item[]>();
      for (const item of b) {
        const k = key(getPath(item.json, field2));
        if (k !== null) index.set(k, [...(index.get(k) ?? []), item]);
      }
      const out: Item[] = [];
      for (const item of a) {
        const k = key(getPath(item.json, field1));
        const matches = k === null ? [] : (index.get(k) ?? []);
        if (matches.length) for (const m of matches) out.push({ json: { ...item.json, ...m.json } });
        else if (join === 'left') out.push(item);
      }
      return [out];
    }

    return [[...a, ...b]];
  },
};
