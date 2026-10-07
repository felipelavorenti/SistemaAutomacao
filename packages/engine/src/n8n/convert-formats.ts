import type { JsonObject, JsonValue } from '../types.js';
import { DATE_OUTPUT_DEFAULTS } from '../nodes/formats.js';
import { isObject, jsonish, type Converted, type Ctx, type Params } from './import.js';

/**
 * Conversores do importador do n8n para os nós de formatos: Date & Time (V1 e V2), Crypto,
 * HTML (e o antigo HTML Extract), Markdown, XML e TOTP.
 */

const opts = (params: Params, key = 'options'): Params => (isObject(params[key]) ? (params[key] as Params) : {});
const has = (o: Params, key: string) => o[key] !== undefined && o[key] !== null;
/** Valor simples do n8n para o nosso (expressões "={{ }}" passam iguais). */
const v = (value: unknown, fallback: JsonValue): JsonValue => (value === undefined || value === null ? fallback : jsonish(value));
const bool = (value: unknown, fallback: boolean): JsonValue => (value === undefined || value === null ? fallback : typeof value === 'string' && value.startsWith('=') ? value : value === true || value === 'true');

// ---------- Date & Time ----------

const MOMENT_PRESETS: Record<string, string> = {
  'MM/DD/YYYY': 'MM/dd/yyyy',
  'YYYY/MM/DD': 'yyyy/MM/dd',
  'MMMM DD YYYY': 'MMMM dd yyyy',
  'MM-DD-YYYY': 'MM-dd-yyyy',
  'YYYY-MM-DD': 'yyyy-MM-dd',
  X: 'X',
  x: 'x',
};

const MOMENT_TOKENS: [string, string][] = [
  ['YYYY', 'yyyy'],
  ['YY', 'yy'],
  ['dddd', 'cccc'],
  ['ddd', 'ccc'],
  ['Do', 'd'],
  ['DDDD', 'ooo'],
  ['DD', 'dd'],
  ['D', 'd'],
  ['MMMM', 'MMMM'],
  ['MMM', 'MMM'],
  ['MM', 'MM'],
  ['M', 'M'],
  ['HH', 'HH'],
  ['H', 'H'],
  ['hh', 'hh'],
  ['h', 'h'],
  ['mm', 'mm'],
  ['m', 'm'],
  ['ss', 'ss'],
  ['s', 's'],
  ['SSS', 'SSS'],
  ['SS', 'SS'],
  ['S', 'S'],
  ['A', 'a'],
  ['a', 'a'],
  ['ZZ', 'ZZZ'],
  ['Z', 'ZZ'],
  ['X', 'X'],
  ['x', 'x'],
  ['E', 'c'],
  ['e', 'c'],
  ['WW', 'WW'],
  ['W', 'W'],
  ['Q', 'q'],
];

/** Formato do moment (Date & Time V1) para tokens do luxon; texto livre vai entre aspas simples. */
export function momentToLuxon(format: string): string {
  let out = '';
  let literal = '';
  const flush = () => {
    if (literal) out += `'${literal.replace(/'/g, "''")}'`;
    literal = '';
  };
  for (let i = 0; i < format.length; ) {
    if (format[i] === '[') {
      const end = format.indexOf(']', i);
      if (end > i) {
        literal += format.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    const token = MOMENT_TOKENS.find(([m]) => format.startsWith(m, i));
    if (token) {
      flush();
      out += token[1];
      i += token[0].length;
      continue;
    }
    const ch = format[i]!;
    if (/[A-Za-z]/.test(ch)) literal += ch;
    else {
      flush();
      out += ch === "'" ? "''" : ch;
    }
    i++;
  }
  flush();
  return out;
}

function dateTime(ctx: Ctx): Converted | null {
  const { params, warn, node, timezone } = ctx;
  if ((node.typeVersion ?? 1) < 2) return dateTimeV1(ctx);
  const operation = String(params.operation ?? 'getCurrentDate');
  if (!DATE_OUTPUT_DEFAULTS[operation]) {
    warn(`a operação "${operation}" do Date & Time não existe aqui`);
    return null;
  }
  const o = opts(params);
  const p: JsonObject = {
    operation,
    outputFieldName: v(params.outputFieldName, DATE_OUTPUT_DEFAULTS[operation]!),
    includeInputFields: bool(o.includeInputFields, false),
    timezone,
  };
  switch (operation) {
    case 'getCurrentDate':
      p.includeTime = bool(params.includeTime, true);
      if (typeof o.timezone === 'string' && o.timezone.trim()) p.timezone = o.timezone.trim();
      break;
    case 'addToDate':
    case 'subtractFromDate':
      p.magnitude = v(params.magnitude, '');
      p.timeUnit = v(params.timeUnit, 'days');
      p.duration = v(params.duration, 0);
      break;
    case 'formatDate':
      p.date = v(params.date, '');
      p.format = v(params.format, 'MM/dd/yyyy');
      if (p.format === 'custom') p.customFormat = v(params.customFormat, '');
      if (typeof o.fromFormat === 'string' && o.fromFormat !== 'e.g yyyyMMdd') p.fromFormat = o.fromFormat;
      p.useWorkflowTimezone = bool(o.timezone, false);
      break;
    case 'roundDate':
      p.date = v(params.date, '');
      p.mode = v(params.mode, 'roundDown');
      p.toNearest = v(params.toNearest, 'month');
      p.to = v(params.to, 'month');
      break;
    case 'getTimeBetweenDates':
      p.startDate = v(params.startDate, '');
      p.endDate = v(params.endDate, '');
      p.units = Array.isArray(params.units) ? params.units.map(String) : typeof params.units === 'string' ? params.units : ['day'];
      p.isoString = bool(o.isoString, false);
      break;
    case 'extractDate':
      p.date = v(params.date, '');
      p.part = v(params.part, 'month');
      break;
  }
  return { type: 'dateTime', parameters: p };
}

function dateTimeV1({ params, warn, timezone }: Ctx): Converted | null {
  const action = String(params.action ?? 'format');
  const o = opts(params);
  const base: JsonObject = { outputFieldName: v(params.dataPropertyName, 'data'), includeInputFields: true, timezone };
  if (typeof params.dataPropertyName === 'string' && params.dataPropertyName.includes('.')) warn('o campo de saída tinha pontos (campo dentro de campo); aqui o nome é usado como está');
  if (o.fromFormat) {
    base.fromFormat = momentToLuxon(String(o.fromFormat));
    warn('o formato de entrada era do moment e foi traduzido para o luxon; confira');
  }
  if (action === 'calculate') {
    const operation = params.operation === 'subtract' ? 'subtractFromDate' : 'addToDate';
    if (base.fromFormat) {
      warn('o formato da data de entrada só existe na operação de formatar; a data agora precisa estar num formato reconhecido');
      delete base.fromFormat;
    }
    warn('Date & Time V1: o resultado agora sai em ISO com o fuso do nó (antes saía em UTC)');
    return {
      type: 'dateTime',
      parameters: { ...base, operation, magnitude: v(params.value, ''), timeUnit: v(params.timeUnit, 'days'), duration: v(params.duration, 0) },
    };
  }
  if (action !== 'format') return null;
  const toFormat = String(params.toFormat ?? 'MM/DD/YYYY');
  const custom = params.custom === true;
  const preset = !custom ? MOMENT_PRESETS[toFormat] : undefined;
  const p: JsonObject = { ...base, operation: 'formatDate', date: v(params.value, '') };
  if (preset) p.format = preset;
  else {
    p.format = 'custom';
    p.customFormat = toFormat.startsWith('=') ? toFormat : momentToLuxon(toFormat);
    if (!toFormat.startsWith('=')) warn(`o formato "${toFormat}" era do moment e virou "${String(p.customFormat)}" no luxon; confira`);
    else warn('o formato vinha de uma expressão com tokens do moment; troque para tokens do luxon');
  }
  const to = typeof o.toTimezone === 'string' ? o.toTimezone : '';
  const from = typeof o.fromTimezone === 'string' ? o.fromTimezone : '';
  if (to || from) {
    p.useWorkflowTimezone = true;
    p.timezone = to || from || timezone;
    if (from && to && from !== to) warn(`a data era lida no fuso ${from} e convertida para ${to}; aqui ela é lida e formatada em ${to} (datas sem fuso explícito podem mudar)`);
  } else {
    p.useWorkflowTimezone = true;
    warn('Date & Time V1 formatava no fuso do servidor do n8n; aqui formata no fuso do fluxo (opção "Usar o fuso horário do nó" ligada)');
  }
  return { type: 'dateTime', parameters: p };
}

// ---------- Crypto ----------

function crypto({ params, warn, node }: Ctx): Converted | null {
  const action = String(params.action ?? 'hash');
  const version = node.typeVersion ?? 1;
  if (action === 'encrypt' || action === 'decrypt') {
    warn(`a ação "${action}" do Crypto ainda não existe aqui`);
    return null;
  }
  if ((action === 'hash' || action === 'hmac') && params.binaryData === true) {
    warn('o Crypto calculava o hash de um arquivo (dado binário), o que ainda não existe aqui');
    return null;
  }
  const p: JsonObject = { action, dataPropertyName: v(params.dataPropertyName, 'data') };
  switch (action) {
    case 'hash':
      p.type = v(params.type, version >= 2 ? 'SHA256' : 'MD5');
      p.value = v(params.value, '');
      p.encoding = v(params.encoding, 'hex');
      break;
    case 'hmac':
      p.type = v(params.type, version >= 2 ? 'SHA256' : 'MD5');
      p.value = v(params.value, '');
      p.encoding = v(params.encoding, 'hex');
      p.secret = v(params.secret, '');
      if (version >= 2 || !params.secret) warn('o segredo do HMAC estava na credencial do n8n, que não vem na exportação; preencha o campo "Segredo"');
      break;
    case 'sign':
      p.value = v(params.value, '');
      p.algorithm = v(params.algorithm, 'RSA-SHA256');
      p.encoding = v(params.encoding, 'hex');
      p.connection = '';
      warn('cadastre a chave privada como conexão do tipo "Chave privada" e escolha no nó');
      break;
    case 'generate':
      p.encodingType = v(params.encodingType, 'uuid');
      p.stringLength = v(params.stringLength, 32);
      break;
    default:
      warn(`a ação "${action}" do Crypto não existe aqui`);
      return null;
  }
  return { type: 'crypto', parameters: p };
}

// ---------- HTML ----------

function extractionRows(value: unknown): JsonObject[] {
  const list = isObject(value) && Array.isArray(value.values) ? value.values : Array.isArray(value) ? value : [];
  return list.filter(isObject).map((r) => ({
    key: v(r.key, ''),
    cssSelector: v(r.cssSelector, ''),
    returnValue: v(r.returnValue, 'text'),
    attribute: v(r.attribute, ''),
    skipSelectors: v(r.skipSelectors, ''),
    returnArray: bool(r.returnArray, false),
  }));
}

function extract(ctx: Ctx, oldText: boolean): Converted | null {
  const { params, warn } = ctx;
  if ((params.sourceData ?? 'json') === 'binary') {
    warn('o HTML vinha de um arquivo (dado binário), o que ainda não existe aqui');
    return null;
  }
  const o = opts(params);
  const rows = extractionRows(params.extractionValues);
  if (oldText && rows.some((r) => r.returnValue === 'text')) warn('a extração de texto agora segue a versão nova do nó HTML do n8n (blocos viram linhas); confira os valores');
  return {
    type: 'html',
    parameters: {
      operation: 'extractHtmlContent',
      sourceData: 'json',
      dataPropertyName: v(params.dataPropertyName, 'data'),
      extractionValues: rows.length ? rows : [{ key: '', cssSelector: '', returnValue: 'text', attribute: '', skipSelectors: '', returnArray: false }],
      trimValues: bool(o.trimValues, true),
      cleanUpText: bool(o.cleanUpText, true),
    },
  };
}

function html(ctx: Ctx): Converted | null {
  const { params, node, warn } = ctx;
  const operation = String(params.operation ?? 'generateHtmlTemplate');
  if (operation === 'extractHtmlContent') return extract(ctx, (node.typeVersion ?? 1) < 1.2);
  if (operation === 'convertToHtmlTable') {
    const o = opts(params);
    const p: JsonObject = { operation };
    p.capitalize = bool(o.capitalize, false);
    p.customStyling = bool(o.customStyling, false);
    for (const key of ['caption', 'tableAttributes', 'headerAttributes', 'rowAttributes', 'cellAttributes']) p[key] = v(o[key], '');
    return { type: 'html', parameters: p };
  }
  if (operation === 'generateHtmlTemplate') {
    const p: JsonObject = { operation };
    if (typeof params.html === 'string') {
      // No n8n o modelo sempre resolve {{ }}; aqui isso pede o modo Expressão.
      p.html = params.html.includes('{{') && !params.html.startsWith('=') ? `=${params.html}` : params.html;
    }
    return { type: 'html', parameters: p };
  }
  warn(`a operação "${operation}" do HTML não existe aqui`);
  return null;
}

// ---------- Markdown ----------

const SHOWDOWN_SUPPORTED = new Set([
  'openLinksInNewWindow',
  'simplifiedAutoLink',
  'excludeTrailingPunctuationFromURLs',
  'simpleLineBreaks',
  'tables',
  'strikethrough',
  'tasklists',
  'emoji',
  'completeHTMLDocument',
  'noHeaderId',
  'ghCompatibleHeaderId',
  'literalMidWordUnderscores',
  'literalMidWordAsterisks',
  'parseImgDimensions',
  'encodeEmails',
  'ghCodeBlocks',
  'backslashEscapesHTMLTags',
  'requireSpaceBeforeHeadingText',
  'splitAdjacentBlockquotes',
  'headerLevelStart',
  'prefixHeaderId',
]);

function markdown({ params, warn }: Ctx): Converted | null {
  const mode = String(params.mode ?? 'htmlToMarkdown');
  const o = opts(params);
  const p: JsonObject = { mode, destinationKey: v(params.destinationKey, 'data') };
  if (mode === 'markdownToHtml') {
    p.markdown = v(params.markdown, '');
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(o)) {
      if (SHOWDOWN_SUPPORTED.has(key)) p[key] = jsonish(value);
      else skipped.push(key);
    }
    if (skipped.length) warn(`as opções ${skipped.map((k) => `"${k}"`).join(', ')} do Markdown não existem aqui`);
    return { type: 'markdown', parameters: p };
  }
  if (mode !== 'htmlToMarkdown') return null;
  p.html = v(params.html, '');
  for (const key of ['bulletMarker', 'codeFence', 'emDelimiter', 'strongDelimiter', 'ignore', 'blockElements', 'keepDataImages', 'maxConsecutiveNewlines', 'useLinkReferenceDefinitions']) {
    if (has(o, key)) p[key] = jsonish(o[key]);
  }
  if (has(o, 'codeBlockStyle')) {
    p.codeBlockStyle = jsonish(o.codeBlockStyle);
    if (o.codeBlockStyle === 'fence') warn('no n8n a opção "Fence" dos blocos de código saía recuada por um defeito; aqui ela sai com ```');
  }
  const replaces = isObject(o.textReplace) && Array.isArray(o.textReplace.values) ? o.textReplace.values.filter(isObject) : [];
  if (replaces.length) p.textReplace = replaces.map((r) => ({ pattern: v(r.pattern, ''), replacement: v(r.replacement, '') }));
  if (isObject(o.globalEscape) || isObject(o.lineStartEscape)) warn('os padrões de escape (Global/Line Start Escape) do Markdown não existem aqui');
  return { type: 'markdown', parameters: p };
}

// ---------- XML ----------

const XML_KEYS: Record<string, string[]> = {
  xmlToJson: ['attrkey', 'charkey', 'explicitArray', 'explicitRoot', 'ignoreAttrs', 'mergeAttrs', 'normalize', 'normalizeTags', 'trim'],
  jsonToxml: ['attrkey', 'charkey', 'rootName', 'headless', 'cdata', 'allowSurrogateChars'],
};

function xml({ params, warn }: Ctx): Converted | null {
  const mode = String(params.mode ?? 'xmlToJson');
  if (!XML_KEYS[mode]) {
    warn(`o modo "${mode}" do XML não existe aqui`);
    return null;
  }
  const o = opts(params);
  const p: JsonObject = { mode, dataPropertyName: v(params.dataPropertyName, 'data') };
  for (const key of XML_KEYS[mode]!) if (has(o, key)) p[key] = jsonish(o[key]);
  return { type: 'xml', parameters: p };
}

// ---------- TOTP ----------

function totp({ params, warn }: Ctx): Converted | null {
  const o = opts(params);
  warn('cadastre o segredo do TOTP como conexão do tipo "TOTP" e escolha no nó');
  return {
    type: 'totp',
    parameters: {
      operation: 'generateSecret',
      connection: '',
      algorithm: v(o.algorithm, 'SHA1'),
      digits: v(o.digits, 6),
      period: v(o.period, 30),
    },
  };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  dateTime,
  crypto,
  html,
  htmlExtract: (ctx) => extract(ctx, true),
  markdown,
  xml,
  totp,
};
