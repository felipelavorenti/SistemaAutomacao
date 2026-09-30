/** JSON numa linha, com espaço depois de : e de vírgula. */
function flat(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flat).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${flat(item)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

/**
 * JSON com recuo de dois espaços para ler na documentação. Objetos e listas
 * que cabem na largura ficam numa linha só, para o exemplo não virar uma
 * coluna comprida.
 */
export function formatJson(value: unknown, width = 100): string {
  const write = (item: unknown, indent: string, column: number): string => {
    const line = flat(item);
    if (item === null || typeof item !== 'object' || column + line.length < width) return line;
    const inner = `${indent}  `;
    const lines = Array.isArray(item)
      ? item.map((child) => inner + write(child, inner, inner.length))
      : Object.entries(item).map(([key, child]) => {
          const prefix = `${inner}${JSON.stringify(key)}: `;
          return prefix + write(child, inner, prefix.length);
        });
    if (!lines.length) return line;
    const [open, close] = Array.isArray(item) ? ['[', ']'] : ['{', '}'];
    return `${open}\n${lines.join(',\n')}\n${indent}${close}`;
  };
  return write(value, '', 0);
}
