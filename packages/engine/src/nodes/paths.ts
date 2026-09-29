import type { JsonObject, JsonValue } from '../types.js';

/** Divide "pedido.itens[0].sku" em ["pedido", "itens", "0", "sku"]. */
export function splitPath(path: string): string[] {
  return path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Lê um campo pelo caminho; devolve undefined se algum trecho não existir. */
export function getPath(obj: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = obj;
  for (const key of splitPath(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

/** Cópia do objeto sem o campo informado pelo caminho. */
export function withoutPath(obj: JsonObject, path: string): JsonObject {
  const keys = splitPath(path);
  if (!keys.length) return obj;
  const copy: JsonObject = structuredClone(obj);
  let parent: JsonValue = copy;
  for (const key of keys.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) return copy;
    parent = parent[key];
  }
  if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) delete parent[keys[keys.length - 1]];
  return copy;
}

export function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
