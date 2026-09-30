import type { ApiField, ApiGroup, ApiProfile, ApiRoute } from './api-reference.js';
import { formatJson } from './lib/format-json.js';

/**
 * Monta a parte das rotas de docs/api.md a partir da referência. O que fica
 * entre as marcas é gerado; o resto do arquivo é escrito à mão.
 */
export const ROUTES_START = '<!-- rotas:inicio -->';
export const ROUTES_END = '<!-- rotas:fim -->';

const PROFILE_LABEL: Record<ApiProfile, string> = {
  public: 'Sem login',
  any: 'Qualquer perfil',
  operator: 'Operador ou acima',
  editor: 'Editor ou acima',
  admin: 'Administrador',
};

const cell = (text: string) => text.replaceAll('|', '\\|');

function fieldRows(fields: ApiField[] | undefined, where: string): string[] {
  return (fields ?? []).map((f) => `| \`${f.name}\` | ${where} | ${cell(f.type)} | ${f.required ? 'sim' : 'não'} | ${cell(f.description)} |`);
}

export function renderRoute(route: ApiRoute): string {
  const lines = [`### ${route.method} /api${route.path}`, '', route.summary, ''];
  lines.push(`**Perfil:** ${PROFILE_LABEL[route.profile]}${route.audited ? ' · registra na auditoria' : ''}`, '');
  const rows = [...fieldRows(route.params, 'caminho'), ...fieldRows(route.query, 'URL'), ...fieldRows(route.body, 'corpo')];
  if (rows.length) {
    lines.push('**Parâmetros**', '', '| Campo | Onde | Tipo | Obrigatório | Descrição |', '| --- | --- | --- | --- | --- |', ...rows, '');
  } else {
    lines.push('**Parâmetros:** nenhum.', '');
  }
  if (route.example?.curl) lines.push('**Exemplo de chamada**', '', '```bash', route.example.curl, '```', '');
  if (route.example || route.response) lines.push('**Exemplo de resposta**', '');
  if (route.response) lines.push(route.response, '');
  if (route.example) lines.push('```json', formatJson(route.example.response), '```', '');
  if (route.example?.note) lines.push(`_${route.example.note}_`, '');
  if (route.errors?.length) lines.push('**Erros próprios**', '', ...route.errors.map((e) => `- ${e}`), '');
  return lines.join('\n');
}

export function renderGroup(group: ApiGroup): string {
  return [`## ${group.title}`, '', ...group.routes.map(renderRoute)].join('\n');
}

/** Troca o que está entre as marcas pelas rotas geradas. */
export function replaceRoutes(doc: string, groups: ApiGroup[]): string {
  const start = doc.indexOf(ROUTES_START);
  const end = doc.indexOf(ROUTES_END);
  if (start < 0 || end < start) throw new Error(`Faltam as marcas ${ROUTES_START} e ${ROUTES_END} no documento`);
  return `${doc.slice(0, start + ROUTES_START.length)}\n\n${groups.map(renderGroup).join('\n')}\n${doc.slice(end)}`;
}
