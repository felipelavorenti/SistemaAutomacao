import type { JsonValue } from '../types.js';

export type Dialect = 'postgres' | 'mssql' | 'oracle';

/**
 * Troca os parâmetros nomeados (:nome) pelo formato de cada banco, ignorando
 * textos entre aspas, comentários e o cast do Postgres (::tipo).
 */
export function compileNamedParams(sql: string, dialect: Dialect): { sql: string; names: string[] } {
  const names: string[] = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      const end = findClosing(sql, i, c);
      out += sql.slice(i, end);
      i = end;
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === ':' && next === ':') {
      out += '::';
      i += 2;
    } else if (c === ':' && /[A-Za-z_]/.test(next ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!names.includes(name)) names.push(name);
      if (dialect === 'postgres') out += `$${names.indexOf(name) + 1}`;
      else if (dialect === 'mssql') out += `@${name}`;
      else out += `:${name}`;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return { sql: out, names };
}

function findClosing(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** Nome de tabela, coluna ou procedure: letras, números, _ $ # e ponto (schema.nome). */
export function checkIdentifier(name: string, what: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][\w$#]*(\.[A-Za-z_][\w$#]*){0,2}$/.test(trimmed)) {
    throw new Error(`${what} inválido: "${name}". Use só letras, números, _ e ponto para o schema.`);
  }
  return trimmed;
}

/** Valores de parâmetro: objetos e listas vão como JSON em texto. */
export function toDbValue(value: JsonValue | undefined): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** Parâmetros por comando: o Postgres aceita 65.535, o SQL Server 2.100 (e 1.000 linhas no VALUES), o Oracle 999 colunas no INSERT ALL. */
const INSERT_PARAM_LIMIT: Record<Dialect, number> = { postgres: 60_000, mssql: 2_000, oracle: 999 };
const INSERT_ROW_LIMIT: Record<Dialect, number> = { postgres: 10_000, mssql: 1_000, oracle: 10_000 };

/** Quantas linhas cabem num INSERT, no máximo `wanted`, respeitando os limites do banco. Sempre pelo menos 1. */
export function insertBatchRows(dialect: Dialect, columnCount: number, wanted: number): number {
  const byParams = Math.floor(INSERT_PARAM_LIMIT[dialect] / Math.max(1, columnCount));
  return Math.max(1, Math.min(Math.floor(wanted), byParams, INSERT_ROW_LIMIT[dialect]));
}

/**
 * INSERT de `rowCount` linhas num comando só. Os parâmetros são :p0, :p1... para uma linha (como antes dos
 * lotes) e :p0_0, :p0_1... (linha_coluna) para várias. O Oracle não tem VALUES com várias linhas nas versões
 * antigas: usa INSERT ALL.
 */
export function buildInsertSql(dialect: Dialect, table: string, columns: string[], rowCount: number): string {
  const name = (row: number, col: number) => (rowCount === 1 ? `:p${col}` : `:p${row}_${col}`);
  const values = (row: number) => `(${columns.map((_, col) => name(row, col)).join(', ')})`;
  const list = columns.join(', ');
  const rows = Array.from({ length: rowCount }, (_, row) => row);
  if (dialect === 'oracle' && rowCount > 1) {
    return `INSERT ALL ${rows.map((row) => `INTO ${table} (${list}) VALUES ${values(row)}`).join(' ')} SELECT 1 FROM DUAL`;
  }
  return `INSERT INTO ${table} (${list}) VALUES ${rows.map(values).join(', ')}`;
}

/** Os valores das linhas, com os nomes que o `buildInsertSql` usa. */
export function insertParams(rows: JsonValue[][]): Record<string, JsonValue> {
  const params: Record<string, JsonValue> = {};
  rows.forEach((values, row) => values.forEach((value, col) => (params[rows.length === 1 ? `p${col}` : `p${row}_${col}`] = value)));
  return params;
}
