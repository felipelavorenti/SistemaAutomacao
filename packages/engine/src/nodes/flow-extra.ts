import { isDeepStrictEqual } from 'node:util';
import type { NodeType, PropertyDescription } from '../node-types.js';
import { NodeOperationError, resolveOutputs } from '../node-types.js';
import { parseLocalDateTime, ScheduleError } from '../schedule.js';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { formFieldsProperty, formToJson, readFormFields } from '../forms.js';
import { evaluateCondition, ifNode } from './if.js';
import { getPath, isPlainObject, splitPath, withoutPath } from './paths.js';

/**
 * Nós de fluxo que reproduzem os do n8n: Filter, Switch, Compare Datasets, Wait,
 * No Operation e Execution Data.
 */

/** Os mesmos operadores do If, para as condições ficarem iguais em todos os nós. */
const OPERATORS = ifNode.description.properties.find((p) => p.name === 'conditions')!.fields!.find((f) => f.name === 'operator')!.options!;

const COMBINATOR: PropertyDescription = {
  name: 'combinator',
  displayName: 'Combinar condições com',
  type: 'options',
  default: 'and',
  options: [
    { name: 'E (todas verdadeiras)', value: 'and' },
    { name: 'OU (pelo menos uma)', value: 'or' },
  ],
};

const CONDITION_FIELDS: PropertyDescription[] = [
  { name: 'left', displayName: 'Valor', type: 'string', default: '' },
  { name: 'operator', displayName: 'Operador', type: 'options', default: 'equals', options: OPERATORS },
  { name: 'right', displayName: 'Comparar com', type: 'string', default: '' },
];

const IGNORE_CASE: PropertyDescription = {
  name: 'ignoreCase',
  displayName: 'Ignorar maiúsculas e minúsculas',
  type: 'boolean',
  default: false,
  description: 'Compara textos sem diferenciar maiúsculas de minúsculas (ex.: "SP" igual a "sp").',
};

function text(v: JsonValue | undefined): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function lower(v: JsonValue | undefined): JsonValue | undefined {
  if (typeof v === 'string') return v.toLowerCase();
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.toLowerCase() : x));
  return v;
}

/** Avalia uma condição do If, opcionalmente sem diferenciar maiúsculas de minúsculas. */
export function evaluateConditionCase(condition: JsonObject, ignoreCase: boolean): boolean {
  const operator = String(condition.operator ?? 'equals');
  if (!ignoreCase) return evaluateCondition(condition.left, operator, condition.right);
  if (operator === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(text(condition.right), 'i');
    } catch {
      throw new NodeOperationError(`Regex inválida: ${text(condition.right)}`);
    }
    return re.test(text(condition.left));
  }
  return evaluateCondition(lower(condition.left), operator, lower(condition.right));
}

function asList(value: JsonValue): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

// ---------- Filter ----------

export const filter: NodeType = {
  description: {
    type: 'filter',
    displayName: 'Filter',
    description: 'Deixa passar só os itens que atendem às condições; os outros são descartados.',
    group: 'logic',
    inputs: 1,
    outputs: 1,
    properties: [
      COMBINATOR,
      {
        name: 'conditions',
        displayName: 'Condições',
        type: 'list',
        default: [{ left: '', operator: 'equals', right: '' }],
        fields: CONDITION_FIELDS,
      },
      IGNORE_CASE,
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const kept: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      const combinator = await ctx.getParam('combinator', i);
      const ignoreCase = (await ctx.getParam('ignoreCase', i)) === true;
      const results = asList(await ctx.getParam('conditions', i)).map((c) => evaluateConditionCase(c, ignoreCase));
      const passed = combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
      if (passed) kept.push(input[i]!);
    }
    return [kept];
  },
};

// ---------- Switch ----------

export const switchNode: NodeType = {
  description: {
    type: 'switch',
    displayName: 'Switch',
    description: 'Manda cada item para uma saída conforme regras ou o número calculado por uma expressão.',
    group: 'logic',
    inputs: 1,
    outputs: 1,
    dynamicOutputs: {
      modeField: 'mode',
      listModes: ['rules'],
      listFrom: 'rules',
      nameField: 'outputKey',
      countModes: ['expression'],
      countFrom: 'numberOutputs',
      extraWhen: { fallbackOutput: ['extra'] },
      extraName: 'Outros',
    },
    properties: [
      {
        name: 'mode',
        displayName: 'Modo',
        type: 'options',
        default: 'rules',
        options: [
          { name: 'Regras (uma saída por regra)', value: 'rules' },
          { name: 'Expressão (número da saída)', value: 'expression' },
        ],
      },
      {
        name: 'rules',
        displayName: 'Regras',
        type: 'list',
        default: [{ left: '', operator: 'equals', right: '', outputKey: '' }],
        showWhen: { mode: ['rules'] },
        description: 'Cada regra é uma saída, na ordem da lista (a primeira é a saída 0).',
        fields: [...CONDITION_FIELDS, { name: 'outputKey', displayName: 'Nome da saída', type: 'string', default: '', placeholder: 'ex.: urgente' }],
      },
      {
        name: 'fallbackOutput',
        displayName: 'Itens que não batem com nenhuma regra',
        type: 'options',
        default: 'none',
        showWhen: { mode: ['rules'] },
        options: [
          { name: 'Descartar', value: 'none' },
          { name: 'Mandar para uma saída extra ("Outros")', value: 'extra' },
          { name: 'Mandar para a saída de uma regra', value: 'output' },
        ],
      },
      {
        name: 'fallbackIndex',
        displayName: 'Número da saída',
        type: 'number',
        default: 0,
        showWhen: { mode: ['rules'], fallbackOutput: ['output'] },
        description: 'Saída que recebe os itens sem regra; começa em 0.',
      },
      {
        name: 'allMatchingOutputs',
        displayName: 'Mandar para todas as regras que batem',
        type: 'boolean',
        default: false,
        showWhen: { mode: ['rules'] },
        description: 'Desligado, o item vai só para a primeira regra que bate.',
      },
      { ...IGNORE_CASE, showWhen: { mode: ['rules'] } },
      {
        name: 'numberOutputs',
        displayName: 'Número de saídas',
        type: 'number',
        default: 4,
        showWhen: { mode: ['expression'] },
      },
      {
        name: 'output',
        displayName: 'Saída do item',
        type: 'string',
        default: '={{ 0 }}',
        showWhen: { mode: ['expression'] },
        description: 'Expressão que devolve o número da saída de cada item, começando em 0.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const { count } = resolveOutputs(switchNode.description, ctx.node.parameters);
    const out: Item[][] = Array.from({ length: count }, () => []);
    const mode = await ctx.getParam('mode', 0);

    if (mode === 'expression') {
      for (let i = 0; i < input.length; i++) {
        const raw = await ctx.getParam('output', i);
        const index = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof index !== 'number' || !Number.isInteger(index)) {
          throw new NodeOperationError(`A saída do item ${i} precisa ser um número inteiro; veio ${JSON.stringify(raw)}`);
        }
        if (index < 0 || index >= count) {
          throw new NodeOperationError(`A saída ${index} do item ${i} não existe; use um número de 0 a ${count - 1}`);
        }
        out[index]!.push(input[i]!);
      }
      return out;
    }

    const ruleCount = Array.isArray(ctx.node.parameters.rules) ? ctx.node.parameters.rules.length : asList(await ctx.getParam('rules', 0)).length;
    const fallback = await ctx.getParam('fallbackOutput', 0);
    const extra = fallback === 'extra';
    let fallbackIndex: number | null = null;
    if (fallback === 'output' || typeof fallback === 'number' || (typeof fallback === 'string' && /^\d+$/.test(fallback))) {
      fallbackIndex = Number(fallback === 'output' ? await ctx.getParam('fallbackIndex', 0) : fallback);
      if (!Number.isInteger(fallbackIndex) || fallbackIndex < 0 || fallbackIndex >= ruleCount) {
        throw new NodeOperationError(`A saída ${fallbackIndex} para os itens sem regra não existe; use um número de 0 a ${ruleCount - 1}`);
      }
    }
    const allMatching = (await ctx.getParam('allMatchingOutputs', 0)) === true;

    for (let i = 0; i < input.length; i++) {
      const rules = asList(await ctx.getParam('rules', i)).slice(0, ruleCount);
      const ignoreCase = (await ctx.getParam('ignoreCase', i)) === true;
      let matched = false;
      for (let r = 0; r < rules.length; r++) {
        if (!evaluateConditionCase(rules[r]!, ignoreCase)) continue;
        matched = true;
        out[r]!.push(input[i]!);
        if (!allMatching) break;
      }
      if (matched) continue;
      if (extra) out[count - 1]!.push(input[i]!);
      else if (fallbackIndex !== null) out[fallbackIndex]!.push(input[i]!);
    }
    return out;
  },
};

// ---------- Compare Datasets ----------

type Pair = { field1: string; field2: string };

const isNullish = (v: unknown) => v === null || v === undefined;
const isFalsy = (v: unknown) => isNullish(v) || v === '' || (Array.isArray(v) && v.length === 0);

/** Igualdade do Compare Datasets do n8n; com `fuzzy`, tolera diferenças de tipo (3 e "3"). */
export function datasetEquals(fuzzy: boolean, a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (!fuzzy) return isDeepStrictEqual(a, b);
  if (!isNullish(a) && !isNullish(b) && typeof a === typeof b) return isDeepStrictEqual(a, b);
  // Nulo, 0 e "0" contam como iguais.
  if (isNullish(a) && (isNullish(b) || b === 0 || b === '0')) return true;
  if (isNullish(b) && (isNullish(a) || a === 0 || a === '0')) return true;
  // Nulo, texto vazio e lista vazia também.
  if (isFalsy(a) && isFalsy(b)) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  const parsed = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  if (a !== null && typeof a === 'object' && typeof b === 'string') return isDeepStrictEqual(a, parsed(b));
  if (b !== null && typeof b === 'object' && typeof a === 'string') return isDeepStrictEqual(parsed(a), b);
  const boolMatch = (bool: boolean, other: JsonValue) => {
    const s = String(other).toLowerCase();
    return bool ? s === 'true' || s === '1' : s === 'false' || s === '0';
  };
  if (typeof a === 'boolean' && (typeof b === 'string' || typeof b === 'number')) return boolMatch(a, b);
  if (typeof b === 'boolean' && (typeof a === 'string' || typeof a === 'number')) return boolMatch(b, a);
  return isDeepStrictEqual(a, b);
}

function setPath(obj: JsonObject, path: string, value: JsonValue): void {
  const keys = splitPath(path);
  if (!keys.length) return;
  let parent: JsonObject = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(parent[key])) parent[key] = {};
    parent = parent[key] as JsonObject;
  }
  parent[keys[keys.length - 1]!] = value;
}

function commaList(value: JsonValue): string[] {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

export const compareDatasets: NodeType = {
  description: {
    type: 'compareDatasets',
    displayName: 'Compare Datasets',
    description: 'Compara os itens de duas entradas pelos campos escolhidos e separa: só em A, iguais, diferentes e só em B.',
    group: 'logic',
    inputs: 2,
    inputNames: ['A', 'B'],
    outputs: 4,
    outputNames: ['só em A', 'iguais', 'diferentes', 'só em B'],
    properties: [
      {
        name: 'mergeByFields',
        displayName: 'Campos para casar os itens',
        type: 'list',
        default: [{ field1: '', field2: '' }],
        description: 'Itens de A e B com esses campos iguais formam um par; os demais campos dizem se o par é igual ou diferente.',
        fields: [
          { name: 'field1', displayName: 'Campo em A', type: 'string', default: '', placeholder: 'id' },
          { name: 'field2', displayName: 'Campo em B', type: 'string', default: '', placeholder: 'id' },
        ],
      },
      {
        name: 'resolve',
        displayName: 'Quando houver diferenças',
        type: 'options',
        default: 'includeBoth',
        options: [
          { name: 'Usar a versão de A', value: 'preferInput1' },
          { name: 'Usar a versão de B', value: 'preferInput2' },
          { name: 'Misturar as versões', value: 'mix' },
          { name: 'Incluir as duas versões', value: 'includeBoth' },
        ],
      },
      {
        name: 'preferWhenMix',
        displayName: 'Preferir',
        type: 'options',
        default: 'input1',
        showWhen: { resolve: ['mix'] },
        options: [
          { name: 'Versão de A', value: 'input1' },
          { name: 'Versão de B', value: 'input2' },
        ],
      },
      {
        name: 'exceptWhenMix',
        displayName: 'Exceto nos campos',
        type: 'string',
        default: '',
        placeholder: 'ex.: preco, estoque',
        showWhen: { resolve: ['mix'] },
        description: 'Campos, separados por vírgula, que vêm da outra versão.',
      },
      {
        name: 'fuzzyCompare',
        displayName: 'Comparação tolerante',
        type: 'boolean',
        default: false,
        description: 'Tolera pequenas diferenças de tipo: o número 3 e o texto "3" contam como iguais, assim como vazio e nulo.',
      },
      {
        name: 'skipFields',
        displayName: 'Campos que não entram na comparação',
        type: 'string',
        default: '',
        placeholder: 'ex.: atualizado_em, atualizado_por',
        description: 'Separados por vírgula. Aceitam caminho com ponto (ex.: endereco.cep).',
      },
      {
        name: 'multipleMatches',
        displayName: 'Vários pares para o mesmo item',
        type: 'options',
        default: 'first',
        options: [
          { name: 'Usar só o primeiro par', value: 'first' },
          { name: 'Usar todos os pares', value: 'all' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const pairs: Pair[] = asList(await ctx.getParam('mergeByFields', 0)).map((p) => ({ field1: text(p.field1).trim(), field2: text(p.field2).trim() }));
    if (!pairs.length || (pairs.length === 1 && !pairs[0]!.field1 && !pairs[0]!.field2)) {
      throw new NodeOperationError('Informe pelo menos um par de campos para casar os itens');
    }
    pairs.forEach((p, i) => {
      if (!p.field1 || !p.field2) throw new NodeOperationError(`Preencha os dois campos do par ${i + 1} (campo em A = "${p.field1}", campo em B = "${p.field2}")`);
    });
    const resolve = String((await ctx.getParam('resolve', 0)) ?? 'includeBoth');
    const fuzzy = (await ctx.getParam('fuzzyCompare', 0)) === true;
    const skipFields = commaList(await ctx.getParam('skipFields', 0));
    const multiple = (await ctx.getParam('multipleMatches', 0)) === 'all' ? 'all' : 'first';
    const preferWhenMix = resolve === 'mix' ? String(await ctx.getParam('preferWhenMix', 0)) : 'input1';
    const exceptWhenMix = resolve === 'mix' ? commaList(await ctx.getParam('exceptWhenMix', 0)) : [];
    const eq = (a: JsonValue | undefined, b: JsonValue | undefined) => datasetEquals(fuzzy, a, b);

    // Itens vazios não participam, como no n8n.
    const a = (ctx.inputs[0] ?? []).filter((it) => Object.keys(it.json).length > 0);
    const b = (ctx.inputs[1] ?? []).filter((it) => Object.keys(it.json).length > 0);

    const onlyA: Item[] = [];
    const matchedB = new Set<number>();
    const matched: { entry: Item; matches: Item[] }[] = [];

    for (const entry of a) {
      const lookup = pairs.map((p) => ({ path: p.field2, value: getPath(entry.json, p.field1) }));
      if (lookup.some((l) => l.value === undefined)) {
        onlyA.push(entry);
        continue;
      }
      const found: number[] = [];
      for (let j = 0; j < b.length; j++) {
        if (lookup.every((l) => eq(l.value, getPath(b[j]!.json, l.path)))) {
          found.push(j);
          if (multiple === 'first') break;
        }
      }
      found.forEach((j) => matchedB.add(j));
      if (found.length) matched.push({ entry, matches: found.map((j) => b[j]!) });
      else onlyA.push(entry);
    }
    const onlyB = b.filter((_, j) => !matchedB.has(j));

    const same: Item[] = [];
    const different: Item[] = [];
    for (const { entry, matches } of matched) {
      let sameCopy: Item | undefined;
      for (const match of matches) {
        let jsonA = entry.json;
        let jsonB = match.json;
        for (const field of skipFields) {
          jsonA = withoutPath(jsonA, field);
          jsonB = withoutPath(jsonB, field);
        }
        const equal = fuzzy ? Object.keys(jsonA).every((k) => eq(jsonA[k], jsonB[k])) : isDeepStrictEqual(jsonA, jsonB);
        if (equal) {
          sameCopy ??= fuzzy && resolve === 'preferInput2' ? match : entry;
          continue;
        }
        if (resolve === 'preferInput1') different.push(entry);
        else if (resolve === 'preferInput2') different.push(match);
        else if (resolve === 'mix') different.push(mixItems(entry, match, preferWhenMix, exceptWhenMix));
        else different.push(bothVersions(entry, match, pairs, skipFields, fuzzy, eq));
      }
      if (sameCopy) same.push(sameCopy);
    }

    return [onlyA, same, different, onlyB];
  },
};

function mixItems(itemA: Item, itemB: Item, prefer: string, except: string[]): Item {
  const [base, other] = prefer === 'input2' ? [itemB, itemA] : [itemA, itemB];
  const json = structuredClone(base.json);
  for (const field of except) setPath(json, field, getPath(other.json, field) ?? null);
  return { json };
}

function bothVersions(
  itemA: Item,
  itemB: Item,
  pairs: Pair[],
  skipFields: string[],
  fuzzy: boolean,
  eq: (a: JsonValue | undefined, b: JsonValue | undefined) => boolean,
): Item {
  const keys: JsonObject = {};
  for (const p of pairs) keys[p.field1] = getPath(itemA.json, p.field1) ?? null;
  const keysA = Object.keys(itemA.json);
  const keysB = Object.keys(itemB.json);
  const all = [...new Set([...keysA, ...keysB])];
  const toCompare = fuzzy ? all : keysA.filter((k) => keysB.includes(k));

  const same: JsonObject = {};
  for (const key of toCompare) if (eq(itemA.json[key], itemB.json[key])) same[key] = itemA.json[key]!;

  const different: JsonObject = {};
  const skipped: JsonObject = {};
  for (const key of all.filter((k) => !(k in same))) {
    let va: JsonValue = itemA.json[key] ?? null;
    let vb: JsonValue = itemB.json[key] ?? null;
    if (skipFields.includes(key)) {
      skipped[key] = { inputA: va, inputB: vb };
      continue;
    }
    const nested = skipFields.filter((f) => f.startsWith(`${key}.`));
    if (nested.length) {
      if (!isPlainObject(va) || !isPlainObject(vb)) {
        throw new NodeOperationError(`O campo "${key}" não é um objeto nas duas entradas; não dá para ignorar "${nested[0]}"`);
      }
      const skA: JsonObject = {};
      const skB: JsonObject = {};
      for (const field of nested) {
        const inner = field.slice(key.length + 1);
        setPath(skA, inner, getPath(va, inner) ?? null);
        setPath(skB, inner, getPath(vb, inner) ?? null);
        va = withoutPath(va as JsonObject, inner);
        vb = withoutPath(vb as JsonObject, inner);
      }
      skipped[key] = { inputA: skA, inputB: skB };
    }
    different[key] = { inputA: va, inputB: vb };
  }
  const json: JsonObject = { keys, same, different };
  if (Object.keys(skipped).length) json.skipped = skipped;
  return { json };
}

// ---------- Wait ----------

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** O setTimeout aceita no máximo uns 24,8 dias; esperas maiores são feitas em partes. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * Tempo limite padrão do Wait, para o limite do nó não cortar a espera. É o maior valor que o
 * AbortSignal.timeout do executor aceita (uns 24,8 dias); acima disso o Node dispara na hora.
 */
export const WAIT_TIMEOUT_MS = MAX_TIMER_MS;

/** Espera `ms` milissegundos; se o sinal for abortado, limpa o timer e rejeita. */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const canceled = () => (signal.reason instanceof Error ? signal.reason : new NodeOperationError('Espera cancelada'));
    if (signal.aborted) return reject(canceled());
    const end = Date.now() + ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(canceled());
    };
    const tick = () => {
      const left = end - Date.now();
      if (left <= 0) {
        signal.removeEventListener('abort', onAbort);
        return resolve();
      }
      timer = setTimeout(tick, Math.min(left, MAX_TIMER_MS));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    tick();
  });
}

/** Momento de uma data e hora: com fuso no texto (Z, -03:00) vale ele; sem, vale o fuso do nó. */
function parseWaitDateTime(raw: JsonValue, timezone: string): number {
  const value = String(raw ?? '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return at;
  }
  try {
    return parseLocalDateTime(value, timezone);
  } catch (err) {
    if (err instanceof ScheduleError) throw new NodeOperationError(`Não foi possível esperar: ${err.message}`);
    throw err;
  }
}

/** Esperas curtas ficam no worker, como no n8n (abaixo de 65 s a execução não é pausada). */
const IN_PROCESS_WAIT_MS = 65_000;

const WAIT_UNIT_OPTIONS = [
  { name: 'Segundos', value: 'seconds' },
  { name: 'Minutos', value: 'minutes' },
  { name: 'Horas', value: 'hours' },
  { name: 'Dias', value: 'days' },
];

function waitAmountMs(raw: JsonValue, unit: string): number {
  if (!UNIT_MS[unit]) throw new NodeOperationError(`Unidade de espera inválida: ${unit}; use segundos, minutos, horas ou dias`);
  const amount = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new NodeOperationError(`Tempo de espera inválido: ${JSON.stringify(raw)}; informe um número maior ou igual a 0`);
  }
  return amount * UNIT_MS[unit]!;
}

/** Campos do webhook de retomada que o servidor usa (já com as expressões resolvidas). */
const WAIT_WEBHOOK_FIELDS = [
  'httpMethod',
  'authentication',
  'basicAuthConnection',
  'headerAuthConnection',
  'responseMode',
  'responseCode',
  'responseData',
  'responseBinaryPropertyName',
  'responsePropertyName',
  'responseContentType',
  'responseHeaders',
  'noResponseBody',
  'binaryPropertyName',
  'rawBody',
  'ipWhitelist',
  'ignoreBots',
  'webhookSuffix',
];

export const wait: NodeType = {
  description: {
    type: 'wait',
    displayName: 'Wait',
    description: 'Pausa a execução por um tempo, até uma data, até uma chamada de webhook ou até um formulário ser enviado.',
    group: 'logic',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: WAIT_TIMEOUT_MS,
    properties: [
      {
        name: 'resume',
        displayName: 'Continuar',
        type: 'options',
        default: 'timeInterval',
        options: [
          { name: 'Depois de um intervalo', value: 'timeInterval' },
          { name: 'Numa data e hora', value: 'specificTime' },
          { name: 'Quando a URL de retomada for chamada (webhook)', value: 'webhook' },
          { name: 'Quando um formulário for enviado', value: 'form' },
        ],
      },
      { name: 'amount', displayName: 'Esperar', type: 'number', default: 5, showWhen: { resume: ['timeInterval'] } },
      { name: 'unit', displayName: 'Unidade', type: 'options', default: 'seconds', showWhen: { resume: ['timeInterval'] }, options: WAIT_UNIT_OPTIONS },
      {
        name: 'dateTime',
        displayName: 'Data e hora',
        type: 'dateTime',
        default: '',
        required: true,
        showWhen: { resume: ['specificTime'] },
        description: 'Se o momento já passou, o fluxo segue na hora.',
      },
      { name: 'timezone', displayName: 'Fuso horário', type: 'string', default: 'America/Sao_Paulo', showWhen: { resume: ['specificTime'] } },
      // Webhook de retomada: a URL é {{ $execution.resumeUrl }} (mande-a para quem vai chamar).
      { name: 'httpMethod', displayName: 'Método HTTP', type: 'options', default: 'GET', showWhen: { resume: ['webhook'] }, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })) },
      {
        name: 'webhookSuffix',
        displayName: 'Final da URL',
        type: 'string',
        default: '',
        description: 'Opcional: a URL de retomada passa a ser {{ $execution.resumeUrl }}/<final>.',
        showWhen: { resume: ['webhook'] },
      },
      {
        name: 'authentication',
        displayName: 'Autenticação',
        type: 'options',
        default: 'none',
        showWhen: { resume: ['webhook'] },
        options: [
          { name: 'Nenhuma', value: 'none' },
          { name: 'Usuário e senha (Basic)', value: 'basicAuth' },
          { name: 'Header com chave', value: 'headerAuth' },
        ],
      },
      { name: 'basicAuthConnection', displayName: 'Conexão (usuário e senha)', type: 'connection', default: '', connectionTypes: ['httpBasicAuth'], showWhen: { resume: ['webhook'], authentication: ['basicAuth'] } },
      { name: 'headerAuthConnection', displayName: 'Conexão (header)', type: 'connection', default: '', connectionTypes: ['httpHeaderAuth'], showWhen: { resume: ['webhook'], authentication: ['headerAuth'] } },
      {
        name: 'responseMode',
        displayName: 'Responder',
        type: 'options',
        default: 'onReceived',
        showWhen: { resume: ['webhook'] },
        options: [
          { name: 'Logo que receber', value: 'onReceived' },
          { name: 'Quando o último nó terminar', value: 'lastNode' },
          { name: 'Pelo nó Respond to Webhook', value: 'responseNode' },
        ],
      },
      { name: 'responseCode', displayName: 'Código da resposta', type: 'number', default: 200, showWhen: { resume: ['webhook'], responseMode: ['onReceived', 'lastNode'] } },
      {
        name: 'responseData',
        displayName: 'Dados da resposta',
        type: 'options',
        default: 'firstEntryJson',
        showWhen: { resume: ['webhook'], responseMode: ['lastNode'] },
        options: [
          { name: 'JSON do primeiro item', value: 'firstEntryJson' },
          { name: 'Todos os itens (lista de JSON)', value: 'allEntries' },
          { name: 'Arquivo do primeiro item', value: 'firstEntryBinary' },
          { name: 'Sem corpo', value: 'noData' },
        ],
      },
      { name: 'binaryPropertyName', displayName: 'Nome do arquivo recebido', type: 'string', default: 'data', showWhen: { resume: ['webhook'] } },
      { name: 'ipWhitelist', displayName: 'IPs permitidos', type: 'string', default: '', showWhen: { resume: ['webhook'] } },
      { name: 'ignoreBots', displayName: 'Ignorar robôs', type: 'boolean', default: false, showWhen: { resume: ['webhook', 'form'] } },
      // Formulário de retomada: a URL é {{ $execution.resumeFormUrl }}.
      { name: 'formTitle', displayName: 'Título do formulário', type: 'string', default: '', showWhen: { resume: ['form'] } },
      { name: 'formDescription', displayName: 'Descrição', type: 'string', default: '', multiline: true, showWhen: { resume: ['form'] } },
      formFieldsProperty({ resume: ['form'] }),
      { name: 'buttonLabel', displayName: 'Texto do botão', type: 'string', default: 'Enviar', showWhen: { resume: ['form'] } },
      { name: 'customCss', displayName: 'CSS próprio', type: 'string', default: '', multiline: true, showWhen: { resume: ['form'] } },
      { name: 'limitWaitTime', displayName: 'Limitar o tempo de espera', type: 'boolean', default: false, showWhen: { resume: ['webhook', 'form'] } },
      {
        name: 'limitType',
        displayName: 'Limite',
        type: 'options',
        default: 'afterTimeInterval',
        showWhen: { resume: ['webhook', 'form'], limitWaitTime: [true] },
        options: [
          { name: 'Depois de um intervalo', value: 'afterTimeInterval' },
          { name: 'Numa data e hora', value: 'atSpecifiedTime' },
        ],
      },
      { name: 'resumeAmount', displayName: 'Esperar no máximo', type: 'number', default: 1, showWhen: { resume: ['webhook', 'form'], limitWaitTime: [true], limitType: ['afterTimeInterval'] } },
      { name: 'resumeUnit', displayName: 'Unidade', type: 'options', default: 'hours', options: WAIT_UNIT_OPTIONS, showWhen: { resume: ['webhook', 'form'], limitWaitTime: [true], limitType: ['afterTimeInterval'] } },
      { name: 'maxDateAndTime', displayName: 'Até', type: 'dateTime', default: '', showWhen: { resume: ['webhook', 'form'], limitWaitTime: [true], limitType: ['atSpecifiedTime'] } },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const resume = String((await ctx.getParam('resume', 0)) ?? 'timeInterval');

    // Retomada: pelo webhook ou formulário seguem os dados que chegaram; pelo tempo, os mesmos itens.
    if (ctx.resumeData) {
      if ((ctx.resumeData.kind === 'webhook' || ctx.resumeData.kind === 'form') && ctx.resumeData.items) return [ctx.resumeData.items];
      return [input];
    }

    if (resume === 'webhook' || resume === 'form') {
      let until: number | undefined;
      if ((await ctx.getParam('limitWaitTime', 0)) === true) {
        if ((await ctx.getParam('limitType', 0)) === 'atSpecifiedTime') {
          until = parseWaitDateTime(await ctx.getParam('maxDateAndTime', 0), 'America/Sao_Paulo');
        } else {
          until = Date.now() + waitAmountMs(await ctx.getParam('resumeAmount', 0), String(await ctx.getParam('resumeUnit', 0)));
        }
      }
      const config: JsonObject = {};
      if (resume === 'webhook') {
        for (const name of WAIT_WEBHOOK_FIELDS) config[name] = await ctx.getParam(name, 0);
      } else {
        config.form = formToJson({
          title: String((await ctx.getParam('formTitle', 0)) ?? ''),
          description: String((await ctx.getParam('formDescription', 0)) ?? '') || undefined,
          fields: readFormFields(await ctx.getParam('formFields', 0)),
          buttonLabel: String((await ctx.getParam('buttonLabel', 0)) ?? '') || undefined,
          customCss: String((await ctx.getParam('customCss', 0)) ?? '') || undefined,
        });
        config.ignoreBots = await ctx.getParam('ignoreBots', 0);
      }
      ctx.meta.resumeUrl = resume === 'webhook' ? ctx.resumeUrl : ctx.resumeFormUrl;
      if (!ctx.putToWait({ kind: resume, until, config })) {
        throw new NodeOperationError('Esperar um webhook ou formulário não funciona dentro de um subfluxo; ponha o Wait no fluxo principal');
      }
      return [input];
    }

    let ms: number;
    let at: number;
    if (resume === 'specificTime') {
      const timezone = String((await ctx.getParam('timezone', 0)) || 'America/Sao_Paulo');
      at = parseWaitDateTime(await ctx.getParam('dateTime', 0), timezone);
      ms = at - Date.now();
      ctx.meta.waitUntil = new Date(at).toISOString();
    } else {
      ms = waitAmountMs(await ctx.getParam('amount', 0), String(await ctx.getParam('unit', 0)));
      at = Date.now() + ms;
    }
    // Espera longa: a execução pausa e libera a vaga; volta sozinha na hora marcada.
    if (ms >= IN_PROCESS_WAIT_MS && ctx.putToWait({ kind: 'time', until: at })) return [input];
    if (ms > WAIT_TIMEOUT_MS) {
      throw new NodeOperationError(`A espera máxima dentro de um subfluxo é de ${Math.floor(WAIT_TIMEOUT_MS / 86_400_000)} dias; o valor pedido dá ${(ms / 86_400_000).toFixed(1)} dias`);
    }
    if (ms > 0) await waitFor(ms, ctx.signal);
    return [input];
  },
};

// ---------- No Operation ----------

export const noOp: NodeType = {
  description: {
    type: 'noOp',
    displayName: 'No Operation',
    description: 'Não faz nada: repassa os itens como chegaram. Útil para organizar o fluxo.',
    group: 'logic',
    inputs: 1,
    outputs: 1,
    properties: [],
  },
  async execute(ctx) {
    return [ctx.inputs[0] ?? []];
  },
};

// ---------- Execution Data ----------

export const EXECUTION_DATA_LIMITS = { keys: 10, keyLength: 50, valueLength: 512 };

export const executionData: NodeType = {
  description: {
    type: 'executionData',
    displayName: 'Execution Data',
    description: 'Guarda dados importantes na execução, para consultar e filtrar depois. Os itens passam inalterados.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'dataToSave',
        displayName: 'Dados para guardar',
        type: 'list',
        default: [{ key: '', value: '' }],
        description: 'Até 10 pares. A chave usa letras, números e _ (até 50 caracteres); o valor é cortado em 512 caracteres. Com vários itens, vale o do último.',
        fields: [
          { name: 'key', displayName: 'Chave', type: 'string', default: '', placeholder: 'ex.: pedido' },
          { name: 'value', displayName: 'Valor', type: 'string', default: '', placeholder: 'ex.: {{ $json.numero }}' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const saved: JsonObject = {};
    for (let i = 0; i < input.length; i++) {
      for (const row of asList(await ctx.getParam('dataToSave', i))) {
        const rawKey = text(row.key).trim();
        if (!rawKey) continue;
        if (!/^[A-Za-z0-9_]+$/.test(rawKey)) {
          throw new NodeOperationError(`A chave "${rawKey}" só pode ter letras sem acento, números e _`);
        }
        const key = rawKey.slice(0, EXECUTION_DATA_LIMITS.keyLength);
        if (!(key in saved) && Object.keys(saved).length >= EXECUTION_DATA_LIMITS.keys) {
          throw new NodeOperationError(`Dá para guardar no máximo ${EXECUTION_DATA_LIMITS.keys} chaves por execução`);
        }
        saved[key] = text(row.value).slice(0, EXECUTION_DATA_LIMITS.valueLength);
      }
    }
    if (Object.keys(saved).length) ctx.meta.executionData = saved;
    return [input];
  },
};

export const flowExtraNodes: NodeType[] = [filter, switchNode, compareDatasets, wait, noOp, executionData];
