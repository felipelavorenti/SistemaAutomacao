import type { NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';

const OPERATORS = [
  { name: 'é igual a', value: 'equals' },
  { name: 'é diferente de', value: 'notEquals' },
  { name: 'contém', value: 'contains' },
  { name: 'não contém', value: 'notContains' },
  { name: 'começa com', value: 'startsWith' },
  { name: 'termina com', value: 'endsWith' },
  { name: 'é maior que', value: 'gt' },
  { name: 'é maior ou igual a', value: 'gte' },
  { name: 'é menor que', value: 'lt' },
  { name: 'é menor ou igual a', value: 'lte' },
  { name: 'está vazio', value: 'isEmpty' },
  { name: 'não está vazio', value: 'isNotEmpty' },
  { name: 'é verdadeiro', value: 'isTrue' },
  { name: 'é falso', value: 'isFalse' },
  { name: 'combina com a regex', value: 'regex' },
];

export const ifNode: NodeType = {
  description: {
    type: 'if',
    displayName: 'If',
    description: 'Separa os itens entre as saídas verdadeiro e falso conforme as condições.',
    group: 'logic',
    inputs: 1,
    outputs: 2,
    outputNames: ['verdadeiro', 'falso'],
    properties: [
      {
        name: 'combinator',
        displayName: 'Combinar condições com',
        type: 'options',
        default: 'and',
        options: [
          { name: 'E (todas verdadeiras)', value: 'and' },
          { name: 'OU (pelo menos uma)', value: 'or' },
        ],
      },
      {
        name: 'conditions',
        displayName: 'Condições',
        type: 'list',
        default: [{ left: '', operator: 'equals', right: '' }],
        fields: [
          { name: 'left', displayName: 'Valor', type: 'string', default: '' },
          { name: 'operator', displayName: 'Operador', type: 'options', default: 'equals', options: OPERATORS },
          { name: 'right', displayName: 'Comparar com', type: 'string', default: '' },
        ],
      },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const whenTrue: Item[] = [];
    const whenFalse: Item[] = [];

    for (let i = 0; i < input.length; i++) {
      const combinator = await ctx.getParam('combinator', i);
      const conditions = await ctx.getParam('conditions', i);
      const list = Array.isArray(conditions) ? (conditions as JsonObject[]) : [];
      const results = list.map((c) => evaluateCondition(c.left, String(c.operator ?? 'equals'), c.right));
      const passed = combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
      (passed ? whenTrue : whenFalse).push(input[i]);
    }
    return [whenTrue, whenFalse];
  },
};

export function evaluateCondition(left: JsonValue | undefined, operator: string, right: JsonValue | undefined): boolean {
  const l = left ?? null;
  const r = right ?? null;
  switch (operator) {
    case 'equals':
      return looseEquals(l, r);
    case 'notEquals':
      return !looseEquals(l, r);
    case 'contains':
      return Array.isArray(l) ? l.some((v) => looseEquals(v, r)) : text(l).includes(text(r));
    case 'notContains':
      return Array.isArray(l) ? !l.some((v) => looseEquals(v, r)) : !text(l).includes(text(r));
    case 'startsWith':
      return text(l).startsWith(text(r));
    case 'endsWith':
      return text(l).endsWith(text(r));
    case 'gt':
      return compare(l, r) > 0;
    case 'gte':
      return compare(l, r) >= 0;
    case 'lt':
      return compare(l, r) < 0;
    case 'lte':
      return compare(l, r) <= 0;
    case 'isEmpty':
      return isEmpty(l);
    case 'isNotEmpty':
      return !isEmpty(l);
    case 'isTrue':
      return l === true || l === 'true';
    case 'isFalse':
      return l === false || l === 'false';
    case 'regex':
      try {
        return new RegExp(text(r)).test(text(l));
      } catch {
        throw new NodeOperationError(`Regex inválida: ${text(r)}`);
      }
    default:
      throw new NodeOperationError(`Operador desconhecido: ${operator}`);
  }
}

function text(v: JsonValue): string {
  if (v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function asNumber(v: JsonValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function looseEquals(a: JsonValue, b: JsonValue): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return text(a) === text(b);
}

function compare(a: JsonValue, b: JsonValue): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return text(a).localeCompare(text(b));
}

function isEmpty(v: JsonValue): boolean {
  if (v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
