import type { JsonObject, JsonValue } from '../types.js';
import { isObject, jsonish, type Converted, type Ctx, type Params } from './import.js';

/**
 * Conversores do importador do n8n para Webhook, Respond to Webhook, Form Trigger, Form,
 * Error Trigger, n8n Trigger e o Wait que retoma por webhook ou formulário.
 */

const opts = (params: Params, key = 'options'): Params => (isObject(params[key]) ? (params[key] as Params) : {});
const v = (value: unknown, fallback: JsonValue): JsonValue => (value === undefined || value === null ? fallback : jsonish(value));
const bool = (value: unknown, fallback: boolean): JsonValue =>
  value === undefined || value === null ? fallback : typeof value === 'string' && value.startsWith('=') ? value : value === true || value === 'true';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Headers da resposta: { entries: [{ name, value }] } do n8n vira a lista daqui. */
function responseHeaders(raw: unknown): JsonValue[] {
  const entries = isObject(raw) && Array.isArray(raw.entries) ? raw.entries.filter(isObject) : [];
  return entries.map((e) => ({ name: String(e.name ?? ''), value: jsonish(e.value ?? '') }));
}

function method(raw: unknown, warn: (m: string) => void): string {
  if (Array.isArray(raw)) {
    const first = String(raw[0] ?? 'GET').toUpperCase();
    if (raw.length > 1) warn(`o webhook aceitava vários métodos (${raw.join(', ')}); aqui ele aceita um só e ficou ${first}. Duplique o nó para os outros`);
    return METHODS.has(first) ? first : 'GET';
  }
  const m = String(raw ?? 'GET').toUpperCase();
  if (!METHODS.has(m)) {
    warn(`o método "${m}" não existe aqui; ficou GET`);
    return 'GET';
  }
  return m;
}

/** Autenticação de entrada; as credenciais do n8n viram conexões que o usuário recria. */
function auth(raw: unknown, warn: (m: string) => void, allowHeader = true): JsonObject {
  const value = String(raw ?? 'none');
  if (value === 'basicAuth') {
    warn('crie uma conexão "Usuário e senha (Basic)" com o usuário e a senha do webhook e escolha no nó');
    return { authentication: 'basicAuth', basicAuthConnection: '' };
  }
  if (value === 'headerAuth' && allowHeader) {
    warn('crie uma conexão "Header com chave" com o nome e o valor do header e escolha no nó');
    return { authentication: 'headerAuth', headerAuthConnection: '' };
  }
  if (value !== 'none') warn(`a autenticação "${value}" do n8n não existe aqui; o endereço ficou sem autenticação`);
  return { authentication: 'none' };
}

/** Campos de resposta comuns ao Webhook e ao Wait por webhook. */
function webhookResponse(params: Params, o: Params, warn: (m: string) => void): JsonObject {
  let responseMode = String(params.responseMode ?? 'onReceived');
  if (!['onReceived', 'lastNode', 'responseNode'].includes(responseMode)) {
    warn(`o modo de resposta "${responseMode}" não existe aqui; ficou "Logo que receber"`);
    responseMode = 'onReceived';
  }
  let responseData = String(params.responseData ?? 'firstEntryJson');
  if (!['firstEntryJson', 'allEntries', 'firstEntryBinary', 'noData'].includes(responseData)) responseData = 'firstEntryJson';
  const out: JsonObject = {
    responseMode,
    responseCode: v(params.responseCode ?? o.responseCode, 200),
    responseData,
    responseBinaryPropertyName: v(o.responseBinaryPropertyName ?? params.responseBinaryPropertyName, 'data'),
    responsePropertyName: v(o.responsePropertyName, ''),
    responseContentType: v(o.responseContentType, ''),
    responseHeaders: responseHeaders(o.responseHeaders),
    noResponseBody: bool(o.noResponseBody, false),
  };
  if (responseMode === 'onReceived' && typeof o.responseData === 'string' && o.responseData) {
    warn('o texto fixo da resposta imediata ("Response Data" nas opções) não existe aqui; a resposta é {"message":"Workflow was started"}');
  }
  return out;
}

// ---------- Webhook ----------

function webhook({ node, params, warn }: Ctx): Converted {
  const o = opts(params);
  let path = typeof params.path === 'string' ? params.path.trim().replace(/^\/+|\/+$/g, '') : '';
  // Caminho com parâmetro (:id) fica atrás do ID do webhook no n8n; o endereço continua o mesmo.
  if (path.includes(':') && node.webhookId) path = `${node.webhookId}/${path}`;
  if (!path && node.webhookId) path = node.webhookId;
  if (path.startsWith('=')) warn('o caminho do webhook é uma expressão, que não vale aqui; use um caminho fixo');
  return {
    type: 'webhook',
    parameters: {
      httpMethod: method(params.httpMethod, warn),
      path,
      ...auth(params.authentication, warn),
      ...webhookResponse(params, o, warn),
      binaryPropertyName: v(o.binaryPropertyName ?? params.binaryPropertyName, 'data'),
      rawBody: bool(o.rawBody, false),
      ipWhitelist: v(o.ipWhitelist, ''),
      ignoreBots: bool(o.ignoreBots, false),
      allowedOrigins: v(o.allowedOrigins, '*'),
    },
  };
}

// ---------- Respond to Webhook ----------

function respondToWebhook({ params, warn }: Ctx): Converted {
  const o = opts(params);
  let respondWith = String(params.respondWith ?? 'firstIncomingItem');
  const p: JsonObject = {};
  if (respondWith === 'jwt') {
    warn('responder com JWT não existe aqui; ficou JSON. Gere o token num nó Crypto ou Code');
    respondWith = 'json';
  }
  if (!['firstIncomingItem', 'allIncomingItems', 'json', 'text', 'binary', 'redirect', 'noData'].includes(respondWith)) respondWith = 'firstIncomingItem';
  p.respondWith = respondWith;
  if (respondWith === 'json') p.responseBody = v(params.responseBody, '{}');
  if (respondWith === 'text') p.responseText = v(params.responseBody ?? params.responseText, '');
  if (respondWith === 'binary') {
    if (params.responseDataSource === 'set') warn('o arquivo da resposta precisa vir de um campo do item; confira "Arquivo do item"');
    p.inputFieldName = v(params.inputFieldName, 'data');
  }
  if (respondWith === 'redirect') p.redirectURL = v(params.redirectURL, '');
  p.responseCode = v(o.responseCode, respondWith === 'redirect' ? 307 : 200);
  p.responseHeaders = responseHeaders(o.responseHeaders);
  p.responseKey = v(o.responseKey, '');
  return { type: 'respondToWebhook', parameters: p };
}

// ---------- Formulários ----------

const FIELD_TYPES = new Set(['text', 'number', 'email', 'password', 'textarea', 'date', 'dropdown', 'checkbox', 'radio', 'file', 'hiddenField', 'html']);

/** formFields.values[] do n8n vira a lista de campos daqui (opções uma por linha). */
export function convertFormFields(raw: unknown, warn: (m: string) => void): JsonValue[] {
  const rows = isObject(raw) && Array.isArray(raw.values) ? raw.values.filter(isObject) : [];
  return rows.map((row) => {
    let fieldType = String(row.fieldType ?? 'text');
    if (!FIELD_TYPES.has(fieldType)) {
      warn(`o tipo de campo "${fieldType}" não existe aqui; ficou Texto`);
      fieldType = 'text';
    }
    const options = isObject(row.fieldOptions) && Array.isArray(row.fieldOptions.values) ? row.fieldOptions.values.filter(isObject).map((x) => String(x.option ?? '')) : [];
    return {
      fieldLabel: v(row.fieldLabel, ''),
      fieldType,
      requiredField: row.requiredField === true,
      placeholder: v(row.placeholder, ''),
      fieldOptions: options.join('\n'),
      multiselect: row.multiselect === true,
      acceptFileTypes: v(row.acceptFileTypes, ''),
      multipleFiles: row.multipleFiles !== false,
      fieldName: v(row.fieldName ?? row.elementName, ''),
      fieldValue: v(fieldType === 'html' ? (row.html ?? row.fieldValue) : row.fieldValue, ''),
    };
  });
}

function formFields(params: Params, warn: (m: string) => void): JsonValue[] {
  if (params.defineForm === 'json') {
    warn('o formulário era definido por JSON; aqui os campos são uma lista. Recrie os campos no nó');
    return [];
  }
  return convertFormFields(params.formFields, warn);
}

function formTrigger({ node, params, warn }: Ctx): Converted {
  const o = opts(params);
  const respondOptions = isObject(o.respondWithOptions) && isObject(o.respondWithOptions.values) ? (o.respondWithOptions.values as Params) : {};
  let responseMode = String(params.responseMode ?? 'onReceived');
  if (!['onReceived', 'lastNode', 'responseNode'].includes(responseMode)) responseMode = 'onReceived';
  let path = typeof (o.path ?? params.path) === 'string' ? String(o.path ?? params.path).trim().replace(/^\/+|\/+$/g, '') : '';
  if (!path && node.webhookId) path = node.webhookId;
  const respondWith = String(respondOptions.respondWith ?? 'text') === 'redirect' ? 'redirect' : 'text';
  return {
    type: 'formTrigger',
    parameters: {
      path,
      formTitle: v(params.formTitle, ''),
      formDescription: v(params.formDescription, ''),
      formFields: formFields(params, warn),
      responseMode,
      respondWith,
      formSubmittedText: v(respondOptions.formSubmittedText ?? o.formSubmittedText, 'Sua resposta foi registrada'),
      redirectUrl: v(respondOptions.redirectUrl, ''),
      buttonLabel: v(o.buttonLabel, 'Enviar'),
      ...auth(params.authentication, warn, false),
      timezone: 'America/Sao_Paulo',
      ignoreBots: bool(o.ignoreBots, false),
      customCss: v(o.customCss, ''),
    },
  };
}

function form({ params, warn }: Ctx): Converted {
  const o = opts(params);
  if (String(params.operation ?? 'page') === 'completion') {
    let respondWith = String(params.respondWith ?? 'text');
    if (!['text', 'redirect', 'showText', 'returnBinary'].includes(respondWith)) respondWith = 'text';
    return {
      type: 'form',
      parameters: {
        operation: 'completion',
        respondWith,
        completionTitle: v(params.completionTitle, ''),
        completionMessage: v(params.completionMessage, ''),
        redirectUrl: v(params.redirectUrl, ''),
        responseText: v(params.responseText, ''),
        inputDataFieldName: v(params.inputDataFieldName, 'data'),
        customCss: v(o.customCss, ''),
      },
    };
  }
  return {
    type: 'form',
    parameters: {
      operation: 'page',
      formTitle: v(o.formTitle ?? params.formTitle, ''),
      formDescription: v(o.formDescription ?? params.formDescription, ''),
      formFields: formFields(params, warn),
      buttonLabel: v(o.buttonLabel, 'Enviar'),
      customCss: v(o.customCss, ''),
    },
  };
}

// ---------- Wait por webhook ou formulário ----------

/** Parte do Wait que retoma por webhook ou formulário (o resto fica em convert-flow-extra). */
export function waitResume({ params, warn }: Ctx, resume: 'webhook' | 'form'): Converted {
  const o = opts(params);
  const p: JsonObject = { resume };
  if (resume === 'webhook') {
    Object.assign(p, {
      httpMethod: method(params.httpMethod, warn),
      webhookSuffix: v(o.webhookSuffix, ''),
      ...auth(params.incomingAuthentication ?? params.authentication, warn),
      ...webhookResponse(params, o, warn),
      binaryPropertyName: v(o.binaryPropertyName, 'data'),
      ipWhitelist: v(o.ipWhitelist, ''),
      ignoreBots: bool(o.ignoreBots, false),
    });
  } else {
    Object.assign(p, {
      formTitle: v(params.formTitle, ''),
      formDescription: v(params.formDescription, ''),
      formFields: formFields(params, warn),
      buttonLabel: v(o.buttonLabel, 'Enviar'),
      customCss: v(o.customCss, ''),
      ignoreBots: bool(o.ignoreBots, false),
    });
    if (params.responseMode && params.responseMode !== 'onReceived') warn('o Wait por formulário responde logo que o formulário é enviado; a opção de resposta do n8n foi ignorada');
  }
  if (params.limitWaitTime === true) {
    const limitType = String(params.limitType ?? 'afterTimeInterval') === 'atSpecifiedTime' ? 'atSpecifiedTime' : 'afterTimeInterval';
    Object.assign(p, {
      limitWaitTime: true,
      limitType,
      resumeAmount: v(params.resumeAmount, 1),
      resumeUnit: v(params.resumeUnit, 'hours'),
      maxDateAndTime: v(params.maxDateAndTime, ''),
    });
  }
  warn(
    resume === 'webhook'
      ? 'o endereço de retomada é {{ $execution.resumeUrl }}; configure PUBLIC_URL no .env para ele apontar para o endereço que os outros sistemas enxergam'
      : 'o endereço do formulário é {{ $execution.resumeFormUrl }}; configure PUBLIC_URL no .env para ele apontar para o endereço que as pessoas enxergam',
  );
  return { type: 'wait', parameters: p };
}

// ---------- Error Trigger e n8n Trigger ----------

function n8nTrigger({ params, warn }: Ctx): Converted {
  const raw = Array.isArray(params.events) ? params.events.map(String) : [];
  const events = raw.filter((e) => ['activate', 'update', 'init'].includes(e));
  if (raw.length !== events.length) warn(`os eventos ${raw.filter((e) => !events.includes(e)).join(', ')} não existem aqui`);
  return { type: 'n8nTrigger', parameters: { events } };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  webhook,
  respondToWebhook,
  formTrigger,
  form,
  errorTrigger: () => ({ type: 'errorTrigger', parameters: {} }),
  n8nTrigger,
};
