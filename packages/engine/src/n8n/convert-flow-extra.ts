import type { JsonObject, JsonValue } from '../types.js';
import { type Converted, type Ctx, ifNode, isObject, jsonish, type Params } from './import.js';

/**
 * Conversores do importador do n8n para os nós de fluxo de flow-extra.ts:
 * Filter, Switch, Compare Datasets, Wait, No Operation e Execution Data.
 */

function list(value: unknown): Params[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Ignorar maiúsculas: a opção do nó ou "caseSensitive: false" gravado nas condições. */
function ignoreCaseOf(params: Params, conditionBlocks: unknown[]): boolean {
  const options = isObject(params.options) ? params.options : {};
  if (options.ignoreCase === true) return true;
  return conditionBlocks.some((b) => isObject(b) && isObject(b.options) && b.options.caseSensitive === false);
}

// ---------- Filter ----------

function filter(ctx: Ctx): Converted {
  const converted = ifNode(ctx).parameters;
  let combinator = converted.combinator!;
  // Filter v1 guarda o combinador em "combineConditions" (AND/OR).
  if (ctx.params.combineConditions !== undefined) combinator = String(ctx.params.combineConditions).toLowerCase() === 'or' ? 'or' : 'and';
  const ignoreCase = ignoreCaseOf(ctx.params, [ctx.params.conditions]);
  return { type: 'filter', parameters: { combinator, conditions: converted.conditions!, ignoreCase }, outputMap: (i) => (i === 0 ? 0 : null) };
}

// ---------- Switch ----------

/** Operações do Switch v1/v2 (Rules), por tipo de dado. */
const SWITCH_V1_OPERATIONS: Record<string, string> = {
  equal: 'equals',
  notEqual: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  regex: 'regex',
  larger: 'gt',
  largerEqual: 'gte',
  smaller: 'lt',
  smallerEqual: 'lte',
  after: 'gt',
  before: 'lt',
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Uma condição antiga (value1/operation/value2) no nosso formato. */
function legacyCondition(value1: unknown, operation: string, value2: unknown, warn: (m: string) => void): JsonObject {
  const mapped = SWITCH_V1_OPERATIONS[operation];
  if (mapped) return { left: jsonish(value1), operator: mapped, right: jsonish(value2) };
  const fixed = typeof value2 === 'string' && !value2.startsWith('=');
  if (fixed && operation === 'notStartsWith') return { left: jsonish(value1), operator: 'regex', right: `^(?!${escapeRegex(value2)})` };
  if (fixed && operation === 'notEndsWith') return { left: jsonish(value1), operator: 'regex', right: `^(?![\\s\\S]*${escapeRegex(value2)}$)` };
  warn(`a condição "${operation}" não existe aqui; ficou "é igual a"`);
  return { left: jsonish(value1), operator: 'equals', right: jsonish(value2) };
}

function switchNode(ctx: Ctx): Converted {
  const { params, warn, node } = ctx;
  const version = node.typeVersion ?? 1;
  const mode = params.mode === 'expression' ? 'expression' : 'rules';
  const v3 = version >= 3 || (isObject(params.rules) && Array.isArray(params.rules.values));

  if (mode === 'expression') {
    const numberOutputs = Number(v3 ? (params.numberOutputs ?? 4) : version >= 2 ? (params.outputsAmount ?? 4) : 4) || 4;
    if (numberOutputs > 64) warn('o Switch aqui tem no máximo 64 saídas');
    return { type: 'switch', parameters: { mode, numberOutputs, output: jsonish(params.output ?? '') } };
  }

  if (v3) {
    const options = isObject(params.options) ? params.options : {};
    const rulesRaw = isObject(params.rules) ? list(params.rules.values) : [];
    const rules: JsonObject[] = rulesRaw.map((rule, i) => {
      const converted = ifNode({ ...ctx, params: { conditions: rule.conditions ?? {} } }).parameters.conditions as JsonObject[];
      const block = isObject(rule.conditions) ? rule.conditions : {};
      const count = Array.isArray(block.conditions) ? block.conditions.length : 0;
      if (count > 1) {
        const how = block.combinator === 'or' ? 'OU' : 'E';
        warn(`a regra ${i + 1} tinha ${count} condições combinadas com ${how}; aqui cada regra tem uma condição e ficou só a primeira`);
      }
      const first = converted[0] ?? { left: '', operator: 'equals', right: '' };
      return { ...first, outputKey: rule.renameOutput === false ? '' : str(rule.outputKey) };
    });
    if (!rules.length) rules.push({ left: '', operator: 'equals', right: '', outputKey: '' });

    const parameters: JsonObject = {
      mode,
      rules,
      fallbackOutput: 'none',
      allMatchingOutputs: options.allMatchingOutputs === true,
      ignoreCase: ignoreCaseOf(params, rulesRaw.map((r) => r.conditions)),
    };
    const fallback = options.fallbackOutput;
    if (fallback === 'extra') {
      parameters.fallbackOutput = 'extra';
      if (options.renameFallbackOutput) warn(`a saída extra se chamava "${str(options.renameFallbackOutput)}"; aqui ela se chama "Outros"`);
    } else if (fallback !== undefined && fallback !== 'none' && fallback !== null) {
      parameters.fallbackOutput = 'output';
      parameters.fallbackIndex = Number(fallback) || 0;
    }
    return { type: 'switch', parameters };
  }

  // v1 e v2: um valor comparado com cada regra.
  const rulesRaw = isObject(params.rules) ? list(params.rules.rules) : [];
  const dataType = str(params.dataType || 'number');
  const value1 = params.value1 ?? (dataType === 'boolean' ? false : dataType === 'number' ? 0 : '');
  const defaultOp = dataType === 'number' ? 'smaller' : dataType === 'dateTime' ? 'after' : 'equal';
  const rules: JsonObject[] = rulesRaw.map((rule) => ({
    ...legacyCondition(value1, str(rule.operation || defaultOp), rule.value2 ?? '', warn),
    outputKey: version >= 2 ? str(rule.outputKey) : '',
  }));
  if (dataType === 'dateTime') warn('as datas são comparadas como texto; use o formato ISO (aaaa-mm-ddThh:mm:ss) dos dois lados');
  if (!rules.length) rules.push({ left: jsonish(value1), operator: 'equals', right: '', outputKey: '' });

  const fallback = Number(params.fallbackOutput ?? -1);
  const parameters: JsonObject = { mode, rules, fallbackOutput: 'none', allMatchingOutputs: false, ignoreCase: false };

  if (version >= 2) {
    // v2: cada regra já é a saída de mesmo número.
    if (fallback >= 0) {
      parameters.fallbackOutput = 'output';
      parameters.fallbackIndex = fallback;
    }
    return { type: 'switch', parameters };
  }

  // v1: 4 saídas fixas e cada regra diz para qual delas vai. Aqui cada regra é uma saída.
  const outputs = rulesRaw.map((r) => Number(r.output ?? 0) || 0);
  const firstRuleOf = (n8nIndex: number) => outputs.indexOf(n8nIndex);
  const shared = [...new Set(outputs.filter((o, i) => outputs.indexOf(o) !== i))];
  if (shared.length) {
    warn(`várias regras iam para a mesma saída (${shared.map((o) => o).join(', ')}); aqui cada regra tem a sua e só a primeira ficou ligada; ligue as outras`);
  }
  let extraFor: number | null = null;
  if (fallback >= 0) {
    const ruleIndex = firstRuleOf(fallback);
    if (ruleIndex >= 0) {
      parameters.fallbackOutput = 'output';
      parameters.fallbackIndex = ruleIndex;
    } else {
      parameters.fallbackOutput = 'extra';
      extraFor = fallback;
    }
  }
  const outputMap = (n8nIndex: number): number | null => {
    if (extraFor !== null && n8nIndex === extraFor) return rules.length;
    const ruleIndex = firstRuleOf(n8nIndex);
    return ruleIndex >= 0 ? ruleIndex : null;
  };
  return { type: 'switch', parameters, outputMap };
}

// ---------- Compare Datasets ----------

function compareDatasets({ params, warn, node }: Ctx): Converted {
  const version = node.typeVersion ?? 1;
  const options = isObject(params.options) ? params.options : {};
  const pairs = isObject(params.mergeByFields) ? list(params.mergeByFields.values) : [];
  const mergeByFields = (pairs.length ? pairs : [{ field1: '', field2: '' }]).map((p) => ({ field1: str(p.field1), field2: str(p.field2) }));
  const resolve = str(params.resolve || (version <= 2 ? 'preferInput2' : 'includeBoth'));
  const fuzzyCompare = (version < 2 ? options.fuzzyCompare : params.fuzzyCompare) === true;
  const parameters: JsonObject = {
    mergeByFields,
    resolve,
    fuzzyCompare,
    skipFields: str(options.skipFields),
    multipleMatches: options.multipleMatches === 'all' ? 'all' : 'first',
  };
  if (resolve === 'mix') {
    parameters.preferWhenMix = params.preferWhenMix === 'input2' ? 'input2' : 'input1';
    parameters.exceptWhenMix = str(params.exceptWhenMix);
  }
  if (options.disableDotNotation === true) warn('a opção "Disable Dot Notation" não existe aqui; nomes com ponto são lidos como caminho (ex.: endereco.cep)');
  if (version < 2.2) warn('versão antiga do Compare Datasets: aqui os itens vazios são ignorados e campo ausente não gera erro, como nas versões novas do n8n');
  return { type: 'compareDatasets', parameters };
}

// ---------- Wait ----------

/** Data com fuso (Z ou ±hh:mm) escrita na hora local do fuso informado, sem fuso. */
function toLocalDateTime(value: string, timezone: string): string | null {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    const ms = at % 1000 ? `.${String(((at % 1000) + 1000) % 1000).padStart(3, '0')}` : '';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${ms}`;
  } catch {
    return null;
  }
}

function wait({ params, warn, node, timezone }: Ctx): Converted | null {
  const version = node.typeVersion ?? 1;
  const resume = str(params.resume || 'timeInterval');
  if (resume === 'webhook' || resume === 'form') {
    warn(`o Wait do n8n esperava ${resume === 'webhook' ? 'uma chamada de webhook' : 'o envio de um formulário'}; retomar por webhook ou formulário ainda não existe aqui`);
    return null;
  }
  if (resume === 'specificTime') {
    const raw = params.dateTime;
    let dateTime: JsonValue = jsonish(raw ?? '');
    if (typeof raw === 'string' && raw.startsWith('=')) {
      warn('a data do Wait é uma expressão; ela precisa devolver aaaa-mm-ddThh:mm:ss (no fuso do nó) ou uma data ISO com fuso');
    } else if (typeof raw === 'string' && /(Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim())) {
      dateTime = toLocalDateTime(raw.trim(), timezone) ?? raw;
    } else if (typeof raw === 'string') {
      // Sem fuso: tira os milissegundos extras e o espaço do formato aceito.
      dateTime = raw.trim().replace(' ', 'T');
    }
    return { type: 'wait', parameters: { resume: 'specificTime', dateTime, timezone } };
  }
  const amount = params.amount ?? (version >= 1.1 ? 5 : 1);
  const unit = str(params.unit || (version >= 1.1 ? 'seconds' : 'hours'));
  return { type: 'wait', parameters: { resume: 'timeInterval', amount: typeof amount === 'string' ? amount : Number(amount), unit } };
}

// ---------- No Operation e Execution Data ----------

function executionData({ params, warn }: Ctx): Converted {
  const values = isObject(params.dataToSave) ? list(params.dataToSave.values) : [];
  const dataToSave = values.map((v) => ({ key: str(v.key), value: jsonish(v.value ?? '') }));
  if (dataToSave.length > 10) warn('o n8n guarda no máximo 10 chaves por execução; aqui também, e as excedentes dão erro');
  return { type: 'executionData', parameters: { dataToSave: dataToSave.length ? dataToSave : [{ key: '', value: '' }] } };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  filter,
  switch: switchNode,
  compareDatasets,
  wait,
  noOp: () => ({ type: 'noOp', parameters: {} }),
  executionData,
};
