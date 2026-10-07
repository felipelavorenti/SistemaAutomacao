import type { JsonObject, JsonValue } from '../types.js';
import type { Converted, Ctx, Params } from './import.js';
import { aggregate, isObject, splitOut } from './import.js';

/**
 * Conversores dos nós Limit, Sort, Remove Duplicates, Rename Keys e Summarize do n8n,
 * e do antigo Item Lists (que juntava essas operações num nó só).
 */

const options = (params: Params): Params => (isObject(params.options) ? params.options : {});
const bool = (v: unknown) => v === true || v === 'true';

/** Mantém expressões ("=...") e textos; objetos viram JSON. */
function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Lista de campos do n8n: texto separado por vírgula, lista de textos ou { fields: [{ fieldName }] } (Item Lists v1/v2). */
function fieldList(value: unknown): string {
  if (isObject(value) && Array.isArray(value.fields)) {
    return value.fields
      .filter(isObject)
      .map((f) => String(f.fieldName ?? '').trim())
      .filter(Boolean)
      .join(', ');
  }
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');
  return text(value);
}

function limit({ params }: Ctx): Converted {
  const max = params.maxItems === undefined ? 1 : params.maxItems;
  return {
    type: 'limit',
    parameters: { maxItems: (typeof max === 'number' ? max : text(max)) as JsonValue, keep: params.keep === 'lastItems' ? 'lastItems' : 'firstItems' },
  };
}

function sort({ params, warn }: Ctx): Converted {
  const type = String(params.type ?? 'simple');
  if (type === 'random') return { type: 'sort', parameters: { type: 'random' } };
  if (type === 'code') {
    warn('o código de ordenação veio do n8n; confira se ele roda aqui (as variáveis a e b têm o campo json, como lá)');
    return { type: 'sort', parameters: { type: 'code', code: text(params.code) } };
  }
  const ui = isObject(params.sortFieldsUi) ? params.sortFieldsUi : {};
  const rows = Array.isArray(ui.sortField) ? ui.sortField.filter(isObject) : [];
  return {
    type: 'sort',
    parameters: {
      type: 'simple',
      sortFields: rows.map((r) => ({ fieldName: text(r.fieldName), order: r.order === 'descending' ? 'descending' : 'ascending' })),
      disableDotNotation: bool(options(params).disableDotNotation),
    },
  };
}

function removeDuplicatesInput(params: Params): Converted {
  const opts = options(params);
  const compare = ['allFields', 'allFieldsExcept', 'selectedFields'].includes(String(params.compare)) ? String(params.compare) : 'allFields';
  const parameters: JsonObject = {
    compare,
    disableDotNotation: bool(opts.disableDotNotation),
    removeOtherFields: bool(opts.removeOtherFields),
  };
  if (compare === 'allFieldsExcept') parameters.fieldsToExclude = fieldList(params.fieldsToExclude);
  if (compare === 'selectedFields') parameters.fieldsToCompare = fieldList(params.fieldsToCompare);
  return { type: 'removeDuplicates', parameters };
}

function removeDuplicates({ params, warn }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'removeDuplicateInputItems');
  if (operation === 'removeItemsSeenInPreviousExecutions') {
    warn('a operação "Remove Items Processed in Previous Executions" guarda o histórico entre execuções e ainda não existe aqui');
    return null;
  }
  if (operation === 'clearDeduplicationHistory') {
    warn('a operação "Clear Deduplication History" depende do histórico entre execuções e ainda não existe aqui');
    return null;
  }
  return removeDuplicatesInput(params);
}

function renameKeys({ params }: Ctx): Converted {
  const keys = isObject(params.keys) && Array.isArray(params.keys.key) ? params.keys.key.filter(isObject) : [];
  const additional = isObject(params.additionalOptions) ? params.additionalOptions : {};
  const regex = isObject(additional.regexReplacement) && Array.isArray(additional.regexReplacement.replacements) ? additional.regexReplacement.replacements.filter(isObject) : [];
  return {
    type: 'renameKeys',
    parameters: {
      keys: keys.map((k) => ({ currentKey: text(k.currentKey), newKey: text(k.newKey) })),
      regexReplacements: regex.map((r) => {
        const o = isObject(r.options) ? r.options : {};
        const depth = o.depth === undefined ? -1 : o.depth;
        return {
          searchRegex: text(r.searchRegex),
          replaceRegex: text(r.replaceRegex),
          caseInsensitive: bool(o.caseInsensitive),
          depth: (typeof depth === 'number' ? depth : text(depth)) as JsonValue,
        };
      }),
    },
  };
}

const AGGREGATIONS = ['append', 'average', 'concatenate', 'count', 'countUnique', 'max', 'min', 'sum'];

function summarizeParams(params: Params, version: number): Converted {
  const fts = isObject(params.fieldsToSummarize) && Array.isArray(params.fieldsToSummarize.values) ? params.fieldsToSummarize.values.filter(isObject) : [];
  const opts = options(params);
  return {
    type: 'summarize',
    parameters: {
      fieldsToSummarize: fts.map((f) => ({
        aggregation: AGGREGATIONS.includes(String(f.aggregation)) ? String(f.aggregation) : 'count',
        field: text(f.field),
        includeEmpty: bool(f.includeEmpty),
        separateBy: f.separateBy === undefined ? ',' : text(f.separateBy),
        customSeparator: text(f.customSeparator),
      })),
      fieldsToSplitBy: fieldList(params.fieldsToSplitBy),
      outputFormat: opts.outputFormat === 'singleItem' ? 'singleItem' : 'separateItems',
      skipEmptySplitFields: bool(opts.skipEmptySplitFields),
      disableDotNotation: bool(opts.disableDotNotation),
      // Na versão 1 o padrão era dar erro; a partir da 1.1 o n8n sempre continua.
      continueIfFieldNotFound: version >= 1.1 ? true : bool(opts.continueIfFieldNotFound),
    },
  };
}

function summarize({ params, node }: Ctx): Converted {
  return summarizeParams(params, node.typeVersion ?? 1);
}

/** Item Lists: cada operação vira o nó separado correspondente. */
function itemLists(ctx: Ctx): Converted | null {
  const { params, warn } = ctx;
  const operation = String(params.operation ?? 'splitOutItems');
  switch (operation) {
    case 'limit':
      return limit(ctx);
    case 'sort':
      return sort(ctx);
    case 'removeDuplicates':
      return removeDuplicatesInput(params);
    case 'summarize':
      // O Summarize do Item Lists seguia a versão 1 (erro quando o campo não existe, salvo a opção).
      return summarizeParams(params, 1);
    case 'splitOutItems':
      return splitOut(ctx);
    case 'aggregateItems':
    case 'concatenateItems':
      return aggregate(ctx);
    default:
      warn(`Item Lists: a operação "${operation}" não existe aqui`);
      return null;
  }
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  limit,
  sort,
  removeDuplicates,
  renameKeys,
  summarize,
  itemLists,
};
