import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { parse as parseQuery } from 'node:querystring';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  formFromJson,
  FormValidationError,
  formSubmissionItem,
  immediateResponse,
  lastNodeResponse,
  readFormFields,
  renderFormPage,
  renderMessagePage,
  webhookItem,
  type FormDefinition,
  type Item,
  type JsonObject,
  type JsonValue,
  type ResumeData,
  type UploadedFile,
  type WaitInfo,
  type WebhookResponse,
  type WorkflowDefinition,
} from '@sa/engine';
import { one } from '../db/db.js';
import type { ExecutionEvent, ExecutionEvents } from '../executions/events.js';
import type { ExecutionQueue } from '../executions/queue.js';
import { createExecution, encodeJson } from '../executions/store.js';
import { nodeParams, type TriggerManager, type WebhookEntry } from '../triggers/manager.js';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';

/**
 * Rotas públicas (sem login) dos gatilhos HTTP, nos mesmos caminhos do n8n:
 * /webhook, /webhook-test, /webhook-waiting, /form, /form-test e /form-waiting.
 */

export interface WebhookDeps {
  db: Db;
  config: Config;
  queue: ExecutionQueue;
  triggers: TriggerManager;
  events: () => ExecutionEvents;
}

/** Maior corpo aceito num webhook ou formulário (o padrão do n8n). */
const MAX_BODY = 16 * 1024 * 1024;
/** Quanto o pedido espera o fluxo responder (último nó, Respond to Webhook, próxima página). */
const RESPONSE_TIMEOUT_MS = 10 * 60_000;
const BOTS = /bot\b|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|embedly|skypeuripreview|preview|headless/i;

interface Incoming {
  body: JsonValue | undefined;
  raw?: Buffer;
  contentType?: string;
  files: UploadedFile[];
  /** Campos de formulário (urlencoded ou multipart), como chegaram. */
  fields: Record<string, string | string[]>;
}

class BadRequest extends Error {}

async function readIncoming(request: FastifyRequest): Promise<Incoming> {
  const raw = Buffer.isBuffer(request.body) ? request.body : undefined;
  const contentType = request.headers['content-type'];
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!raw?.length) return { body: {}, contentType, files: [], fields: {} };
  if (ct.includes('json')) {
    try {
      return { body: JSON.parse(raw.toString('utf8')) as JsonValue, raw, contentType, files: [], fields: {} };
    } catch {
      throw new BadRequest('O corpo não é um JSON válido');
    }
  }
  if (ct === 'application/x-www-form-urlencoded') {
    const fields = parseQuery(raw.toString('utf8')) as Record<string, string | string[]>;
    return { body: fields as JsonValue, raw, contentType, files: [], fields };
  }
  if (ct === 'multipart/form-data') {
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(raw), { headers: { 'content-type': contentType! } }).formData();
    } catch {
      throw new BadRequest('O envio multipart está mal formado');
    }
    const fields: Record<string, string | string[]> = {};
    const files: UploadedFile[] = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        const current = fields[name];
        fields[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
      } else if (value.name || value.size) {
        files.push({ field: name, fileName: value.name, mimeType: value.type, content: Buffer.from(await value.arrayBuffer()) });
      }
    }
    return { body: fields as JsonValue, raw, contentType, files, fields };
  }
  if (!ct || ct.startsWith('text/') || ct.includes('xml')) return { body: raw.toString('utf8'), raw, contentType, files: [], fields: {} };
  // Corpo binário: vira o arquivo do item.
  return { body: undefined, raw, contentType, files: [], fields: {} };
}

function headersOf(request: FastifyRequest): Record<string, string | string[] | undefined> {
  return request.headers as Record<string, string | string[] | undefined>;
}

function clientIp(request: FastifyRequest): string {
  return request.ip.replace(/^::ffff:/, '');
}

function ipAllowed(list: JsonValue, ip: string): boolean {
  const entries = String(list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entries.length) return true;
  const block = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const type = isIPv6(addr!) ? 'ipv6' : 'ipv4';
    if (!isIPv4(addr!) && !isIPv6(addr!)) continue;
    if (bits) block.addSubnet(addr!, Number(bits), type);
    else block.addAddress(addr!, type);
  }
  return block.check(ip, isIPv6(ip) ? 'ipv6' : 'ipv4');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Confere Basic ou header com a conexão do nó. Devolve a resposta de recusa, ou null. */
async function checkAuth(deps: WebhookDeps, params: Record<string, JsonValue>, request: FastifyRequest): Promise<WebhookResponse | null> {
  const kind = String(params.authentication ?? 'none');
  if (kind === 'none') return null;
  const refuse = (message: string, basic = false): WebhookResponse => ({
    statusCode: basic ? 401 : 403,
    headers: basic ? { 'www-authenticate': 'Basic realm="Webhook"' } : {},
    body: { kind: 'json', value: { message } },
  });
  const connectionId = String((kind === 'basicAuth' ? params.basicAuthConnection : params.headerAuthConnection) ?? '');
  if (!connectionId) return { statusCode: 500, headers: {}, body: { kind: 'json', value: { message: 'A autenticação do webhook está sem conexão escolhida' } } };
  const conn = await deps.triggers.getConnection(connectionId).catch(() => null);
  if (!conn) return { statusCode: 500, headers: {}, body: { kind: 'json', value: { message: 'A conexão da autenticação do webhook não existe mais' } } };
  if (kind === 'basicAuth') {
    const header = String(request.headers.authorization ?? '');
    const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
    const at = decoded.indexOf(':');
    if (at < 0) return refuse('Autorização necessária', true);
    const ok = sameText(decoded.slice(0, at), String(conn.data.user ?? '')) && sameText(decoded.slice(at + 1), String(conn.data.password ?? ''));
    return ok ? null : refuse('Usuário ou senha inválidos', true);
  }
  const name = String(conn.data.name ?? '').toLowerCase();
  const value = request.headers[name];
  return typeof value === 'string' && sameText(value, String(conn.data.value ?? '')) ? null : refuse('Autorização inválida');
}

function corsHeaders(request: FastifyRequest, allowed: JsonValue): Record<string, string> {
  const origin = request.headers.origin;
  if (!origin) return {};
  const list = String(allowed ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes('*')) return { 'access-control-allow-origin': '*' };
  return list.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

function send(reply: FastifyReply, response: WebhookResponse, extraHeaders: Record<string, string> = {}): FastifyReply {
  reply.status(response.statusCode);
  for (const [k, v] of Object.entries({ ...extraHeaders, ...response.headers })) reply.header(k, v);
  const body = response.body;
  if (!body || reply.request.method === 'HEAD') return reply.send();
  if (body.kind === 'json') {
    if (!response.headers['content-type']) reply.type('application/json; charset=utf-8');
    return reply.send(JSON.stringify(body.value));
  }
  if (body.kind === 'text') {
    if (!response.headers['content-type']) reply.type('text/plain; charset=utf-8');
    return reply.send(body.value);
  }
  if (!response.headers['content-type']) reply.type(body.mimeType);
  if (body.fileName && !response.headers['content-disposition']) reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(body.fileName)}`);
  return reply.send(Buffer.from(body.data, 'base64'));
}

function html(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page);
}

/** HTML do próprio fluxo (Form "Página HTML"): roda isolado, sem acesso à sessão do Info8n. */
function userHtml(reply: FastifyReply, page: string): FastifyReply {
  return reply
    .status(200)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', 'sandbox allow-forms allow-popups allow-scripts allow-top-navigation-by-user-activation')
    .send(page);
}

const notFoundPage = (message: string) => renderMessagePage('Não encontrado', message);

export function webhookRoutes(deps: WebhookDeps) {
  return async (app: FastifyInstance) => {
    // O corpo chega cru; cada rota lê conforme o tipo (JSON, formulário, multipart, texto ou arquivo).
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_request, body, done) => done(null, body));

    /** Assina os avisos antes de pôr na fila, para não perder uma resposta rápida. */
    const start = async (executionId: string, listen: boolean) => {
      const sub = listen ? await deps.events().subscribe(executionId) : null;
      await deps.queue.enqueueRun(executionId);
      return sub;
    };

    const createFrom = async (entry: WebhookEntry, item: Item, test: boolean): Promise<string> => {
      const id = await createExecution(deps.db, {
        workflowId: entry.workflowId,
        workflowVersion: test ? null : entry.version,
        mode: test ? 'manual' : 'webhook',
        triggeredBy: entry.test?.userId ?? null,
        definition: entry.definition,
        input: [item],
        startNodeId: entry.node.id,
      });
      if (test) await deps.triggers.testExecutionCreated(entry.workflowId, id);
      return id;
    };

    /** Responde conforme o modo do webhook: logo, no fim do fluxo ou pelo Respond to Webhook. */
    const respond = async (reply: FastifyReply, executionId: string, params: Record<string, JsonValue>, extra: Record<string, string>) => {
      const mode = String(params.responseMode ?? 'onReceived');
      if (mode === 'onReceived') {
        await start(executionId, false);
        return send(reply, immediateResponse(params), extra);
      }
      const sub = (await start(executionId, true))!;
      try {
        const event = await sub.next((e) => e.type === 'finished' || e.type === 'waiting' || (mode === 'responseNode' && e.type === 'response'), RESPONSE_TIMEOUT_MS);
        if (!event) return send(reply, { statusCode: 504, headers: {}, body: { kind: 'json', value: { message: 'O fluxo não respondeu a tempo; ele continua rodando', executionId } } }, extra);
        if (event.type === 'response') return send(reply, event.response, extra);
        if (event.type === 'waiting') return send(reply, immediateResponse(params), extra);
        if (mode === 'lastNode') return send(reply, lastNodeResponse(params, event.lastOutput, event.status === 'success' ? undefined : { message: event.error ?? 'Erro' }), extra);
        // Pelo Respond to Webhook, mas o fluxo terminou sem passar por ele.
        if (event.status !== 'success') return send(reply, { statusCode: 500, headers: {}, body: { kind: 'json', value: { message: 'Error in workflow', error: event.error ?? null } } }, extra);
        return send(reply, { statusCode: 200, headers: {}, body: { kind: 'json', value: { message: 'Workflow executed successfully' } } }, extra);
      } finally {
        await sub.close();
      }
    };

    /** Barreiras comuns: IP, robôs e autenticação. Devolve a resposta de recusa, se houver. */
    const guard = async (request: FastifyRequest, params: Record<string, JsonValue>): Promise<WebhookResponse | null> => {
      if (!ipAllowed(params.ipWhitelist ?? '', clientIp(request))) return { statusCode: 403, headers: {}, body: { kind: 'json', value: { message: 'IP não permitido' } } };
      if (params.ignoreBots === true && BOTS.test(String(request.headers['user-agent'] ?? ''))) return { statusCode: 403, headers: {}, body: { kind: 'json', value: { message: 'Pedido de robô ignorado' } } };
      return checkAuth(deps, params, request);
    };

    // ---------- Webhook ----------

    const webhookHandler = (test: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const path = (request.params as { '*': string })['*'] ?? '';
      const method = request.method.toUpperCase();
      if (method === 'OPTIONS') {
        const methods = deps.triggers.methodsFor(path, test);
        if (!methods.length) return reply.status(404).send();
        const found = deps.triggers.match('webhook', methods[0]!, path, test);
        const allowed = found && 'entry' in found ? found.entry.params.allowedOrigins : '*';
        return reply
          .status(204)
          .headers({
            ...corsHeaders(request, allowed ?? '*'),
            'access-control-allow-methods': [...methods, 'OPTIONS'].join(', '),
            'access-control-allow-headers': String(request.headers['access-control-request-headers'] ?? '*'),
          })
          .send();
      }
      const found = deps.triggers.match('webhook', method, path, test);
      if (!found) {
        return reply.status(404).send({
          message: test
            ? `O webhook de teste "${method} ${path}" não está escutando. Clique em "Escutar" no editor e chame a URL em até 2 minutos.`
            : `O webhook "${method} ${path}" não existe ou o fluxo não está ativo.`,
        });
      }
      if ('methodNotAllowed' in found) return reply.status(405).send({ message: `Este webhook não aceita ${method}` });
      const { entry, params: pathParams } = found;
      const params = entry.params;
      const extra = corsHeaders(request, params.allowedOrigins ?? '*');
      const refused = await guard(request, params);
      if (refused) return send(reply, refused, extra);

      let incoming: Incoming;
      try {
        incoming = await readIncoming(request);
      } catch (err) {
        if (err instanceof BadRequest) return reply.status(400).send({ message: err.message });
        throw err;
      }
      const base = (deps.config.publicUrl ?? `${request.protocol}://${request.headers.host}`).replace(/\/+$/, '');
      const item = webhookItem(
        {
          method,
          headers: headersOf(request),
          query: request.query as Record<string, JsonValue>,
          params: pathParams,
          body: incoming.body,
          rawBody: incoming.raw,
          contentType: incoming.contentType,
          files: incoming.files,
          webhookUrl: `${base}/${test ? 'webhook-test' : 'webhook'}/${entry.path}`,
          mode: test ? 'test' : 'production',
        },
        { binaryPropertyName: String(params.binaryPropertyName || 'data'), rawBody: params.rawBody === true },
      );
      const executionId = await createFrom(entry, item, test);
      return respond(reply, executionId, params, extra);
    };

    for (const [url, test] of [
      ['/webhook/*', false],
      ['/webhook-test/*', true],
    ] as const) {
      app.route({
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        url,
        exposeHeadRoute: false,
        bodyLimit: MAX_BODY,
        handler: webhookHandler(test),
      });
    }

    // ---------- Retomada por webhook (Wait) ----------

    interface WaitingRow {
      id: string;
      status: string;
      mode: string;
      workflow_id: string;
      definition: WorkflowDefinition;
      start_node_id: string | null;
      wait_info: WaitInfo | null;
    }
    const loadExecution = (id: string) =>
      /^[0-9a-f-]{36}$/i.test(id)
        ? one<WaitingRow>(deps.db, 'SELECT id, status, mode, workflow_id, definition, start_node_id, wait_info FROM executions WHERE id = $1', [id])
        : Promise.resolve(null);

    /** Volta a execução pausada para a fila com os dados que chegaram; false se ela não está mais esperando. */
    const resume = async (id: string, data: ResumeData): Promise<boolean> => {
      const row = await one(deps.db, `UPDATE executions SET status = 'queued', resume_data = $2 WHERE id = $1 AND status = 'waiting' RETURNING id`, [id, encodeJson(data)]);
      if (!row) return false;
      await deps.queue.cancelResume(id);
      return true;
    };

    const waitingWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const suffix = ((request.params as { '*'?: string })['*'] ?? '').replace(/^\/+|\/+$/g, '');
      const row = await loadExecution(id);
      if (!row) return reply.status(404).send({ message: `A execução ${id} não existe` });
      if (row.status !== 'waiting' || row.wait_info?.kind !== 'webhook') {
        return reply.status(409).send({ message: `A execução ${id} não está esperando um webhook` });
      }
      const params = (row.wait_info.config ?? {}) as JsonObject;
      const method = request.method.toUpperCase();
      if (String(params.httpMethod || 'GET').toUpperCase() !== method && !(method === 'HEAD' && params.httpMethod === 'GET')) {
        return reply.status(405).send({ message: `Esta execução espera ${String(params.httpMethod || 'GET')}` });
      }
      if (String(params.webhookSuffix ?? '').replace(/^\/+|\/+$/g, '') !== suffix) return reply.status(404).send({ message: 'Caminho de retomada diferente do configurado' });
      const refused = await guard(request, params);
      if (refused) return send(reply, refused);
      let incoming: Incoming;
      try {
        incoming = await readIncoming(request);
      } catch (err) {
        if (err instanceof BadRequest) return reply.status(400).send({ message: err.message });
        throw err;
      }
      const base = (deps.config.publicUrl ?? `${request.protocol}://${request.headers.host}`).replace(/\/+$/, '');
      const item = webhookItem(
        {
          method,
          headers: headersOf(request),
          query: request.query as Record<string, JsonValue>,
          params: {},
          body: incoming.body,
          rawBody: incoming.raw,
          contentType: incoming.contentType,
          files: incoming.files,
          webhookUrl: `${base}/webhook-waiting/${id}${suffix ? `/${suffix}` : ''}`,
          mode: row.mode === 'manual' ? 'test' : 'production',
        },
        { binaryPropertyName: String(params.binaryPropertyName || 'data'), rawBody: params.rawBody === true },
      );
      const mode = String(params.responseMode ?? 'onReceived');
      const sub = mode === 'onReceived' ? null : await deps.events().subscribe(id);
      try {
        if (!(await resume(id, { kind: 'webhook', items: [item] }))) return reply.status(409).send({ message: `A execução ${id} já foi retomada` });
        await deps.queue.enqueueResumed(id);
        if (!sub) return send(reply, immediateResponse(params));
        const event = await sub.next((e) => e.type === 'finished' || e.type === 'waiting' || (mode === 'responseNode' && e.type === 'response'), RESPONSE_TIMEOUT_MS);
        if (!event) return reply.status(504).send({ message: 'O fluxo não respondeu a tempo; ele continua rodando', executionId: id });
        if (event.type === 'response') return send(reply, event.response);
        if (event.type === 'waiting') return send(reply, immediateResponse(params));
        if (mode === 'lastNode') return send(reply, lastNodeResponse(params, event.lastOutput, event.status === 'success' ? undefined : { message: event.error ?? 'Erro' }));
        return send(reply, { statusCode: event.status === 'success' ? 200 : 500, headers: {}, body: { kind: 'json', value: { message: event.status === 'success' ? 'Workflow executed successfully' : 'Error in workflow' } } });
      } finally {
        await sub?.close();
      }
    };
    for (const url of ['/webhook-waiting/:id', '/webhook-waiting/:id/*']) {
      app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], url, exposeHeadRoute: false, bodyLimit: MAX_BODY, handler: waitingWebhook });
    }

    // ---------- Formulários ----------

    /** Formulário do Form Trigger, com título, textos e campos resolvidos. */
    const triggerForm = async (params: Record<string, JsonValue>): Promise<FormDefinition> => ({
      title: String((await deps.triggers.resolveParam(params.formTitle ?? '')) ?? ''),
      description: String((await deps.triggers.resolveParam(params.formDescription ?? '')) ?? '') || undefined,
      fields: readFormFields(await deps.triggers.resolveParam(params.formFields ?? [])),
      buttonLabel: String((await deps.triggers.resolveParam(params.buttonLabel ?? '')) ?? '') || undefined,
      customCss: String(params.customCss ?? '') || undefined,
    });

    /** Tela depois do envio, conforme o Form Trigger (mensagem ou endereço). */
    const completion = async (reply: FastifyReply, params: Record<string, JsonValue>, title: string) => {
      if (String(params.respondWith ?? 'text') === 'redirect' && params.redirectUrl) {
        return reply.redirect(String(await deps.triggers.resolveParam(params.redirectUrl)), 303);
      }
      const message = String((await deps.triggers.resolveParam(params.formSubmittedText ?? 'Sua resposta foi registrada')) ?? '');
      return html(reply, 200, renderMessagePage(title || 'Formulário enviado', message, String(params.customCss ?? '') || undefined));
    };

    /** Espera o fluxo decidir o que mostrar: próxima página, tela final, resposta ou fim. */
    const afterSubmit = async (
      reply: FastifyReply,
      executionId: string,
      sub: Awaited<ReturnType<ExecutionEvents['subscribe']>>,
      triggerParams: Record<string, JsonValue>,
      title: string,
    ) => {
      try {
        const mode = String(triggerParams.responseMode ?? 'onReceived');
        const event: ExecutionEvent | null = await sub.next(
          (e) => e.type === 'finished' || e.type === 'waiting' || e.type === 'response',
          RESPONSE_TIMEOUT_MS,
        );
        if (!event) return html(reply, 200, renderMessagePage('Recebemos seu envio', 'O processamento continua.'));
        if (event.type === 'waiting') {
          if (event.wait.kind === 'form') return reply.redirect(`/form-waiting/${executionId}`, 303);
          return completion(reply, triggerParams, title);
        }
        if (event.type === 'response') {
          const r = event.response;
          if (r.form?.kind === 'redirect') return reply.redirect(r.form.url, 303);
          if (r.form?.kind === 'html') return userHtml(reply, r.form.html);
          if (r.form?.kind === 'completion') return html(reply, 200, renderMessagePage(r.form.title || 'Formulário enviado', r.form.message));
          return send(reply, r);
        }
        if (event.status !== 'success') return html(reply, 500, renderMessagePage('Problema ao processar o envio', 'O fluxo deu erro. Tente de novo mais tarde.'));
        if (mode === 'responseNode') return html(reply, 200, renderMessagePage('Formulário enviado', ''));
        return completion(reply, triggerParams, title);
      } finally {
        await sub.close();
      }
    };

    const hasFormPages = (definition: WorkflowDefinition) =>
      definition.nodes.some((n) => !n.disabled && ((n.type === 'form' && n.parameters.operation !== 'completion') || (n.type === 'wait' && n.parameters.resume === 'form')));

    const formHandler = (test: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const path = (request.params as { '*': string })['*'] ?? '';
      const found = deps.triggers.match('form', 'FORM', path, test);
      if (!found || 'methodNotAllowed' in found) {
        return html(reply, 404, notFoundPage(test ? 'O formulário de teste só abre enquanto o editor está escutando. Clique em "Escutar" e abra o link de novo.' : 'Este formulário não existe ou o fluxo não está ativo.'));
      }
      const { entry } = found;
      const params = entry.params;
      const refused = await guard(request, params);
      if (refused) {
        if (refused.statusCode === 401) return reply.status(401).header('www-authenticate', 'Basic realm="Formulario"').type('text/html; charset=utf-8').send(renderMessagePage('Acesso restrito', 'Informe usuário e senha.'));
        return html(reply, refused.statusCode, renderMessagePage('Acesso negado', ''));
      }
      const form = await triggerForm(params);
      const action = `/${test ? 'form-test' : 'form'}/${entry.path}`;
      if (request.method === 'GET') return html(reply, 200, renderFormPage(form, { action, testMode: test }));

      let incoming: Incoming;
      try {
        incoming = await readIncoming(request);
      } catch (err) {
        if (err instanceof BadRequest) return html(reply, 400, renderFormPage(form, { action, testMode: test, error: err.message }));
        throw err;
      }
      let item: Item;
      try {
        item = formSubmissionItem(form, incoming.fields, incoming.files, { mode: test ? 'test' : 'production', timezone: String(params.timezone || 'America/Sao_Paulo') });
      } catch (err) {
        if (err instanceof FormValidationError) return html(reply, 400, renderFormPage(form, { action, testMode: test, error: err.message }));
        throw err;
      }
      const executionId = await createFrom(entry, item, test);
      const mode = String(params.responseMode ?? 'onReceived');
      if (mode === 'onReceived' && !hasFormPages(entry.definition)) {
        await start(executionId, false);
        return completion(reply, params, form.title);
      }
      const sub = (await start(executionId, true))!;
      return afterSubmit(reply, executionId, sub, params, form.title);
    };

    for (const [url, test] of [
      ['/form/*', false],
      ['/form-test/*', true],
    ] as const) {
      app.route({ method: ['GET', 'POST'], url, bodyLimit: MAX_BODY, handler: formHandler(test) });
    }

    // Página seguinte do formulário (Form e Wait "Quando um formulário for enviado").
    const formWaiting = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const row = await loadExecution(id);
      if (!row) return html(reply, 404, notFoundPage('Este formulário não existe.'));
      const trigger = row.definition.nodes.find((n) => n.id === row.start_node_id);
      const triggerParams = trigger ? nodeParams(trigger) : {};
      if (row.status !== 'waiting' || row.wait_info?.kind !== 'form') {
        if (row.status === 'queued' || row.status === 'running') {
          return reply
            .status(200)
            .type('text/html; charset=utf-8')
            .send(renderMessagePage('Processando…', 'Aguarde um instante.').replace('<head>', '<head><meta http-equiv="refresh" content="2">'));
        }
        if (row.status === 'error') return html(reply, 200, renderMessagePage('Problema ao processar o envio', 'O fluxo deu erro.'));
        return completion(reply, triggerParams, String(triggerParams.formTitle ?? ''));
      }
      const config = (row.wait_info.config ?? {}) as JsonObject;
      const form = formFromJson(config.form);
      const action = `/form-waiting/${id}`;
      if (request.method === 'GET') return html(reply, 200, renderFormPage(form, { action, testMode: row.mode === 'manual' }));
      if (config.ignoreBots === true && BOTS.test(String(request.headers['user-agent'] ?? ''))) return html(reply, 403, renderMessagePage('Acesso negado', ''));

      let incoming: Incoming;
      try {
        incoming = await readIncoming(request);
      } catch (err) {
        if (err instanceof BadRequest) return html(reply, 400, renderFormPage(form, { action, error: err.message }));
        throw err;
      }
      let item: Item;
      try {
        item = formSubmissionItem(form, incoming.fields, incoming.files, { mode: row.mode === 'manual' ? 'test' : 'production', timezone: String(triggerParams.timezone || 'America/Sao_Paulo') });
      } catch (err) {
        if (err instanceof FormValidationError) return html(reply, 400, renderFormPage(form, { action, error: err.message }));
        throw err;
      }
      const sub = await deps.events().subscribe(id);
      if (!(await resume(id, { kind: 'form', items: [item] }))) {
        await sub.close();
        return reply.redirect(action, 303);
      }
      await deps.queue.enqueueResumed(id);
      return afterSubmit(reply, id, sub, triggerParams, form.title);
    };
    app.route({ method: ['GET', 'POST'], url: '/form-waiting/:id', bodyLimit: MAX_BODY, handler: formWaiting });
  };
}
