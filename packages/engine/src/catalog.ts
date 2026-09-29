import type { JsonObject, JsonValue } from './types.js';

/** Variável que um endpoint do catálogo pede ao nó. */
export interface ApiVariable {
  name: string;
  label?: string;
  type: 'text' | 'number' | 'boolean' | 'json';
  required: boolean;
  default?: string;
}

export type ApiAuthType = 'none' | 'bearer' | 'basic' | 'header';

/** Endpoint do catálogo já combinado com o cadastro do cliente no ERP. */
export interface ApiEndpointData {
  erpName: string;
  endpointName: string;
  clientName: string;
  baseUrl: string;
  authType: ApiAuthType;
  authHeader?: string | null;
  usesAuth: boolean;
  method: string;
  path: string;
  headers: { name: string; value: string }[];
  query: { name: string; value: string }[];
  bodyType: 'none' | 'json' | 'form' | 'text';
  body: string;
  variables: ApiVariable[];
  /** Host, porta, usuário, senha e outros campos do cliente no ERP (já descriptografados). */
  clientValues: JsonObject;
}

/** Variável "token" que os endpoints com autenticação Bearer ou header pedem. */
export const TOKEN_VARIABLE: ApiVariable = { name: 'token', label: 'Token (do nó de login)', type: 'text', required: true };

/** Variáveis que o nó precisa preencher para este endpoint. */
export function endpointVariables(endpoint: Pick<ApiEndpointData, 'variables' | 'authType' | 'usesAuth'>): ApiVariable[] {
  const list = [...endpoint.variables];
  if (endpoint.usesAuth && (endpoint.authType === 'bearer' || endpoint.authType === 'header') && !list.some((v) => v.name === 'token')) {
    list.push(TOKEN_VARIABLE);
  }
  return list;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;

export class TemplateError extends Error {}

function lookup(vars: Record<string, JsonValue | undefined>, name: string): JsonValue {
  if (!(name in vars)) throw new TemplateError(`A variável {{${name}}} não existe no cadastro do cliente nem no endpoint`);
  return vars[name] ?? null;
}

function asText(value: JsonValue): string {
  if (value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Troca {{nome}} pelos valores, como texto. */
export function fillTemplate(template: string, vars: Record<string, JsonValue | undefined>, encode?: (s: string) => string): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const text = asText(lookup(vars, name));
    return encode ? encode(text) : text;
  });
}

/**
 * Modelo de corpo JSON: um texto que é só "{{nome}}" recebe o valor com o tipo
 * original (número, lista, objeto); nos demais, o valor entra como texto.
 */
export function fillJsonTemplate(template: string, vars: Record<string, JsonValue | undefined>): JsonValue {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(template) as JsonValue;
  } catch {
    throw new TemplateError('O modelo do corpo JSON do endpoint não é um JSON válido');
  }
  const walk = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      const whole = /^\{\{\s*([A-Za-z_][\w]*)\s*\}\}$/.exec(value);
      return whole ? lookup(vars, whole[1]) : fillTemplate(value, vars);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) out[fillTemplate(k, vars)] = walk(v);
      return out;
    }
    return value;
  };
  return walk(parsed);
}

/** Converte o valor informado no nó para o tipo da variável. */
export function coerceVariable(variable: ApiVariable, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null || value === '') {
    if (variable.default !== undefined && variable.default !== '') return coerceVariable({ ...variable, default: undefined }, variable.default);
    if (variable.required) throw new TemplateError(`Preencha a variável "${variable.label || variable.name}"`);
    return variable.type === 'text' ? '' : null;
  }
  if (variable.type === 'number' && typeof value === 'string') {
    const n = Number(value.replace(',', '.'));
    if (Number.isNaN(n)) throw new TemplateError(`A variável "${variable.label || variable.name}" precisa ser um número; recebeu "${value}"`);
    return n;
  }
  if (variable.type === 'boolean' && typeof value === 'string') return value === 'true';
  if (variable.type === 'json' && typeof value === 'string') {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      throw new TemplateError(`A variável "${variable.label || variable.name}" precisa ser um JSON válido`);
    }
  }
  return value;
}
