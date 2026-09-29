/**
 * Parser dos campos no modo Expressão.
 *
 * Um campo em modo Expressão é uma string que começa com "=". O restante é um
 * texto que pode conter trechos de JavaScript entre {{ e }}, por exemplo:
 *   "=Bearer {{ $node['Login'].json.token }}"
 */

export type TemplatePart =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string };

export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=');
}

export class TemplateSyntaxError extends Error {}

/**
 * Divide o template em partes de texto e de código. Chaves e aspas dentro do
 * código são respeitadas, então `{{ {a: {b: 1}} }}` funciona.
 */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  let text = '';

  while (i < template.length) {
    if (template.startsWith('{{', i)) {
      if (text) {
        parts.push({ kind: 'text', value: text });
        text = '';
      }
      const end = findCodeEnd(template, i + 2);
      parts.push({ kind: 'code', value: template.slice(i + 2, end).trim() });
      i = end + 2;
    } else {
      text += template[i];
      i++;
    }
  }
  if (text) parts.push({ kind: 'text', value: text });
  return parts;
}

function findCodeEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth === 0 && source[i + 1] === '}') return i;
      depth--;
    }
  }
  throw new TemplateSyntaxError(`Expressão sem "}}" de fechamento: ${source.slice(start - 2)}`);
}
