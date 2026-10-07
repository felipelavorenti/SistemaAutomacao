import type { JsonValue } from '../types.js';

/** Conversões de parâmetros usadas pelos nós de servidor e protocolos (Fase 4). */
export const str = (value: JsonValue | undefined, fallback = ''): string =>
  value === undefined || value === null ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value);
export const bool = (value: JsonValue | undefined, fallback = false): boolean =>
  value === undefined || value === null || value === '' ? fallback : value === true || value === 'true';
export const num = (value: JsonValue | undefined, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return value === '' || value === null || value === undefined || !Number.isFinite(n) ? fallback : n;
};
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Converte o resultado de uma biblioteca (datas, Buffers etc.) em JSON simples. */
export const toJson = <T extends JsonValue = JsonValue>(value: unknown): T => JSON.parse(JSON.stringify(value ?? null)) as T;
