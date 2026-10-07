import { toBinary } from './binary.js';
import type { PropertyDescription } from './node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue } from './types.js';

/**
 * Formulários do Form Trigger, do Form e do Wait "Quando um formulário for enviado", no estilo do
 * n8n: a página é montada no servidor (HTML simples, sem JavaScript de terceiros) e o envio vira um
 * item com um campo por pergunta, `submittedAt` e `formMode`.
 */

export type FormFieldType = 'text' | 'number' | 'email' | 'password' | 'textarea' | 'date' | 'dropdown' | 'checkbox' | 'radio' | 'file' | 'hiddenField' | 'html';

export interface FormField {
  label: string;
  type: FormFieldType;
  placeholder?: string;
  required?: boolean;
  /** Opções da lista, das caixas e dos botões de escolha. */
  options?: string[];
  /** Lista com várias escolhas. */
  multiselect?: boolean;
  /** Tipos de arquivo aceitos (ex.: .pdf,.jpg). */
  accept?: string;
  multipleFiles?: boolean;
  /** Nome do campo oculto (é a chave no item). */
  name?: string;
  /** Valor do campo oculto, ou o HTML do bloco de texto. */
  value?: string;
}

export interface FormDefinition {
  title: string;
  description?: string;
  fields: FormField[];
  buttonLabel?: string;
  customCss?: string;
}

export interface UploadedFile {
  field: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
}

const FIELD_TYPES: { name: string; value: FormFieldType }[] = [
  { name: 'Texto', value: 'text' },
  { name: 'Número', value: 'number' },
  { name: 'E-mail', value: 'email' },
  { name: 'Senha', value: 'password' },
  { name: 'Texto longo', value: 'textarea' },
  { name: 'Data', value: 'date' },
  { name: 'Lista (dropdown)', value: 'dropdown' },
  { name: 'Caixas de seleção', value: 'checkbox' },
  { name: 'Escolha única (radio)', value: 'radio' },
  { name: 'Arquivo', value: 'file' },
  { name: 'Campo oculto', value: 'hiddenField' },
  { name: 'Bloco de texto (HTML)', value: 'html' },
];

/** Campo "Campos do formulário" dos nós de formulário. */
export const formFieldsProperty = (showWhen?: Record<string, JsonValue[]>): PropertyDescription => ({
  name: 'formFields',
  displayName: 'Campos do formulário',
  type: 'list',
  default: [],
  description:
    'Uma linha por pergunta. Opções: uma por linha (lista, caixas e escolha única). Campo oculto: Nome e Valor. Bloco de texto: o HTML vai em Valor.',
  ...(showWhen ? { showWhen } : {}),
  fields: [
    { name: 'fieldLabel', displayName: 'Rótulo', type: 'string', default: '' },
    { name: 'fieldType', displayName: 'Tipo', type: 'options', default: 'text', options: FIELD_TYPES },
    { name: 'requiredField', displayName: 'Obrigatório', type: 'boolean', default: false },
    { name: 'placeholder', displayName: 'Texto de exemplo', type: 'string', default: '' },
    { name: 'fieldOptions', displayName: 'Opções', type: 'string', default: '', multiline: true },
    { name: 'multiselect', displayName: 'Várias escolhas na lista', type: 'boolean', default: false },
    { name: 'acceptFileTypes', displayName: 'Tipos de arquivo aceitos', type: 'string', default: '', placeholder: '.pdf,.jpg' },
    { name: 'multipleFiles', displayName: 'Vários arquivos', type: 'boolean', default: true },
    { name: 'fieldName', displayName: 'Nome (campo oculto)', type: 'string', default: '' },
    { name: 'fieldValue', displayName: 'Valor (campo oculto ou HTML)', type: 'string', default: '', multiline: true },
  ],
});

const str = (v: JsonValue | undefined): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));

/** Converte as linhas do campo "Campos do formulário" (já com as expressões resolvidas). */
export function readFormFields(raw: JsonValue): FormField[] {
  const rows = Array.isArray(raw) ? raw : [];
  const fields: FormField[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const type = (FIELD_TYPES.some((t) => t.value === row.fieldType) ? row.fieldType : 'text') as FormFieldType;
    const label = str(row.fieldLabel).trim();
    const field: FormField = { label, type };
    if (row.requiredField === true) field.required = true;
    if (str(row.placeholder)) field.placeholder = str(row.placeholder);
    const options = (Array.isArray(row.fieldOptions) ? row.fieldOptions.map(str) : str(row.fieldOptions).split(/\r?\n/))
      .map((o) => o.trim())
      .filter(Boolean);
    if (options.length) field.options = options;
    if (row.multiselect === true) field.multiselect = true;
    if (str(row.acceptFileTypes)) field.accept = str(row.acceptFileTypes);
    if (type === 'file') field.multipleFiles = row.multipleFiles !== false;
    if (str(row.fieldName)) field.name = str(row.fieldName);
    if (str(row.fieldValue)) field.value = str(row.fieldValue);
    if (!label && type !== 'hiddenField' && type !== 'html') continue;
    fields.push(field);
  }
  return fields;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Bloco de texto do formulário: só tags de formatação simples; scripts, eventos e estilos saem. */
export function sanitizeHtml(html: string): string {
  const allowed = new Set(['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'div', 'small', 'code', 'pre', 'blockquote', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|input|textarea|select|button)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
      const lower = name.toLowerCase();
      if (!allowed.has(lower)) return '';
      if (tag.startsWith('</')) return `</${lower}>`;
      const kept: string[] = [];
      for (const m of attrs.matchAll(/([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
        const attr = m[1]!.toLowerCase();
        const value = m[3] ?? m[4] ?? '';
        if ((attr === 'href' || attr === 'src') && /^(https?:|mailto:|\/|#)/i.test(value.trim())) kept.push(`${attr}="${escapeHtml(value)}"`);
        else if (attr === 'alt' || attr === 'title' || attr === 'target') kept.push(`${attr}="${escapeHtml(value)}"`);
      }
      return `<${lower}${kept.length ? ' ' + kept.join(' ') : ''}>`;
    });
}

const PAGE_CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f5f7;color:#1f2328}
.card{max-width:560px;margin:40px auto;background:#fff;border:1px solid #e1e4e8;border-radius:10px;padding:28px 32px}
@media (max-width:600px){.card{margin:0;border-radius:0;border-left:0;border-right:0;padding:20px 16px}}
h1{font-size:22px;margin:0 0 8px}.desc{color:#57606a;margin:0 0 20px;white-space:pre-wrap}
.field{margin:0 0 18px}label.title{display:block;font-weight:600;margin-bottom:6px}.req{color:#cf222e;margin-left:2px}
input[type=text],input[type=number],input[type=email],input[type=password],input[type=date],textarea,select{width:100%;padding:9px 10px;border:1px solid #d0d7de;border-radius:6px;font:inherit;background:#fff}
textarea{min-height:96px;resize:vertical}.choice{display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:400}
button{background:#ff6d5a;color:#fff;border:0;border-radius:6px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;width:100%}
button:hover{filter:brightness(.95)}.error{background:#ffebe9;border:1px solid #ff8182;color:#82071e;padding:10px 12px;border-radius:6px;margin-bottom:16px}
.test{background:#fff8c5;border:1px solid #d4a72c;padding:8px 12px;border-radius:6px;margin-bottom:16px;font-size:14px}
.done{text-align:center}.html-block{margin:0 0 18px}
`;

function page(title: string, body: string, customCss?: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title || 'Formulário')}</title><style>${PAGE_CSS}${customCss ? customCss.replace(/<\/style/gi, '') : ''}</style></head><body>${body}</body></html>`;
}

/** Nome do campo no HTML: field-0, field-1… (o rótulo pode ter qualquer caractere). */
const inputName = (i: number) => `field-${i}`;

export function renderFormPage(form: FormDefinition, options: { action: string; testMode?: boolean; error?: string } = { action: '' }): string {
  const parts: string[] = [];
  form.fields.forEach((f, i) => {
    const name = inputName(i);
    const req = f.required ? ' required' : '';
    const label = `<label class="title" for="${name}">${escapeHtml(f.label)}${f.required ? '<span class="req">*</span>' : ''}</label>`;
    const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
    switch (f.type) {
      case 'hiddenField':
        parts.push(`<input type="hidden" name="${name}" value="${escapeHtml(f.value ?? '')}">`);
        return;
      case 'html':
        parts.push(`<div class="html-block">${sanitizeHtml(f.value ?? '')}</div>`);
        return;
      case 'textarea':
        parts.push(`<div class="field">${label}<textarea id="${name}" name="${name}"${ph}${req}></textarea></div>`);
        return;
      case 'dropdown': {
        const opts = (f.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
        const first = f.multiselect ? '' : `<option value="">${escapeHtml(f.placeholder || 'Escolha…')}</option>`;
        parts.push(`<div class="field">${label}<select id="${name}" name="${name}"${f.multiselect ? ' multiple' : ''}${req}>${first}${opts}</select></div>`);
        return;
      }
      case 'checkbox':
      case 'radio': {
        const type = f.type === 'radio' ? 'radio' : 'checkbox';
        const opts = (f.options ?? [])
          .map((o, j) => `<label class="choice"><input type="${type}" name="${name}" value="${escapeHtml(o)}"${type === 'radio' && j === 0 ? req : ''}> ${escapeHtml(o)}</label>`)
          .join('');
        parts.push(`<div class="field"><label class="title">${escapeHtml(f.label)}${f.required ? '<span class="req">*</span>' : ''}</label>${opts}</div>`);
        return;
      }
      case 'file':
        parts.push(
          `<div class="field">${label}<input type="file" id="${name}" name="${name}"${f.multipleFiles ? ' multiple' : ''}${f.accept ? ` accept="${escapeHtml(f.accept)}"` : ''}${req}></div>`,
        );
        return;
      default:
        parts.push(`<div class="field">${label}<input type="${f.type}" id="${name}" name="${name}"${f.type === 'number' ? ' step="any"' : ''}${ph}${req}></div>`);
    }
  });
  const body = `<main class="card">
${options.testMode ? '<div class="test">Formulário de teste: o envio roda o fluxo como uma execução manual.</div>' : ''}
<h1>${escapeHtml(form.title)}</h1>${form.description ? `<p class="desc">${escapeHtml(form.description)}</p>` : ''}
${options.error ? `<div class="error">${escapeHtml(options.error)}</div>` : ''}
<form method="post" action="${escapeHtml(options.action)}" enctype="multipart/form-data">
${parts.join('\n')}
<button type="submit">${escapeHtml(form.buttonLabel || 'Enviar')}</button>
</form></main>`;
  return page(form.title, body, form.customCss);
}

export function renderMessagePage(title: string, message: string, customCss?: string): string {
  return page(title, `<main class="card done"><h1>${escapeHtml(title)}</h1>${message ? `<p class="desc">${escapeHtml(message)}</p>` : ''}</main>`, customCss);
}

/** Nome de propriedade de arquivo a partir do rótulo (o n8n usa o rótulo; aqui sem espaços nem acentos). */
export function binaryKeyFromLabel(label: string): string {
  const key = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'arquivo';
}

/** Momento do envio no formato do n8n (com o fuso, ex.: 2026-10-07T15:04:05.000-03:00). */
export function submittedAt(timezone: string, now = new Date()): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
    const offsetMin = Math.round((local - Math.floor(now.getTime() / 1000) * 1000) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return now.toISOString();
  }
}

export class FormValidationError extends Error {}

/**
 * Item do envio: uma chave por rótulo (campo oculto: pelo nome), números como número, caixas e listas
 * múltiplas como lista, arquivos no `binary` (e nome, tipo e tamanho no JSON).
 */
export function formSubmissionItem(
  form: FormDefinition,
  values: Record<string, string | string[]>,
  files: UploadedFile[],
  options: { mode: 'test' | 'production'; timezone?: string },
): Item {
  const json: JsonObject = {};
  const binary: Record<string, BinaryData> = {};
  form.fields.forEach((f, i) => {
    if (f.type === 'html') return;
    const name = inputName(i);
    const raw = values[name];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const key = f.type === 'hiddenField' ? f.name || f.label || name : f.label;
    if (f.type === 'file') {
      const uploaded = files.filter((u) => u.field === name && u.fileName);
      if (f.required && !uploaded.length) throw new FormValidationError(`Envie um arquivo em "${f.label}"`);
      const base = binaryKeyFromLabel(f.label);
      const meta: JsonObject[] = [];
      uploaded.forEach((u, j) => {
        binary[uploaded.length > 1 ? `${base}_${j}` : base] = toBinary(u.content, { fileName: u.fileName, mimeType: u.mimeType || undefined });
        meta.push({ filename: u.fileName, mimetype: u.mimeType, size: u.content.length });
      });
      json[key] = f.multipleFiles ? meta : (meta[0] ?? null);
      return;
    }
    const value = list[0] ?? '';
    if (f.required && !list.some((v) => v.trim() !== '')) throw new FormValidationError(`Preencha "${f.label}"`);
    if ((f.type === 'dropdown' || f.type === 'radio' || f.type === 'checkbox') && f.options?.length) {
      const bad = list.find((v) => v !== '' && !f.options!.includes(v));
      if (bad !== undefined) throw new FormValidationError(`Opção inválida em "${f.label}"`);
    }
    if (f.type === 'checkbox' || (f.type === 'dropdown' && f.multiselect)) json[key] = list.filter((v) => v !== '');
    else if (f.type === 'number') json[key] = value.trim() === '' ? null : Number(value);
    else if (f.type === 'hiddenField') json[key] = raw === undefined ? (f.value ?? '') : value;
    else json[key] = value;
  });
  json.submittedAt = submittedAt(options.timezone ?? 'America/Sao_Paulo');
  json.formMode = options.mode;
  return Object.keys(binary).length ? { json, binary } : { json };
}

/** Definição do formulário guardada na pausa (Wait e Form), para o servidor montar a página. */
export function formToJson(form: FormDefinition): JsonObject {
  return JSON.parse(JSON.stringify(form)) as JsonObject;
}

export function formFromJson(value: JsonValue | undefined): FormDefinition {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, JsonValue>;
  return {
    title: str(v.title),
    description: str(v.description) || undefined,
    fields: Array.isArray(v.fields) ? (v.fields as unknown as FormField[]) : [],
    buttonLabel: str(v.buttonLabel) || undefined,
    customCss: str(v.customCss) || undefined,
  };
}
