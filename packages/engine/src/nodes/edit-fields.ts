import type { NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { getPath, isPlainObject, splitPath, withoutPath } from './paths.js';

const TYPES = [
  { name: 'String', value: 'string' },
  { name: 'Number', value: 'number' },
  { name: 'Boolean', value: 'boolean' },
  { name: 'Array', value: 'array' },
  { name: 'Object', value: 'object' },
];

/** Edit Fields (Set), como no n8n: define campos à mão ou por JSON e escolhe o que mais passa adiante. */
export const editFields: NodeType = {
  description: {
    type: 'editFields',
    displayName: 'Edit Fields (Set)',
    description: 'Cria ou altera campos dos itens, como o Edit Fields do n8n.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'manual',
        options: [
          { name: 'Manual Mapping', value: 'manual' },
          { name: 'JSON', value: 'raw' },
        ],
      },
      {
        name: 'assignments',
        displayName: 'Fields to Set',
        type: 'list',
        default: [],
        showWhen: { mode: ['manual'] },
        fields: [
          {
            name: 'name',
            displayName: 'Nome',
            type: 'string',
            default: '',
            placeholder: 'cliente.nome',
          },
          {
            name: 'type',
            displayName: 'Tipo',
            type: 'options',
            default: 'string',
            options: TYPES,
          },
          { name: 'value', displayName: 'Valor', type: 'string', default: '' },
        ],
      },
      {
        name: 'jsonOutput',
        displayName: 'JSON Output',
        type: 'json',
        default: '{\n  "campo": "valor"\n}',
        showWhen: { mode: ['raw'] },
      },
      {
        name: 'includeOtherFields',
        displayName: 'Include Other Input Fields',
        type: 'boolean',
        default: false,
        description: 'Desligado: o item de saída tem só os campos definidos aqui.',
      },
      {
        name: 'include',
        displayName: 'Input Fields to Include',
        type: 'options',
        default: 'all',
        showWhen: { includeOtherFields: [true] },
        options: [
          { name: 'All', value: 'all' },
          { name: 'Selected', value: 'selected' },
          { name: 'All Except', value: 'except' },
        ],
      },
      {
        name: 'includeFields',
        displayName: 'Fields to Include',
        type: 'string',
        default: '',
        placeholder: 'id, nome, endereco.cidade',
        description: 'Nomes separados por vírgula.',
        showWhen: { includeOtherFields: [true], include: ['selected'] },
      },
      {
        name: 'excludeFields',
        displayName: 'Fields to Exclude',
        type: 'string',
        default: '',
        placeholder: 'senha, token',
        description: 'Nomes separados por vírgula.',
        showWhen: { includeOtherFields: [true], include: ['except'] },
      },
      {
        name: 'dotNotation',
        displayName: 'Support Dot Notation',
        type: 'boolean',
        default: true,
        description: 'Ligado: "a.b" cria { a: { b } }. Desligado: cria um campo chamado "a.b".',
      },
      {
        name: 'ignoreConversionErrors',
        displayName: 'Ignore Type Conversion Errors',
        type: 'boolean',
        default: false,
        description: 'Ligado: um valor que não converte para o tipo escolhido fica como veio, em vez de parar com erro.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const dotNotation = (await ctx.getParam('dotNotation', i)) !== false;
      const ignoreErrors = (await ctx.getParam('ignoreConversionErrors', i)) === true;

      let json: JsonObject = {};
      if ((await ctx.getParam('includeOtherFields', i)) === true) {
        const include = String((await ctx.getParam('include', i)) ?? 'all');
        if (include === 'selected') {
          for (const name of fieldList(await ctx.getParam('includeFields', i))) {
            const value = dotNotation ? getPath(item.json, name) : item.json[name];
            if (value !== undefined) assign(json, name, value, dotNotation);
          }
        } else if (include === 'except') {
          json = structuredCopy(item.json);
          for (const name of fieldList(await ctx.getParam('excludeFields', i))) json = dotNotation ? withoutPath(json, name) : omit(json, name);
        } else {
          json = structuredCopy(item.json);
        }
      }

      if ((await ctx.getParam('mode', i)) === 'raw') {
        const raw = await ctx.getParam('jsonOutput', i);
        const parsed = typeof raw === 'string' ? parseJson(raw, i) : raw;
        if (!isPlainObject(parsed)) throw new NodeOperationError(`item ${i}: o JSON Output precisa ser um objeto`, { value: parsed ?? null });
        for (const [name, value] of Object.entries(parsed)) assign(json, name, value, dotNotation);
      } else {
        const assignments = await ctx.getParam('assignments', i);
        for (const a of Array.isArray(assignments) ? assignments.filter(isPlainObject) : []) {
          const name = String(a.name ?? '').trim();
          if (!name) continue;
          const type = String(a.type ?? 'string');
          assign(json, name, convert(a.value ?? null, type, name, i, ignoreErrors), dotNotation);
        }
      }
      out.push({ json });
    }
    return [out];
  },
};

function fieldList(value: JsonValue): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function structuredCopy(obj: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(obj)) as JsonObject;
}

function omit(obj: JsonObject, name: string): JsonObject {
  const { [name]: _removed, ...rest } = obj;
  return rest;
}

function assign(target: JsonObject, name: string, value: JsonValue, dotNotation: boolean): void {
  if (!dotNotation) {
    target[name] = value;
    return;
  }
  const parts = splitPath(name);
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as JsonObject;
  }
  node[parts.at(-1) ?? name] = value;
}

function parseJson(text: string, i: number): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new NodeOperationError(`item ${i}: o JSON Output não é um JSON válido`, { value: text });
  }
}

/** Converte o valor para o tipo escolhido, com as mesmas regras do n8n. */
function convert(value: JsonValue, type: string, name: string, i: number, ignoreErrors: boolean): JsonValue {
  const fail = (): JsonValue => {
    if (ignoreErrors) return value;
    throw new NodeOperationError(`item ${i}: o campo "${name}" não pôde ser convertido para ${type}`, { value });
  };
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return value;
      if (value === null || value === '') return null;
      const n = typeof value === 'string' ? Number(value.trim().replace(/\s/g, '')) : typeof value === 'boolean' ? Number(value) : NaN;
      return Number.isFinite(n) ? n : fail();
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === null || value === '') return null;
      const text = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'sim'].includes(text)) return true;
      if (['false', '0', 'no', 'não', 'nao'].includes(text)) return false;
      return fail();
    }
    case 'array':
    case 'object': {
      let parsed: JsonValue = value;
      if (typeof value === 'string') {
        if (!value.trim()) return type === 'array' ? [] : {};
        try {
          parsed = JSON.parse(value) as JsonValue;
        } catch {
          return fail();
        }
      }
      if (type === 'array' ? Array.isArray(parsed) : isPlainObject(parsed)) return parsed;
      return fail();
    }
    default:
      if (value === null || value === undefined) return '';
      return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}
