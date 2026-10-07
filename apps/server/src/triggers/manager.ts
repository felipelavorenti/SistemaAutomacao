import { CronExpressionParser } from 'cron-parser';
import {
  defaultRegistry,
  ExpressionSandbox,
  N8N_TRIGGER_EVENTS,
  pollTimesToCrons,
  type ConnectionData,
  type Item,
  type JsonObject,
  type JsonValue,
  type NodeInstance,
  type TriggerContext,
  type WorkflowDefinition,
} from '@sa/engine';
import type { Config } from '../config.js';
import { one, many, type Db } from '../db/db.js';
import type { ExecutionQueue } from '../executions/queue.js';
import { createExecution } from '../executions/store.js';
import { decryptJson } from '../lib/crypto.js';

/**
 * Gatilhos que não são agendamento: webhooks e formulários (rotas públicas), gatilhos que escutam
 * (IMAP, pasta, SSE), que consultam (RSS) e o n8n Trigger. Roda só no processo da API: com mais
 * de uma API, cada uma escutaria e as execuções se repetiriam.
 */

export interface TriggerWorkflow {
  id: string;
  name: string;
  active: boolean;
  version: number | null;
  definition: WorkflowDefinition;
}

export type WebhookKind = 'webhook' | 'form';

export interface WebhookEntry {
  workflowId: string;
  workflowName: string;
  version: number | null;
  definition: WorkflowDefinition;
  node: NodeInstance;
  /** Parâmetros do nó com os padrões preenchidos. */
  params: Record<string, JsonValue>;
  kind: WebhookKind;
  /** Método HTTP (formulários aceitam GET e POST). */
  method: string;
  path: string;
  segments: string[];
  /** Escuta de teste aberta pelo editor: execução manual, em nome de quem abriu. */
  test?: { userId: string };
}

interface TestSession {
  userId: string;
  definition: WorkflowDefinition;
  entries: WebhookEntry[];
  expiresAt: number;
  executionId: string | null;
  stop: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  controller: AbortController;
  closers: (() => Promise<void>)[];
  timers: ReturnType<typeof setTimeout>[];
}

/** Tempo que a escuta de teste fica aberta, como no n8n. */
export const TEST_LISTEN_MS = 120_000;

/** Gatilhos que só disparam com o fluxo ativo (além do agendamento). */
const ACTIVATABLE = new Set(['scheduleTrigger', 'webhook', 'formTrigger', 'n8nTrigger']);

export function nodeParams(node: NodeInstance): Record<string, JsonValue> {
  const type = defaultRegistry.get(node.type);
  const defaults = Object.fromEntries((type?.description.properties ?? []).map((p) => [p.name, p.default]));
  return { ...defaults, ...node.parameters };
}

export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

/** Caminho do webhook ou do formulário do nó (vazio: o ID do nó). */
export function webhookPath(node: NodeInstance): string {
  const raw = node.parameters.path;
  const path = typeof raw === 'string' && !raw.startsWith('=') ? normalizePath(raw) : '';
  return path || node.id;
}

/** O fluxo tem algum gatilho que precisa estar ativo para disparar? */
export function isActivatable(definition: WorkflowDefinition): boolean {
  return definition.nodes.some((n) => {
    if (n.disabled) return false;
    const type = defaultRegistry.get(n.type);
    return ACTIVATABLE.has(n.type) || Boolean(type?.listen || type?.poll);
  });
}

function entriesFor(wf: { id: string; name: string; version: number | null; definition: WorkflowDefinition }, test?: { userId: string }): WebhookEntry[] {
  const entries: WebhookEntry[] = [];
  for (const node of wf.definition.nodes) {
    if (node.disabled) continue;
    const kind = defaultRegistry.get(node.type)?.webhook;
    if (!kind) continue;
    const params = nodeParams(node);
    const path = webhookPath(node);
    entries.push({
      workflowId: wf.id,
      workflowName: wf.name,
      version: wf.version,
      definition: wf.definition,
      node,
      params,
      kind,
      method: kind === 'form' ? 'FORM' : String(params.httpMethod || 'GET').toUpperCase(),
      path,
      segments: path.split('/'),
      ...(test ? { test } : {}),
    });
  }
  return entries;
}

/** Confere o caminho do pedido com o do nó; devolve as partes variáveis (:id) ou null. */
function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(actual[i]!);
    else if (p !== actual[i]) return null;
  }
  return params;
}

export class TriggerManager {
  private production = new Map<string, WebhookEntry[]>();
  private running = new Map<string, Running>();
  private tests = new Map<string, TestSession>();
  private sandbox = new ExpressionSandbox();

  constructor(private deps: { db: Db; config: Config; queue: ExecutionQueue }) {}

  /** Sobe os gatilhos dos fluxos ativos e dispara o evento "servidor iniciado" do n8n Trigger. */
  async start(): Promise<void> {
    const active = await many<TriggerWorkflow>(this.deps.db, 'SELECT id, name, active, version, definition FROM workflows WHERE active');
    for (const wf of active) {
      await this.sync(wf).catch((err) => console.error(`Gatilhos do fluxo "${wf.name}" não subiram:`, err));
      await this.fireEvent(wf, 'init').catch(() => undefined);
    }
  }

  /** Deixa os gatilhos do fluxo iguais à versão salva (chamado ao salvar, ativar, desativar e excluir). */
  async sync(wf: TriggerWorkflow): Promise<void> {
    await this.stopRunning(wf.id);
    this.production.delete(wf.id);
    if (!wf.active) return;
    this.production.set(wf.id, entriesFor(wf));
    await this.startListeners(wf, null);
  }

  async remove(workflowId: string): Promise<void> {
    await this.stopRunning(workflowId);
    this.production.delete(workflowId);
    await this.stopTest(workflowId);
  }

  /** Caminhos (método + caminho) que outro fluxo ativo já usa. */
  conflicts(wf: { id: string; name: string; version: number | null; definition: WorkflowDefinition }): string[] {
    const problems: string[] = [];
    const mine = entriesFor(wf);
    const seen = new Set<string>();
    for (const e of mine) {
      const key = `${e.kind} ${e.method} ${e.path}`;
      if (seen.has(key)) problems.push(`O caminho "${e.path}" aparece em mais de um nó deste fluxo`);
      seen.add(key);
      for (const [id, others] of this.production) {
        if (id === wf.id) continue;
        const other = others.find((o) => o.kind === e.kind && o.method === e.method && o.path === e.path);
        if (other) {
          problems.push(
            e.kind === 'form'
              ? `O formulário "${e.path}" já é usado pelo fluxo ativo "${other.workflowName}"`
              : `O webhook ${e.method} "${e.path}" já é usado pelo fluxo ativo "${other.workflowName}"`,
          );
        }
      }
    }
    return problems;
  }

  /** Acha o webhook ou formulário do pedido; os de teste só valem enquanto o editor escuta. */
  match(kind: WebhookKind, method: string, path: string, test: boolean): { entry: WebhookEntry; params: Record<string, string> } | { methodNotAllowed: true } | null {
    const actual = normalizePath(path).split('/');
    const lists = test ? [...this.tests.values()].filter((t) => t.expiresAt > Date.now()).map((t) => t.entries) : [...this.production.values()];
    let best: { entry: WebhookEntry; params: Record<string, string>; score: number } | null = null;
    let otherMethod = false;
    for (const list of lists) {
      for (const entry of list) {
        if (entry.kind !== kind) continue;
        const params = matchSegments(entry.segments, actual);
        if (!params) continue;
        if (kind === 'webhook' && entry.method !== method && !(method === 'HEAD' && entry.method === 'GET')) {
          otherMethod = true;
          continue;
        }
        const score = entry.segments.filter((s) => !s.startsWith(':')).length;
        if (!best || score > best.score) best = { entry, params, score };
      }
    }
    if (best) return { entry: best.entry, params: best.params };
    return otherMethod ? { methodNotAllowed: true } : null;
  }

  /** Métodos aceitos num caminho (para o CORS). */
  methodsFor(path: string, test: boolean): string[] {
    const actual = normalizePath(path).split('/');
    const lists = test ? [...this.tests.values()].map((t) => t.entries) : [...this.production.values()];
    const methods = new Set<string>();
    for (const list of lists) for (const e of list) if (e.kind === 'webhook' && matchSegments(e.segments, actual)) methods.add(e.method);
    return [...methods];
  }

  // ---------- Execuções ----------

  /** Cria a execução a partir de um gatilho e põe na fila. */
  async enqueue(
    wf: { id: string; version: number | null; definition: WorkflowDefinition },
    node: NodeInstance,
    items: Item[],
    mode: 'webhook' | 'trigger' | 'manual',
    triggeredBy: string | null,
  ): Promise<string> {
    const id = await createExecution(this.deps.db, {
      workflowId: wf.id,
      workflowVersion: wf.version,
      mode,
      triggeredBy,
      definition: wf.definition,
      input: items,
      startNodeId: node.id,
    });
    await this.deps.queue.enqueueRun(id);
    return id;
  }

  /** Execução criada por uma escuta de teste: guarda o ID para o editor abrir e fecha a escuta. */
  async testExecutionCreated(workflowId: string, executionId: string): Promise<void> {
    const session = this.tests.get(workflowId);
    if (!session) return;
    session.executionId = executionId;
    await this.closeTestListeners(workflowId);
  }

  /** Resolve um parâmetro sem itens (título do formulário, mensagens), para as páginas públicas. */
  async resolveParam(value: JsonValue): Promise<JsonValue> {
    const scope = await this.sandbox.createScope({ nodeOutputs: {}, execution: { id: '', mode: 'webhook' }, vars: {} });
    try {
      return await scope.resolve(value, [], 0);
    } catch {
      return typeof value === 'string' && value.startsWith('=') ? value.slice(1) : value;
    } finally {
      scope.release();
    }
  }

  /** Eventos do n8n Trigger: fluxo ativado, salvo ativo ou servidor iniciado. */
  async fireEvent(wf: TriggerWorkflow, event: 'activate' | 'update' | 'init'): Promise<void> {
    if (!wf.active) return;
    for (const node of wf.definition.nodes) {
      if (node.disabled || node.type !== 'n8nTrigger') continue;
      const events = nodeParams(node).events;
      if (!Array.isArray(events) || !events.includes(event)) continue;
      await this.enqueue(wf, node, [{ json: { event: N8N_TRIGGER_EVENTS[event]!, timestamp: new Date().toISOString(), workflow_id: wf.id } }], 'trigger', null);
    }
  }

  // ---------- Escuta de teste (botão "Escutar" do editor) ----------

  async startTest(wf: { id: string; name: string }, definition: WorkflowDefinition, userId: string): Promise<{ expiresAt: string; webhooks: { kind: WebhookKind; method: string; path: string; nodeName: string }[] }> {
    await this.stopTest(wf.id);
    const entries = entriesFor({ id: wf.id, name: wf.name, version: null, definition }, { userId });
    const session: TestSession = {
      userId,
      definition,
      entries,
      expiresAt: Date.now() + TEST_LISTEN_MS,
      executionId: null,
      stop: async () => undefined,
      timer: setTimeout(() => void this.closeTestListeners(wf.id), TEST_LISTEN_MS),
    };
    this.tests.set(wf.id, session);
    const testWf: TriggerWorkflow = { id: wf.id, name: wf.name, active: true, version: null, definition };
    const running = await this.startListeners(testWf, session);
    session.stop = async () => this.closeRunning(running);
    if (!entries.length && !running.closers.length && !running.timers.length) {
      await this.stopTest(wf.id);
      throw new Error('Este fluxo não tem gatilho para escutar (Webhook, Form Trigger, IMAP, RSS, pasta ou SSE)');
    }
    return { expiresAt: new Date(session.expiresAt).toISOString(), webhooks: entries.map((e) => ({ kind: e.kind, method: e.method, path: e.path, nodeName: e.node.name })) };
  }

  testStatus(workflowId: string): { listening: boolean; executionId: string | null; expiresAt: string | null } {
    const s = this.tests.get(workflowId);
    if (!s) return { listening: false, executionId: null, expiresAt: null };
    return { listening: !s.executionId && s.expiresAt > Date.now(), executionId: s.executionId, expiresAt: new Date(s.expiresAt).toISOString() };
  }

  async stopTest(workflowId: string): Promise<void> {
    const s = this.tests.get(workflowId);
    if (!s) return;
    clearTimeout(s.timer);
    this.tests.delete(workflowId);
    await s.stop().catch(() => undefined);
  }

  /** Fecha os webhooks e ouvintes de teste, mas guarda o ID da execução para o editor ler. */
  private async closeTestListeners(workflowId: string): Promise<void> {
    const s = this.tests.get(workflowId);
    if (!s) return;
    s.entries = [];
    s.expiresAt = Math.min(s.expiresAt, Date.now());
    await s.stop().catch(() => undefined);
    // Some da memória depois de um tempo, mesmo que o editor não pergunte.
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.tests.delete(workflowId), TEST_LISTEN_MS);
  }

  // ---------- Gatilhos que escutam e que consultam ----------

  async getConnection(id: string): Promise<ConnectionData> {
    const row = await one<{ id: string; type: string; data_encrypted: Buffer }>(this.deps.db, 'SELECT id, type, data_encrypted FROM connections WHERE id = $1', [id]);
    if (!row) throw new Error(`Conexão ${id} não existe mais`);
    return { id: row.id, type: row.type, data: decryptJson<JsonObject>(this.deps.config.encryptionKey, row.data_encrypted) };
  }

  private async startListeners(wf: TriggerWorkflow, test: TestSession | null): Promise<Running> {
    const running: Running = { controller: new AbortController(), closers: [], timers: [] };
    if (!test) this.running.set(wf.id, running);
    for (const node of wf.definition.nodes) {
      if (node.disabled) continue;
      const type = defaultRegistry.get(node.type);
      if (!type?.listen && !type?.poll) continue;
      const ctx = await this.triggerContext(wf, node, running.controller.signal, test);
      if (type.listen) {
        try {
          running.closers.push(await type.listen(ctx));
        } catch (err) {
          console.error(`Gatilho "${node.name}" do fluxo "${wf.name}" não iniciou:`, err);
          if (test) throw err;
        }
      }
      if (type.poll) {
        if (test) {
          // Teste: consulta uma vez agora, trazendo o item mais recente.
          const items = await type.poll(ctx);
          if (items?.length) await ctx.emit(items);
          else throw new Error(`O gatilho "${node.name}" não trouxe nenhum item`);
          continue;
        }
        this.schedulePoll(wf, node, ctx, running);
      }
    }
    return running;
  }

  private schedulePoll(wf: TriggerWorkflow, node: NodeInstance, ctx: TriggerContext, running: Running): void {
    const type = defaultRegistry.get(node.type)!;
    let crons: string[];
    try {
      crons = pollTimesToCrons(nodeParams(node).pollTimes ?? []);
    } catch (err) {
      console.error(`Horários de consulta inválidos no nó "${node.name}" do fluxo "${wf.name}":`, err);
      return;
    }
    if (!crons.length) return;
    const next = () =>
      Math.min(
        ...crons.map((c) => {
          try {
            return CronExpressionParser.parse(c, { tz: 'America/Sao_Paulo' }).next().getTime();
          } catch {
            return Infinity;
          }
        }),
      );
    let busy = false;
    const arm = () => {
      if (running.controller.signal.aborted) return;
      const at = next();
      if (!Number.isFinite(at)) return;
      const timer = setTimeout(async () => {
        running.timers = running.timers.filter((t) => t !== timer);
        if (!busy) {
          busy = true;
          try {
            const items = await type.poll!(ctx);
            if (items?.length) await ctx.emit(items);
          } catch (err) {
            ctx.emitError(err instanceof Error ? err : new Error(String(err)));
          } finally {
            busy = false;
          }
        }
        arm();
      }, Math.min(at - Date.now(), 2_147_483_647));
      running.timers.push(timer);
    };
    arm();
  }

  private async triggerContext(wf: TriggerWorkflow, node: NodeInstance, signal: AbortSignal, test: TestSession | null): Promise<TriggerContext> {
    const row = test ? null : await one<{ data: JsonObject }>(this.deps.db, 'SELECT data FROM workflow_static_data WHERE workflow_id = $1 AND node_id = $2', [wf.id, node.id]);
    const staticData: JsonObject = row?.data ?? {};
    const params = nodeParams(node);
    return {
      node,
      workflowId: wf.id,
      filesDirs: this.deps.config.filesDirs,
      staticData,
      testing: Boolean(test),
      signal,
      getParam: async (name) => {
        const scope = await this.sandbox.createScope({ nodeOutputs: {}, execution: { id: '', mode: test ? 'manual' : 'trigger' }, vars: {} });
        try {
          return await scope.resolve(params[name] ?? null, [], 0);
        } finally {
          scope.release();
        }
      },
      getConnection: (id) => this.getConnection(id),
      saveStaticData: async () => {
        if (test) return;
        await this.deps.db.query(
          `INSERT INTO workflow_static_data (workflow_id, node_id, data, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (workflow_id, node_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [wf.id, node.id, JSON.stringify(staticData)],
        );
      },
      emit: async (items) => {
        if (signal.aborted || !items.length) return;
        if (test) {
          if (test.executionId) return;
          test.executionId = await this.enqueue({ id: wf.id, version: null, definition: test.definition }, node, items, 'manual', test.userId);
          void this.closeTestListeners(wf.id);
          return;
        }
        await this.enqueue(wf, node, items, 'trigger', null);
      },
      emitError: (err) => console.error(`Gatilho "${node.name}" do fluxo "${wf.name}": ${err.message}`),
    };
  }

  private async stopRunning(workflowId: string): Promise<void> {
    const running = this.running.get(workflowId);
    if (!running) return;
    this.running.delete(workflowId);
    await this.closeRunning(running);
  }

  private async closeRunning(running: Running): Promise<void> {
    running.controller.abort();
    for (const t of running.timers) clearTimeout(t);
    running.timers = [];
    for (const close of running.closers.splice(0)) await close().catch((err) => console.error('Gatilho não fechou:', err));
  }

  async close(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stopRunning(id);
    for (const id of [...this.tests.keys()]) await this.stopTest(id);
    this.sandbox.dispose();
  }
}
