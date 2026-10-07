import { getBinary, toBinary } from '../binary.js';
import {
  formFieldsProperty,
  formToJson,
  readFormFields,
  type FormDefinition,
  type UploadedFile,
} from '../forms.js';
import { NodeOperationError, type NodeExecuteContext, type NodeType, type PropertyDescription } from '../node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue, WebhookResponse } from '../types.js';

/**
 * Gatilhos chamados por HTTP e o que responde a eles: Webhook, Respond to Webhook, Form Trigger,
 * Form, Error Trigger e n8n Trigger. O servidor recebe o pedido, monta os itens com
 * `webhookItem`/`formSubmissionItem` e inicia a execução no gatilho; os nós aqui só repassam.
 */

// ---------- Pedido recebido ----------

/** Pedido HTTP que chegou num webhook, já lido pelo servidor. */
export interface IncomingWebhook {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, JsonValue>;
  /** Partes variáveis do caminho (ex.: :id). */
  params: Record<string, string>;
  /** Corpo já interpretado (JSON, formulário, texto); undefined quando é binário. */
  body: JsonValue | undefined;
  /** Corpo como chegou. */
  rawBody?: Buffer;
  contentType?: string;
  /** Arquivos de um envio multipart. */
  files?: UploadedFile[];
  webhookUrl: string;
  mode: 'test' | 'production';
}

const str = (v: JsonValue | undefined): string => (v === null || v === undefined ? '' : String(v));

/** Tipos de corpo que viram JSON ou texto; o resto vira arquivo. */
export function isTextualContentType(contentType: string | undefined): boolean {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ct) return true;
  return ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct === 'application/x-www-form-urlencoded' || ct === 'multipart/form-data';
}

/** Item do webhook no formato do n8n: headers, params, query, body, webhookUrl e executionMode. */
export function webhookItem(request: IncomingWebhook, options: { binaryPropertyName?: string; rawBody?: boolean } = {}): Item {
  const headers: JsonObject = {};
  for (const [k, v] of Object.entries(request.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  const prop = options.binaryPropertyName || 'data';
  const binary: Record<string, BinaryData> = {};
  let body: JsonValue = request.body ?? {};

  if (request.files?.length) {
    // multipart: um arquivo por campo; com vários arquivos no mesmo campo, campo0, campo1…
    const count = new Map<string, number>();
    for (const f of request.files) count.set(f.field, (count.get(f.field) ?? 0) + 1);
    const seen = new Map<string, number>();
    request.files.forEach((f, i) => {
      const n = seen.get(f.field) ?? 0;
      seen.set(f.field, n + 1);
      const key = options.binaryPropertyName ? `${prop}${i}` : count.get(f.field)! > 1 ? `${f.field}${n}` : f.field;
      binary[key] = toBinary(f.content, { fileName: f.fileName, mimeType: f.mimeType || undefined });
    });
  } else if (request.body === undefined && request.rawBody?.length) {
    // Corpo binário (PDF, imagem, octet-stream…): vira o arquivo do item.
    binary[prop] = toBinary(request.rawBody, { mimeType: request.contentType?.split(';')[0]?.trim() || undefined });
    body = {};
  }
  if (options.rawBody && request.rawBody?.length && !binary[prop]) {
    binary[prop] = toBinary(request.rawBody, { mimeType: request.contentType?.split(';')[0]?.trim() || undefined });
  }

  const item: Item = {
    json: { headers, params: request.params, query: request.query, body, webhookUrl: request.webhookUrl, executionMode: request.mode },
  };
  if (Object.keys(binary).length) item.binary = binary;
  return item;
}

// ---------- Respostas ----------

function headerList(raw: JsonValue): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const name = str(row.name).trim();
    if (name) out[name.toLowerCase()] = str(row.value);
  }
  return out;
}

function statusCode(raw: JsonValue, fallback = 200): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : fallback;
}

/** Resposta do modo "Logo que receber" (o n8n devolve {"message":"Workflow was started"}). */
export function immediateResponse(params: Record<string, JsonValue>): WebhookResponse {
  const headers = headerList(params.responseHeaders ?? []);
  if (params.responseContentType) headers['content-type'] = str(params.responseContentType);
  const response: WebhookResponse = { statusCode: statusCode(params.responseCode ?? 200), headers };
  if (params.noResponseBody !== true) response.body = { kind: 'json', value: { message: 'Workflow was started' } };
  return response;
}

/** Resposta do modo "Quando o último nó terminar", a partir da saída do último nó. */
export function lastNodeResponse(params: Record<string, JsonValue>, items: Item[], failed?: { message: string }): WebhookResponse {
  if (failed) return { statusCode: 500, headers: {}, body: { kind: 'json', value: { message: 'Error in workflow', error: failed.message } } };
  const headers = headerList(params.responseHeaders ?? []);
  if (params.responseContentType) headers['content-type'] = str(params.responseContentType);
  const response: WebhookResponse = { statusCode: statusCode(params.responseCode ?? 200), headers };
  if (params.noResponseBody === true) return response;
  const mode = str(params.responseData) || 'firstEntryJson';
  if (mode === 'noData') return response;
  if (mode === 'allEntries') {
    response.body = { kind: 'json', value: items.map((i) => i.json) };
    return response;
  }
  const first = items[0];
  if (mode === 'firstEntryBinary') {
    const prop = str(params.responseBinaryPropertyName) || 'data';
    const file = first?.binary?.[prop];
    if (!file || typeof file.data !== 'string' || file.omitted) {
      return { statusCode: 500, headers: {}, body: { kind: 'json', value: { message: `O último nó não devolveu o arquivo "${prop}"` } } };
    }
    response.body = { kind: 'binary', data: file.data, mimeType: file.mimeType, fileName: file.fileName };
    return response;
  }
  let value: JsonValue = first?.json ?? {};
  const key = str(params.responsePropertyName).trim();
  if (key) value = key.split('.').reduce<JsonValue>((v, k) => (v && typeof v === 'object' && !Array.isArray(v) ? (v[k] ?? null) : null), value);
  response.body = typeof value === 'string' && headers['content-type'] && !headers['content-type'].includes('json') ? { kind: 'text', value } : { kind: 'json', value };
  return response;
}

// ---------- Webhook ----------

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m }));

const responseHeadersProperty = (showWhen?: Record<string, JsonValue[]>): PropertyDescription => ({
  name: 'responseHeaders',
  displayName: 'Headers da resposta',
  type: 'list',
  default: [],
  ...(showWhen ? { showWhen } : {}),
  fields: [
    { name: 'name', displayName: 'Nome', type: 'string', default: '' },
    { name: 'value', displayName: 'Valor', type: 'string', default: '' },
  ],
});

/** Item de exemplo quando o fluxo é executado pelo botão, sem pedido de verdade. */
function manualItems(ctx: NodeExecuteContext, sample: JsonObject): Item[] {
  const input = ctx.inputs[0] ?? [];
  return input.length ? input : [{ json: sample }];
}

export const webhook: NodeType = {
  webhook: 'webhook',
  description: {
    type: 'webhook',
    displayName: 'Webhook',
    description: 'Inicia o fluxo quando um sistema chama a URL do webhook.',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      { name: 'httpMethod', displayName: 'Método HTTP', type: 'options', default: 'GET', options: METHODS },
      {
        name: 'path',
        displayName: 'Caminho',
        type: 'string',
        default: '',
        placeholder: 'pedidos/novo',
        description:
          'A URL fica /webhook/<caminho> (teste: /webhook-test/<caminho>). Aceita partes variáveis, como clientes/:id. Vazio usa o ID do nó. Cada caminho e método só pode estar num fluxo ativo.',
      },
      {
        name: 'authentication',
        displayName: 'Autenticação',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Nenhuma', value: 'none' },
          { name: 'Usuário e senha (Basic)', value: 'basicAuth' },
          { name: 'Header com chave', value: 'headerAuth' },
        ],
      },
      { name: 'basicAuthConnection', displayName: 'Conexão (usuário e senha)', type: 'connection', default: '', connectionTypes: ['httpBasicAuth'], showWhen: { authentication: ['basicAuth'] } },
      { name: 'headerAuthConnection', displayName: 'Conexão (header)', type: 'connection', default: '', connectionTypes: ['httpHeaderAuth'], showWhen: { authentication: ['headerAuth'] } },
      {
        name: 'responseMode',
        displayName: 'Responder',
        type: 'options',
        default: 'onReceived',
        options: [
          { name: 'Logo que receber', value: 'onReceived' },
          { name: 'Quando o último nó terminar', value: 'lastNode' },
          { name: 'Pelo nó Respond to Webhook', value: 'responseNode' },
        ],
      },
      { name: 'responseCode', displayName: 'Código da resposta', type: 'number', default: 200, showWhen: { responseMode: ['onReceived', 'lastNode'] } },
      {
        name: 'responseData',
        displayName: 'Dados da resposta',
        type: 'options',
        default: 'firstEntryJson',
        showWhen: { responseMode: ['lastNode'] },
        options: [
          { name: 'JSON do primeiro item', value: 'firstEntryJson' },
          { name: 'Todos os itens (lista de JSON)', value: 'allEntries' },
          { name: 'Arquivo do primeiro item', value: 'firstEntryBinary' },
          { name: 'Sem corpo', value: 'noData' },
        ],
      },
      { name: 'responseBinaryPropertyName', displayName: 'Arquivo da resposta', type: 'string', default: 'data', showWhen: { responseMode: ['lastNode'], responseData: ['firstEntryBinary'] } },
      {
        name: 'responsePropertyName',
        displayName: 'Campo da resposta',
        type: 'string',
        default: '',
        description: 'Responde só este campo do JSON (ex.: resultado.total). Vazio responde o JSON inteiro.',
        showWhen: { responseMode: ['lastNode'], responseData: ['firstEntryJson'] },
      },
      { name: 'responseContentType', displayName: 'Content-Type da resposta', type: 'string', default: '', showWhen: { responseMode: ['onReceived', 'lastNode'] } },
      responseHeadersProperty({ responseMode: ['onReceived', 'lastNode'] }),
      { name: 'noResponseBody', displayName: 'Responder sem corpo', type: 'boolean', default: false, showWhen: { responseMode: ['onReceived', 'lastNode'] } },
      {
        name: 'binaryPropertyName',
        displayName: 'Nome do arquivo recebido',
        type: 'string',
        default: 'data',
        description: 'Propriedade do arquivo quando o corpo é binário (PDF, imagem…). Em envios multipart, cada arquivo usa o nome do campo.',
      },
      { name: 'rawBody', displayName: 'Guardar também o corpo cru como arquivo', type: 'boolean', default: false },
      { name: 'ipWhitelist', displayName: 'IPs permitidos', type: 'string', default: '', placeholder: '10.0.0.5, 192.168.1.0/24', description: 'Separados por vírgula. Vazio aceita qualquer IP.' },
      { name: 'ignoreBots', displayName: 'Ignorar robôs (prévia de links, buscadores)', type: 'boolean', default: false },
      { name: 'allowedOrigins', displayName: 'Origens permitidas (CORS)', type: 'string', default: '*', description: 'Separadas por vírgula; * aceita qualquer site.' },
    ],
  },
  async execute(ctx) {
    return [manualItems(ctx, { headers: {}, params: {}, query: {}, body: {}, webhookUrl: '', executionMode: 'test' })];
  },
};

// ---------- Respond to Webhook ----------

export const respondToWebhook: NodeType = {
  description: {
    type: 'respondToWebhook',
    displayName: 'Respond to Webhook',
    description: 'Responde o pedido do Webhook ou do Form Trigger configurado para responder por este nó.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'respondWith',
        displayName: 'Responder com',
        type: 'options',
        default: 'firstIncomingItem',
        options: [
          { name: 'Primeiro item recebido', value: 'firstIncomingItem' },
          { name: 'Todos os itens recebidos', value: 'allIncomingItems' },
          { name: 'JSON', value: 'json' },
          { name: 'Texto', value: 'text' },
          { name: 'Arquivo', value: 'binary' },
          { name: 'Redirecionar', value: 'redirect' },
          { name: 'Sem dados', value: 'noData' },
        ],
      },
      { name: 'responseBody', displayName: 'Corpo', type: 'json', default: '{\n  "myField": "value"\n}', showWhen: { respondWith: ['json'] } },
      { name: 'responseText', displayName: 'Texto', type: 'string', default: '', multiline: true, showWhen: { respondWith: ['text'] } },
      { name: 'inputFieldName', displayName: 'Arquivo do item', type: 'string', default: 'data', showWhen: { respondWith: ['binary'] } },
      { name: 'redirectURL', displayName: 'Endereço', type: 'string', default: '', required: true, showWhen: { respondWith: ['redirect'] } },
      { name: 'responseCode', displayName: 'Código da resposta', type: 'number', default: 200 },
      responseHeadersProperty(),
      {
        name: 'responseKey',
        displayName: 'Colocar a resposta no campo',
        type: 'string',
        default: '',
        description: 'Envolve os itens num campo (ex.: dados). Só para primeiro item e todos os itens.',
        showWhen: { respondWith: ['firstIncomingItem', 'allIncomingItems'] },
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const respondWith = str(await ctx.getParam('respondWith', 0)) || 'firstIncomingItem';
    const headers = headerList(await ctx.getParam('responseHeaders', 0));
    let code = statusCode(await ctx.getParam('responseCode', 0));
    let body: WebhookResponse['body'];

    if (respondWith === 'firstIncomingItem' || respondWith === 'allIncomingItems') {
      const key = str(await ctx.getParam('responseKey', 0)).trim();
      const value: JsonValue = respondWith === 'allIncomingItems' ? input.map((i) => i.json) : (input[0]?.json ?? {});
      body = { kind: 'json', value: key ? { [key]: value } : value };
    } else if (respondWith === 'json') {
      const raw = await ctx.getParam('responseBody', 0);
      let value: JsonValue = raw;
      if (typeof raw === 'string') {
        try {
          value = raw.trim() ? (JSON.parse(raw) as JsonValue) : {};
        } catch {
          throw new NodeOperationError('O corpo da resposta não é um JSON válido');
        }
      }
      body = { kind: 'json', value };
    } else if (respondWith === 'text') {
      body = { kind: 'text', value: str(await ctx.getParam('responseText', 0)) };
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    } else if (respondWith === 'binary') {
      if (!input[0]) throw new NodeOperationError('Nenhum item chegou para responder com o arquivo');
      const file = getBinary(input[0], str(await ctx.getParam('inputFieldName', 0)) || 'data');
      body = { kind: 'binary', data: file.data, mimeType: file.mimeType, fileName: file.fileName };
    } else if (respondWith === 'redirect') {
      const url = str(await ctx.getParam('redirectURL', 0)).trim();
      if (!url) throw new NodeOperationError('Informe o endereço para redirecionar');
      headers.location = url;
      if (code < 300 || code > 399) code = 307;
    }
    const response: WebhookResponse = { statusCode: code, headers };
    if (body) response.body = body;
    ctx.sendResponse(response);
    ctx.meta.response = { statusCode: code, respondWith };
    return [input];
  },
};

// ---------- Form Trigger e Form ----------

const formResponseModes = [
  { name: 'Logo que enviar', value: 'onReceived' },
  { name: 'Quando o último nó terminar', value: 'lastNode' },
  { name: 'Pelo nó Respond to Webhook', value: 'responseNode' },
];

/** Formulário do nó com as expressões resolvidas (vale o primeiro item). */
export async function readFormDefinition(ctx: NodeExecuteContext, defaultTitle: string): Promise<FormDefinition> {
  return {
    title: str(await ctx.getParam('formTitle', 0)) || defaultTitle,
    description: str(await ctx.getParam('formDescription', 0)) || undefined,
    fields: readFormFields(await ctx.getParam('formFields', 0)),
    buttonLabel: str(await ctx.getParam('buttonLabel', 0)) || undefined,
    customCss: str(await ctx.getParam('customCss', 0)) || undefined,
  };
}

export const formTrigger: NodeType = {
  webhook: 'form',
  description: {
    type: 'formTrigger',
    displayName: 'Form Trigger',
    description: 'Publica um formulário na web e inicia o fluxo a cada envio.',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      {
        name: 'path',
        displayName: 'Caminho',
        type: 'string',
        default: '',
        description: 'O formulário fica em /form/<caminho> (teste: /form-test/<caminho>). Vazio usa o ID do nó.',
      },
      { name: 'formTitle', displayName: 'Título', type: 'string', default: '', required: true },
      { name: 'formDescription', displayName: 'Descrição', type: 'string', default: '', multiline: true },
      formFieldsProperty(),
      { name: 'responseMode', displayName: 'Quando responder', type: 'options', default: 'onReceived', options: formResponseModes },
      {
        name: 'respondWith',
        displayName: 'Depois do envio',
        type: 'options',
        default: 'text',
        showWhen: { responseMode: ['onReceived', 'lastNode'] },
        options: [
          { name: 'Mostrar mensagem', value: 'text' },
          { name: 'Ir para um endereço', value: 'redirect' },
        ],
      },
      { name: 'formSubmittedText', displayName: 'Mensagem', type: 'string', default: 'Sua resposta foi registrada', showWhen: { responseMode: ['onReceived', 'lastNode'], respondWith: ['text'] } },
      { name: 'redirectUrl', displayName: 'Endereço', type: 'string', default: '', showWhen: { responseMode: ['onReceived', 'lastNode'], respondWith: ['redirect'] } },
      { name: 'buttonLabel', displayName: 'Texto do botão', type: 'string', default: 'Enviar' },
      {
        name: 'authentication',
        displayName: 'Autenticação',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Nenhuma', value: 'none' },
          { name: 'Usuário e senha (Basic)', value: 'basicAuth' },
        ],
      },
      { name: 'basicAuthConnection', displayName: 'Conexão (usuário e senha)', type: 'connection', default: '', connectionTypes: ['httpBasicAuth'], showWhen: { authentication: ['basicAuth'] } },
      { name: 'timezone', displayName: 'Fuso do submittedAt', type: 'string', default: 'America/Sao_Paulo' },
      { name: 'ignoreBots', displayName: 'Ignorar robôs (prévia de links, buscadores)', type: 'boolean', default: false },
      { name: 'customCss', displayName: 'CSS próprio', type: 'string', default: '', multiline: true },
    ],
  },
  async execute(ctx) {
    return [manualItems(ctx, { submittedAt: new Date().toISOString(), formMode: 'test' })];
  },
};

export const form: NodeType = {
  description: {
    type: 'form',
    displayName: 'Form',
    description: 'Próxima página do formulário do Form Trigger, ou a tela final.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'operation',
        displayName: 'Tipo de página',
        type: 'options',
        default: 'page',
        options: [
          { name: 'Próxima página do formulário', value: 'page' },
          { name: 'Tela final', value: 'completion' },
        ],
      },
      { name: 'formTitle', displayName: 'Título', type: 'string', default: '', showWhen: { operation: ['page'] } },
      { name: 'formDescription', displayName: 'Descrição', type: 'string', default: '', multiline: true, showWhen: { operation: ['page'] } },
      formFieldsProperty({ operation: ['page'] }),
      { name: 'buttonLabel', displayName: 'Texto do botão', type: 'string', default: 'Enviar', showWhen: { operation: ['page'] } },
      {
        name: 'respondWith',
        displayName: 'Mostrar',
        type: 'options',
        default: 'text',
        showWhen: { operation: ['completion'] },
        options: [
          { name: 'Título e mensagem', value: 'text' },
          { name: 'Ir para um endereço', value: 'redirect' },
          { name: 'Página HTML', value: 'showText' },
          { name: 'Arquivo do item', value: 'returnBinary' },
        ],
      },
      { name: 'completionTitle', displayName: 'Título', type: 'string', default: '', showWhen: { operation: ['completion'], respondWith: ['text', 'returnBinary'] } },
      { name: 'completionMessage', displayName: 'Mensagem', type: 'string', default: '', multiline: true, showWhen: { operation: ['completion'], respondWith: ['text', 'returnBinary'] } },
      { name: 'redirectUrl', displayName: 'Endereço', type: 'string', default: '', showWhen: { operation: ['completion'], respondWith: ['redirect'] } },
      { name: 'responseText', displayName: 'HTML', type: 'string', default: '', multiline: true, showWhen: { operation: ['completion'], respondWith: ['showText'] } },
      { name: 'inputDataFieldName', displayName: 'Arquivo do item', type: 'string', default: 'data', showWhen: { operation: ['completion'], respondWith: ['returnBinary'] } },
      { name: 'customCss', displayName: 'CSS próprio', type: 'string', default: '', multiline: true },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const operation = str(await ctx.getParam('operation', 0)) || 'page';
    if (operation === 'completion') {
      const respondWith = str(await ctx.getParam('respondWith', 0)) || 'text';
      const response: WebhookResponse = { statusCode: 200, headers: {} };
      if (respondWith === 'redirect') {
        response.form = { kind: 'redirect', url: str(await ctx.getParam('redirectUrl', 0)) };
      } else if (respondWith === 'showText') {
        response.form = { kind: 'html', html: str(await ctx.getParam('responseText', 0)) };
      } else if (respondWith === 'returnBinary') {
        if (!input[0]) throw new NodeOperationError('Nenhum item chegou com o arquivo para mostrar');
        const file = getBinary(input[0], str(await ctx.getParam('inputDataFieldName', 0)) || 'data');
        response.body = { kind: 'binary', data: file.data, mimeType: file.mimeType, fileName: file.fileName };
      } else {
        response.form = { kind: 'completion', title: str(await ctx.getParam('completionTitle', 0)), message: str(await ctx.getParam('completionMessage', 0)) };
      }
      ctx.sendResponse(response);
      return [input];
    }
    if (ctx.resumeData?.kind === 'form') return [ctx.resumeData.items ?? []];
    const definition = await readFormDefinition(ctx, '');
    if (!ctx.putToWait({ kind: 'form', config: { form: formToJson(definition) } })) {
      throw new NodeOperationError('O Form não funciona dentro de um subfluxo; coloque as páginas no fluxo do Form Trigger');
    }
    return [input];
  },
};

// ---------- Error Trigger ----------

export const errorTrigger: NodeType = {
  description: {
    type: 'errorTrigger',
    displayName: 'Error Trigger',
    description: 'Inicia este fluxo quando uma execução de outro fluxo falha (escolha este fluxo nas configurações do outro).',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [],
  },
  async execute(ctx) {
    return [
      manualItems(ctx, {
        execution: {
          id: '231',
          url: `${ctx.publicUrl}/executions/231`,
          retryOf: '34',
          error: { message: 'Exemplo de mensagem de erro', stack: 'Stacktrace' },
          lastNodeExecuted: 'Nó com erro',
          mode: 'manual',
        },
        workflow: { id: '1', name: 'Exemplo de fluxo' },
      }),
    ];
  },
};

// ---------- n8n Trigger ----------

export const n8nTrigger: NodeType = {
  description: {
    type: 'n8nTrigger',
    displayName: 'n8n Trigger',
    description: 'Inicia o fluxo quando ele é ativado, quando é salvo ativo ou quando o servidor inicia.',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      {
        name: 'events',
        displayName: 'Eventos',
        type: 'multiOptions',
        default: [],
        required: true,
        options: [
          { name: 'Fluxo ativado', value: 'activate' },
          { name: 'Fluxo salvo (ativo)', value: 'update' },
          { name: 'Servidor iniciado', value: 'init' },
        ],
      },
    ],
  },
  async execute(ctx) {
    return [manualItems(ctx, { event: 'Manual execution', timestamp: new Date().toISOString(), workflow_id: '' })];
  },
};

/** Texto do evento do n8n Trigger, igual ao do n8n. */
export const N8N_TRIGGER_EVENTS: Record<string, string> = {
  activate: 'Workflow activated',
  update: 'Workflow updated',
  init: 'Instance started',
};

export const webhookNodes: NodeType[] = [webhook, respondToWebhook, formTrigger, form, errorTrigger, n8nTrigger];
