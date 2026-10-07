import type { NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { getPath, isPlainObject, splitPath } from './paths.js';

/**
 * Nós de transformação de listas de itens, réplicas dos nós Limit, Sort,
 * Remove Duplicates, Rename Keys e Summarize do n8n.
 */

// ---------------------------------------------------------------- utilitários

/** Lê o campo pelo caminho ("a.b.c") ou, com a notação de ponto desligada, pela chave exata. */
function fieldGetter(disableDotNotation: boolean) {
  return (obj: JsonObject, field: string): JsonValue | undefined => (disableDotNotation ? (Object.hasOwn(obj, field) ? obj[field] : undefined) : getPath(obj, field));
}

/** Grava o valor no caminho, criando os objetos do meio (como o `set` do lodash). */
export function setPath(obj: JsonObject, path: string, value: JsonValue): void {
  const keys = splitPath(path);
  if (!keys.length) return;
  let current: JsonObject | JsonValue[] = obj;
  for (const key of keys.slice(0, -1)) {
    const next: JsonValue | undefined = Array.isArray(current) ? current[Number(key)] : current[key];
    if (next !== null && typeof next === 'object') {
      current = next;
    } else {
      const created: JsonObject = {};
      if (Array.isArray(current)) current[Number(key)] = created;
      else current[key] = created;
      current = created;
    }
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(current)) current[Number(last)] = value;
  else current[last] = value;
}

/** Apaga o campo do caminho, no próprio objeto. */
function unsetPath(obj: JsonObject, path: string): void {
  const keys = splitPath(path);
  let current: JsonValue | undefined = obj;
  for (const key of keys.slice(0, -1)) {
    if (current === null || typeof current !== 'object') return;
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  if (isPlainObject(current)) delete current[keys[keys.length - 1]];
}

/** Igualdade profunda, sem depender da ordem das chaves (como o `isEqual` do lodash). */
export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a as JsonObject);
  const kb = Object.keys(b as JsonObject);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as JsonObject)[k], (b as JsonObject)[k]));
}

/** Texto canônico do valor (chaves em ordem), para agrupar valores iguais. */
function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

/** "Menor que" do lodash: compara textos como textos e o resto convertido para número. */
function lessThan(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  return toNumber(a) < toNumber(b);
}

function toNumber(value: JsonValue | undefined): number {
  if (value === undefined) return NaN;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return NaN;
  return Number(value);
}

/** Lista de campos separados por vírgula (ou já em lista). */
export function fieldsArray(value: JsonValue): string[] {
  const list = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(',');
  return list.map((f) => f.trim()).filter(Boolean);
}

/** Achata as chaves aninhadas: { a: { b: 1 } } vira { "a.b": 1 }; listas viram "a.0". */
function flattenKeys(value: JsonValue, prefix: string[] = [], out: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [k, v] of entries) flattenKeys(v, [...prefix, k], out);
  } else {
    out[prefix.join('.')] = value;
  }
  return out;
}

const bool = (v: JsonValue) => v === true || v === 'true';

// ---------------------------------------------------------------------- Limit

export const limit: NodeType = {
  description: {
    type: 'limit',
    displayName: 'Limit',
    description: 'Deixa passar no máximo um certo número de itens, do começo ou do fim da lista.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'maxItems',
        displayName: 'Máximo de itens',
        type: 'number',
        default: 1,
        description: 'Se chegarem mais itens do que isso, os excedentes são descartados.',
      },
      {
        name: 'keep',
        displayName: 'Manter',
        type: 'options',
        default: 'firstItems',
        options: [
          { name: 'Os primeiros itens', value: 'firstItems' },
          { name: 'Os últimos itens', value: 'lastItems' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const max = Math.trunc(Number(await ctx.getParam('maxItems', 0)));
    if (!Number.isFinite(max) || max < 1) throw new NodeOperationError('O máximo de itens deve ser um número a partir de 1');
    if (max >= input.length) return [input];
    const keep = await ctx.getParam('keep', 0);
    return [keep === 'lastItems' ? input.slice(input.length - max) : input.slice(0, max)];
  },
};

// ----------------------------------------------------------------------- Sort

const SORT_CODE_DEFAULT = `// Os dois itens comparados estão em a e b
// Os campos ficam em a.json e b.json
// Devolva -1 se a vem antes de b
// Devolva 1 se b vem antes de a
// Devolva 0 se tanto faz

const campo = 'meuCampo';

if (a.json[campo] < b.json[campo]) {
  return -1;
}
if (a.json[campo] > b.json[campo]) {
  return 1;
}
return 0;`;

export const sort: NodeType = {
  description: {
    type: 'sort',
    displayName: 'Sort',
    description: 'Ordena os itens por campos, aleatoriamente ou com um código de comparação.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'type',
        displayName: 'Tipo de ordenação',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'Simples (por campos)', value: 'simple' },
          { name: 'Aleatória', value: 'random' },
          { name: 'Código', value: 'code' },
        ],
      },
      {
        name: 'sortFields',
        displayName: 'Campos para ordenar',
        type: 'list',
        default: [{ fieldName: '', order: 'ascending' }],
        showWhen: { type: ['simple'] },
        description: 'Em ordem de prioridade: o segundo campo só desempata o primeiro.',
        fields: [
          { name: 'fieldName', displayName: 'Campo', type: 'string', default: '', placeholder: 'cliente.nome' },
          {
            name: 'order',
            displayName: 'Ordem',
            type: 'options',
            default: 'ascending',
            options: [
              { name: 'Crescente', value: 'ascending' },
              { name: 'Decrescente', value: 'descending' },
            ],
          },
        ],
      },
      {
        name: 'code',
        displayName: 'Código de comparação',
        type: 'code',
        default: SORT_CODE_DEFAULT,
        showWhen: { type: ['code'] },
        description: 'Corpo de uma função JavaScript que recebe a e b e devolve um número negativo, zero ou positivo.',
      },
      {
        name: 'disableDotNotation',
        displayName: 'Desligar notação de ponto',
        type: 'boolean',
        default: false,
        showWhen: { type: ['simple'] },
        description: 'Liga para tratar "pai.filho" como o nome exato de um campo, e não como um campo dentro de outro.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const type = await ctx.getParam('type', 0);
    const items = [...input];

    if (type === 'random') {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return [items];
    }

    if (type === 'code') {
      const userCode = String(ctx.node.parameters.code ?? SORT_CODE_DEFAULT);
      if (!/\breturn\b/.test(userCode)) throw new NodeOperationError('O código de comparação não devolve nada; inclua um "return"');
      if (input.length < 2) return [items];
      // Uma única execução no isolate com todos os itens: ordena lá dentro e devolve só as posições.
      const source = `const __list = $input.all().map((item, __pos) => ({ json: item.json, __pos }));
__list.sort((a, b) => {
${userCode}
});
return __list.map((x) => x.__pos);`;
      const { result, logs } = await ctx.runCode(source, 0);
      if (logs.length) ctx.meta.logs = logs.slice(0, 500);
      if (!Array.isArray(result) || result.length !== input.length) throw new NodeOperationError('O código de comparação não produziu uma ordenação válida');
      return [result.map((pos) => input[Number(pos)])];
    }

    const disableDotNotation = bool(await ctx.getParam('disableDotNotation', 0));
    const get = fieldGetter(disableDotNotation);
    const raw = await ctx.getParam('sortFields', 0);
    const fields = (Array.isArray(raw) ? raw : [])
      .filter(isPlainObject)
      .map((f) => ({ name: String(f.fieldName ?? '').trim(), dir: f.order === 'descending' ? -1 : 1 }))
      .filter((f) => f.name);
    if (!fields.length) throw new NodeOperationError('Nenhum campo de ordenação informado; adicione um campo para ordenar');

    for (const { name } of fields) {
      if (!input.some((item) => get(item.json, name) !== undefined)) {
        throw new NodeOperationError(
          `O campo "${name}" não existe nos itens recebidos`,
          disableDotNotation && name.includes('.') ? 'Para usar um campo dentro de outro, desligue a opção "Desligar notação de ponto"' : undefined,
        );
      }
    }

    const value = (item: Item, name: string) => {
      const v = get(item.json, name);
      return typeof v === 'string' ? v.toLowerCase() : v;
    };
    items.sort((a, b) => {
      for (const field of fields) {
        const va = value(a, field.name);
        const vb = value(b, field.name);
        if (!deepEqual(va, vb)) return (lessThan(va, vb) ? -1 : 1) * field.dir;
      }
      return 0;
    });
    return [items];
  },
};

// ---------------------------------------------------------- Remove Duplicates

export const removeDuplicates: NodeType = {
  description: {
    type: 'removeDuplicates',
    displayName: 'Remove Duplicates',
    description: 'Remove os itens repetidos da entrada, comparando todos os campos ou só alguns.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'compare',
        displayName: 'Comparar',
        type: 'options',
        default: 'allFields',
        options: [
          { name: 'Todos os campos', value: 'allFields' },
          { name: 'Todos os campos, menos alguns', value: 'allFieldsExcept' },
          { name: 'Só os campos escolhidos', value: 'selectedFields' },
        ],
      },
      {
        name: 'fieldsToExclude',
        displayName: 'Campos a ignorar',
        type: 'string',
        default: '',
        placeholder: 'email, nome',
        showWhen: { compare: ['allFieldsExcept'] },
        description: 'Separados por vírgula.',
      },
      {
        name: 'fieldsToCompare',
        displayName: 'Campos a comparar',
        type: 'string',
        default: '',
        placeholder: 'email, nome',
        showWhen: { compare: ['selectedFields'] },
        description: 'Separados por vírgula.',
      },
      {
        name: 'disableDotNotation',
        displayName: 'Desligar notação de ponto',
        type: 'boolean',
        default: false,
        description: 'Liga para tratar "pai.filho" como o nome exato de um campo, e não como um campo dentro de outro.',
      },
      {
        name: 'removeOtherFields',
        displayName: 'Remover os outros campos',
        type: 'boolean',
        default: false,
        showWhen: { compare: ['allFieldsExcept', 'selectedFields'] },
        description: 'Deixa no item só os campos comparados. Desligado, fica o item inteiro da primeira ocorrência.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    if (!input.length) return [[]];
    const compare = String((await ctx.getParam('compare', 0)) ?? 'allFields');
    const disableDotNotation = bool(await ctx.getParam('disableDotNotation', 0));
    const removeOtherFields = bool(await ctx.getParam('removeOtherFields', 0));
    const get = fieldGetter(disableDotNotation);
    const keysOf = (json: JsonObject) => Object.keys(disableDotNotation ? json : flattenKeys(json));

    let keys: string[];
    if (compare === 'selectedFields') {
      keys = fieldsArray(await ctx.getParam('fieldsToCompare', 0));
      if (!keys.length) throw new NodeOperationError('Nenhum campo informado; adicione um campo para comparar');
    } else if (compare === 'allFieldsExcept') {
      const exclude = fieldsArray(await ctx.getParam('fieldsToExclude', 0));
      if (!exclude.length) throw new NodeOperationError('Nenhum campo informado; adicione um campo para ignorar na comparação');
      // Como no n8n, com notação de ponto as chaves vêm do primeiro item; sem ela, de todos.
      const base = disableDotNotation ? [...new Set(input.flatMap((i) => keysOf(i.json)))] : keysOf(input[0].json);
      keys = base.filter((k) => !exclude.some((e) => k === e || (!disableDotNotation && k.startsWith(`${e}.`))));
    } else {
      keys = [...new Set(input.flatMap((i) => keysOf(i.json)))];
    }

    // Mesmas validações do n8n: o campo precisa existir em todos os itens e ter sempre o mesmo tipo.
    for (const key of keys) {
      let type: string | undefined;
      for (const [i, item] of input.entries()) {
        const v = get(item.json, key);
        if (v === null) continue;
        if (v === undefined) {
          throw new NodeOperationError(
            `O campo "${key}" falta em alguns itens`,
            disableDotNotation && key.includes('.') ? 'Para usar um campo dentro de outro, desligue a opção "Desligar notação de ponto"' : undefined,
          );
        }
        const t = Array.isArray(v) ? 'object' : typeof v;
        if (type !== undefined && type !== t) throw new NodeOperationError(`O campo "${key}" não tem sempre o mesmo tipo`, `No item ${i} ele é ${t}; antes era ${type}`);
        type = t;
      }
    }

    const seen = new Set<string>();
    const kept: Item[] = [];
    for (const item of input) {
      const signature = keys.map((k) => canonical(get(item.json, k))).join('\u0000');
      if (seen.has(signature)) continue;
      seen.add(signature);
      kept.push(item);
    }
    if (!removeOtherFields) return [kept];
    return [
      kept.map((item) => {
        const json: JsonObject = {};
        for (const k of keys) {
          const v = get(item.json, k);
          if (v === undefined) continue;
          if (disableDotNotation) json[k] = structuredClone(v);
          else setPath(json, k, structuredClone(v));
        }
        return { json };
      }),
    ];
  },
};

// ---------------------------------------------------------------- Rename Keys

export const renameKeys: NodeType = {
  description: {
    type: 'renameKeys',
    displayName: 'Rename Keys',
    description: 'Troca o nome de campos dos itens, inclusive de campos dentro de outros e por expressão regular.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'keys',
        displayName: 'Campos para renomear',
        type: 'list',
        default: [{ currentKey: '', newKey: '' }],
        description: 'Aceita caminhos com ponto, como "nivel1.nivel2.campo".',
        fields: [
          { name: 'currentKey', displayName: 'Nome atual', type: 'string', default: '', placeholder: 'nomeAtual' },
          { name: 'newKey', displayName: 'Nome novo', type: 'string', default: '', placeholder: 'nomeNovo' },
        ],
      },
      {
        name: 'regexReplacements',
        displayName: 'Renomear por expressão regular',
        type: 'list',
        default: [],
        description: 'Aplicadas depois da lista acima; podem afetar campos já renomeados. Use $1, $2... para os grupos capturados.',
        fields: [
          { name: 'searchRegex', displayName: 'Expressão regular', type: 'string', default: '', placeholder: '[Nn]ome' },
          { name: 'replaceRegex', displayName: 'Trocar por', type: 'string', default: '', placeholder: 'nomeTrocado' },
          { name: 'caseInsensitive', displayName: 'Ignorar maiúsculas', type: 'boolean', default: false },
          { name: 'depth', displayName: 'Profundidade máxima', type: 'number', default: -1, description: '-1 sem limite; 0 só o primeiro nível.' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const rawKeys = await ctx.getParam('keys', i);
      const rawRegex = await ctx.getParam('regexReplacements', i);
      const original = input[i].json;
      const json: JsonObject = structuredClone(original);

      for (const k of (Array.isArray(rawKeys) ? rawKeys : []).filter(isPlainObject)) {
        const current = String(k.currentKey ?? '');
        const next = String(k.newKey ?? '');
        if (!current || !next || current === next) continue;
        const value = getPath(original, current);
        if (value === undefined) continue;
        setPath(json, next, structuredClone(value));
        unsetPath(json, current);
      }

      for (const r of (Array.isArray(rawRegex) ? rawRegex : []).filter(isPlainObject)) {
        const search = String(r.searchRegex ?? '');
        if (!search) continue;
        let regex: RegExp;
        try {
          regex = new RegExp(search, bool(r.caseInsensitive) ? 'i' : '');
        } catch (err) {
          throw new NodeOperationError(`Expressão regular inválida: ${search}`, err instanceof Error ? err.message : String(err));
        }
        const replace = String(r.replaceRegex ?? '');
        const depth = r.depth === '' || r.depth === null || r.depth === undefined ? -1 : Math.trunc(Number(r.depth));
        renameByRegex(json, regex, replace, Number.isFinite(depth) ? depth : -1);
      }
      out.push({ json });
    }
    return [out];
  },
};

function renameByRegex(value: JsonValue, regex: RegExp, replace: string, depth: number): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    // Não renomeia as posições da lista, só os objetos dentro dela.
    if (depth !== 0) for (const v of value) renameByRegex(v, regex, replace, depth - 1);
    return;
  }
  for (const key of Object.keys(value)) {
    if (depth !== 0) renameByRegex(value[key], regex, replace, depth - 1);
    if (!regex.test(key)) continue;
    const newKey = key.replace(regex, replace);
    if (newKey !== key) {
      value[newKey] = value[key];
      delete value[key];
    }
  }
}

// ------------------------------------------------------------------ Summarize

type Aggregation = 'append' | 'average' | 'concatenate' | 'count' | 'countUnique' | 'max' | 'min' | 'sum';

const AGGREGATION_PREFIX: Record<Aggregation, string> = {
  append: 'appended_',
  average: 'average_',
  concatenate: 'concatenated_',
  count: 'count_',
  countUnique: 'unique_count_',
  max: 'max_',
  min: 'min_',
  sum: 'sum_',
};

interface SummaryField {
  aggregation: Aggregation;
  field: string;
  includeEmpty: boolean;
  separator: string;
}

type Getter = (obj: JsonObject, field: string) => JsonValue | undefined;
type Group = { result: JsonObject } | { fieldName: string; splits: Map<JsonValue | undefined, Group> };

const isEmptyValue = (v: JsonValue | undefined) => v === undefined || v === null || v === '';

/** Nome do campo de saída como no n8n: "pedido.valor" vira "pedido_valor". */
export function normalizeFieldName(name: string): string {
  return name.replace(/[\]["]/g, '').replace(/[ .]/g, '_');
}

function summarizeField(items: JsonObject[], entry: SummaryField, get: Getter): JsonValue {
  const { aggregation, field } = entry;
  let values = items.map((item) => get(item, field));
  if (aggregation === 'average' || aggregation === 'sum') values = values.filter((v) => typeof v === 'number');

  switch (aggregation) {
    case 'append':
      return (entry.includeEmpty ? values : values.filter((v) => !isEmptyValue(v))).map((v) => (v === undefined ? null : v));
    case 'concatenate':
      return (entry.includeEmpty ? values : values.filter((v) => !isEmptyValue(v)))
        .map((v) => (v === undefined ? 'undefined' : v !== null && typeof v === 'object' ? JSON.stringify(v) : v === null ? '' : String(v)))
        .join(entry.separator);
    case 'average': {
      const avg = (values as number[]).reduce((a, b) => a + b, 0) / values.length;
      return Number.isFinite(avg) ? avg : null;
    }
    case 'sum':
      return (values as number[]).reduce((a, b) => a + b, 0);
    case 'min':
    case 'max': {
      let best: JsonValue | undefined;
      for (const v of values) {
        if (isEmptyValue(v)) continue;
        if (best === undefined || (aggregation === 'min' ? (v as number) < (best as number) : (v as number) > (best as number))) best = v;
      }
      return best ?? null;
    }
    case 'countUnique':
      return new Set(entry.includeEmpty ? values : values.filter((v) => !isEmptyValue(v))).size;
    default:
      return entry.includeEmpty ? values.length : values.filter((v) => !isEmptyValue(v)).length;
  }
}

function groupAndSummarize(items: JsonObject[], splitKeys: string[], fields: SummaryField[], get: Getter, skipEmpty: boolean): Group {
  if (!splitKeys.length) {
    return { result: Object.fromEntries(fields.map((f) => [normalizeFieldName(`${AGGREGATION_PREFIX[f.aggregation]}${f.field}`), summarizeField(items, f, get)])) };
  }
  const [first, ...rest] = splitKeys;
  const groups = new Map<JsonValue | undefined, JsonObject[]>();
  const byCanonical = new Map<string, JsonValue | undefined>();
  for (const item of items) {
    let value = get(item, first);
    if (value !== null && typeof value === 'object') value = JSON.stringify(value);
    if (skipEmpty && typeof value !== 'number' && !value) continue;
    // A chave mantém o tipo (1 e "1" são grupos diferentes), como o Map do n8n.
    const id = canonical(value);
    if (!byCanonical.has(id)) byCanonical.set(id, value);
    const key = byCanonical.get(id);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return { fieldName: first, splits: new Map([...groups].map(([k, list]) => [k, groupAndSummarize(list, rest, fields, get, skipEmpty)])) };
}

function groupToObject(group: Group): JsonObject {
  if ('result' in group) return group.result;
  return Object.fromEntries([...group.splits].map(([k, g]) => [String(k), groupToObject(g)]));
}

function groupToRows(group: Group): JsonObject[] {
  if ('result' in group) return [{ ...group.result }];
  return [...group.splits].flatMap(([value, inner]) =>
    groupToRows(inner).map((row) => {
      if (value !== undefined) row[normalizeFieldName(group.fieldName)] = value;
      return row;
    }),
  );
}

export const summarize: NodeType = {
  description: {
    type: 'summarize',
    displayName: 'Summarize',
    description: 'Soma, conta, tira média, mínimo, máximo e junta valores dos itens, com agrupamento opcional (como uma tabela dinâmica).',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'fieldsToSummarize',
        displayName: 'Campos para resumir',
        type: 'list',
        default: [{ aggregation: 'count', field: '', includeEmpty: false, separateBy: ',', customSeparator: '' }],
        description: 'O campo de saída se chama como no n8n: sum_valor, count_id, average_x, appended_x, concatenated_x, unique_count_x, max_x, min_x.',
        fields: [
          {
            name: 'aggregation',
            displayName: 'Cálculo',
            type: 'options',
            default: 'count',
            options: [
              { name: 'Juntar em lista', value: 'append' },
              { name: 'Média', value: 'average' },
              { name: 'Concatenar em texto', value: 'concatenate' },
              { name: 'Contar', value: 'count' },
              { name: 'Contar valores distintos', value: 'countUnique' },
              { name: 'Máximo', value: 'max' },
              { name: 'Mínimo', value: 'min' },
              { name: 'Soma', value: 'sum' },
            ],
          },
          { name: 'field', displayName: 'Campo', type: 'string', default: '', placeholder: 'valor' },
          {
            name: 'includeEmpty',
            displayName: 'Incluir vazios',
            type: 'boolean',
            default: false,
            description: 'Para juntar, concatenar e contar: considera também valores nulos, vazios ou ausentes.',
          },
          {
            name: 'separateBy',
            displayName: 'Separador (concatenar)',
            type: 'options',
            default: ',',
            options: [
              { name: 'Vírgula', value: ',' },
              { name: 'Vírgula e espaço', value: ', ' },
              { name: 'Quebra de linha', value: '\n' },
              { name: 'Nenhum', value: '' },
              { name: 'Espaço', value: ' ' },
              { name: 'Outro', value: 'other' },
            ],
          },
          { name: 'customSeparator', displayName: 'Separador personalizado', type: 'string', default: '' },
        ],
      },
      {
        name: 'fieldsToSplitBy',
        displayName: 'Agrupar por',
        type: 'string',
        default: '',
        placeholder: 'pais, cidade',
        description: 'Campos separados por vírgula. Vazio: um resumo de todos os itens.',
      },
      {
        name: 'outputFormat',
        displayName: 'Formato da saída',
        type: 'options',
        default: 'separateItems',
        options: [
          { name: 'Um item por grupo', value: 'separateItems' },
          { name: 'Todos os grupos em um item só', value: 'singleItem' },
        ],
      },
      {
        name: 'skipEmptySplitFields',
        displayName: 'Ignorar itens sem valor para agrupar',
        type: 'boolean',
        default: false,
      },
      {
        name: 'disableDotNotation',
        displayName: 'Desligar notação de ponto',
        type: 'boolean',
        default: false,
        description: 'Liga para tratar "pai.filho" como o nome exato de um campo, e não como um campo dentro de outro.',
      },
      {
        name: 'continueIfFieldNotFound',
        displayName: 'Continuar se o campo não existir',
        type: 'boolean',
        default: true,
        description: 'Desligado, o nó dá erro quando um campo a resumir não aparece em nenhum item.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    if (!input.length) return [[]];
    const raw = await ctx.getParam('fieldsToSummarize', 0);
    const fields: SummaryField[] = (Array.isArray(raw) ? raw : [])
      .filter(isPlainObject)
      .map((f) => {
        const aggregation = (String(f.aggregation ?? 'count') in AGGREGATION_PREFIX ? String(f.aggregation ?? 'count') : 'count') as Aggregation;
        const separateBy = f.separateBy === undefined || f.separateBy === null ? ',' : String(f.separateBy);
        return { aggregation, field: String(f.field ?? '').trim(), includeEmpty: bool(f.includeEmpty), separator: separateBy === 'other' ? String(f.customSeparator ?? '') : separateBy };
      })
      .filter((f) => f.field);
    if (!fields.length) throw new NodeOperationError('Adicione pelo menos um campo para resumir, com o nome do campo preenchido');

    const splitBy = fieldsArray(await ctx.getParam('fieldsToSplitBy', 0));
    const outputFormat = await ctx.getParam('outputFormat', 0);
    const skipEmpty = bool(await ctx.getParam('skipEmptySplitFields', 0));
    const continueParam = await ctx.getParam('continueIfFieldNotFound', 0);
    const continueIfMissing = continueParam === null || continueParam === undefined || continueParam === '' ? true : bool(continueParam);
    const get = fieldGetter(bool(await ctx.getParam('disableDotNotation', 0)));
    const items = input.map((i) => i.json);

    const missing = fields.filter((f) => !items.some((item) => get(item, f.field) !== undefined)).map((f) => f.field);
    if (missing.length) {
      if (!continueIfMissing) throw new NodeOperationError(`O campo "${missing[0]}" não existe em nenhum item`);
      ctx.meta.hints = [...new Set(missing)].map((f) => `O campo "${f}" não existe em nenhum item`);
    }

    const result = groupAndSummarize(items, splitBy, fields, get, skipEmpty);
    if (outputFormat === 'singleItem') return [[{ json: groupToObject(result) }]];
    return [groupToRows(result).map((json) => ({ json }))];
  },
};

export const transformNodes: NodeType[] = [limit, sort, removeDuplicates, renameKeys, summarize];
