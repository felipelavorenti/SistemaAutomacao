import { CodeError, ExpressionSandbox, type SandboxOptions } from './expressions/sandbox.js';
import type { ApiEndpointData } from './catalog.js';
import { DatabasePools } from './database/drivers.js';
import type { CommandLog, ConnectionData, DatabaseCommandLog, DatabaseSession, DataTableStore, FileData, NodeExecuteContext, NodeType, SubworkflowResult } from './node-types.js';
import { MemoryDataTableStore } from './data-tables.js';

type NodeExecuteContextWait = NodeExecuteContext['putToWait'];
import { NodeOperationError } from './node-types.js';
import { PythonRunner, referencedNodes } from './python/runner.js';
import { defaultRegistry, NodeRegistry } from './registry.js';
import type {
  Connection,
  ExecutionResult,
  Item,
  JsonObject,
  JsonValue,
  NodeError,
  NodeInstance,
  NodeRun,
  ResumeData,
  ResumeState,
  WaitInfo,
  WebhookResponse,
  WorkflowDefinition,
} from './types.js';

/** Maior atraso que o setTimeout do Node aceita. */
const MAX_TIMER_MS = 2_147_483_647;

export interface ExecuteOptions {
  workflow: WorkflowDefinition;
  executionId: string;
  mode: string;
  /** Gatilho de onde a execução começa; por padrão, o primeiro gatilho do fluxo. */
  startNodeId?: string;
  /** Itens entregues ao gatilho (ex.: o JSON de entrada de uma execução manual). */
  triggerItems?: Item[];
  vars?: JsonObject;
  getConnection?: (id: string) => Promise<ConnectionData>;
  /** Arquivos enviados pela tela (ex.: anexos do Gmail). */
  getFile?: (id: string) => Promise<FileData>;
  /** Pastas do servidor liberadas para ler e gravar arquivos. */
  filesDirs?: string[];
  signal?: AbortSignal;
  onNodeFinished?: (run: NodeRun) => void | Promise<void>;
  registry?: NodeRegistry;
  sandbox?: SandboxOptions;
  /** Tempo máximo padrão de cada nó, em milissegundos. */
  defaultNodeTimeoutMs?: number;
  /** Executa outro fluxo (nó Execute Workflow). Quem chama cuida de registrar a execução filha. */
  executeSubworkflow?: (args: { workflowId: string; items: Item[]; signal: AbortSignal }) => Promise<SubworkflowResult>;
  /** Busca um endpoint do catálogo de APIs já combinado com o cliente no ERP. */
  getApiEndpoint?: (erpClientId: string, endpointId: string) => Promise<ApiEndpointData>;
  /** Pools de conexão com os bancos; o worker compartilha um entre execuções. */
  databases?: DatabasePools;
  /** Chamado a cada comando executado num banco (auditoria). */
  onDatabaseCommand?: (entry: DatabaseCommandLog) => void | Promise<void>;
  /** Limite de execuções de nós, para um loop sem fim não travar o worker. */
  maxNodeRuns?: number;
  /** Processos que rodam o Python do nó Code; por padrão, um conjunto compartilhado pelo processo. */
  python?: PythonRunner;
  /** Endereço público do Info8n, para $execution.resumeUrl e as URLs de webhook e formulário. */
  publicUrl?: string;
  /** A execução pode pausar (Wait, Form)? Subfluxos não podem: esperam no próprio worker. */
  canWait?: boolean;
  /** Continua uma execução pausada. */
  resume?: { state: ResumeState; data?: ResumeData };
  /** Resposta para o pedido HTTP que iniciou ou retomou a execução (Respond to Webhook, Form). */
  onResponse?: (response: WebhookResponse) => void;
  /** Chamado a cada comando do Execute Command e do SSH (auditoria). */
  onCommand?: (entry: CommandLog) => void | Promise<void>;
  /** Tabelas de dados (nó Data Table); sem elas, a execução usa tabelas em memória que somem no fim. */
  dataTables?: DataTableStore;
}

let sharedPython: PythonRunner | null = null;

/** Conjunto de processos Python usado quando a execução não recebe um próprio. */
export function defaultPythonRunner(): PythonRunner {
  sharedPython ??= new PythonRunner();
  return sharedPython;
}

export async function closeDefaultPythonRunner(): Promise<void> {
  await sharedPython?.close();
  sharedPython = null;
}

class ExecutionCanceled extends Error {}

interface PendingNode {
  inputs: Item[][];
  received: boolean[];
  /** Momento (em número de nós executados) em que começou a esperar. */
  seq: number;
}

/** Um nó na fila de execução; o nó que pediu a pausa volta com os dados da retomada. */
interface ReadyNode {
  node: NodeInstance;
  inputs: Item[][];
  resumeData?: ResumeData;
}

export async function executeWorkflow(options: ExecuteOptions): Promise<ExecutionResult> {
  const registry = options.registry ?? defaultRegistry;
  const { workflow } = options;
  const resume = options.resume?.state;
  const startedAt = resume?.startedAt ?? new Date().toISOString();
  const runs: NodeRun[] = resume ? [...resume.runs] : [];
  const nodeOutputs: Record<string, Item[]> = resume ? { ...resume.nodeOutputs } : {};
  let lastOutput: Item[] = resume?.lastOutput ?? [];

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Connection[]>();
  for (const c of workflow.connections) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    outgoing.set(c.from, [...(outgoing.get(c.from) ?? []), c]);
  }

  const sandbox = new ExpressionSandbox(options.sandbox);
  // Sem pools compartilhados, a execução usa os seus e fecha no fim.
  const ownPools = options.databases ? null : new DatabasePools();
  // Sem tabelas do servidor, a execução usa tabelas em memória (testes).
  options = { ...options, dataTables: options.dataTables ?? new MemoryDataTableStore() };
  const pools = options.databases ?? ownPools!;

  // Nós prontos para rodar, com os itens de cada entrada. Nós de várias
  // entradas (ex.: Merge) esperam em `waiting` até receber todas.
  const ready: ReadyNode[] = [];
  const waiting = new Map<string, PendingNode>();
  // Estado dos nós que duram a execução toda (Loop) e os que ainda têm lotes pendentes,
  // do mais antigo para o mais recente, com o momento da última execução de cada um.
  const nodeState = new Map<string, Record<string, unknown>>();
  const pendingWork: { id: string; seq: number }[] = [];
  const maxRuns = options.maxNodeRuns ?? 50_000;
  let seq = 0;

  const nodeById = (id: string): NodeInstance => {
    const node = byId.get(id);
    if (!node) throw new Error(`O nó ${id} não existe mais no fluxo desta execução`);
    return node;
  };
  if (resume) {
    for (const r of resume.ready) ready.push({ node: nodeById(r.nodeId), inputs: r.inputs });
    for (const w of resume.waiting) waiting.set(w.nodeId, { inputs: w.inputs, received: w.received, seq: w.seq });
    for (const n of resume.nodeState) nodeState.set(n.nodeId, n.state);
    pendingWork.push(...resume.pendingWork);
    seq = resume.seq;
    ready.push({ node: nodeById(resume.pausedNodeId), inputs: resume.pausedInputs, resumeData: options.resume!.data ?? { kind: 'time' } });
  } else {
    ready.push({ node: findStartNode(workflow, registry, options.startNodeId), inputs: [options.triggerItems ?? []] });
  }

  const finish = (status: ExecutionResult['status'], error?: ExecutionResult['error']): ExecutionResult => {
    sandbox.dispose();
    void ownPools?.closeAll();
    return { status, startedAt, finishedAt: new Date().toISOString(), runs, error, lastOutput };
  };

  /** Guarda tudo o que falta rodar para continuar depois. */
  const pause = (node: NodeInstance, inputs: Item[][], wait: Omit<WaitInfo, 'nodeId' | 'nodeName'>): ExecutionResult => {
    const resumeState: ResumeState = {
      version: 1,
      startedAt,
      runs,
      nodeOutputs,
      lastOutput,
      ready: ready.map((r) => ({ nodeId: r.node.id, inputs: r.inputs })),
      waiting: [...waiting].map(([nodeId, p]) => ({ nodeId, inputs: p.inputs, received: p.received, seq: p.seq })),
      nodeState: [...nodeState].map(([nodeId, state]) => ({ nodeId, state })),
      pendingWork: [...pendingWork],
      seq,
      pausedNodeId: node.id,
      pausedInputs: inputs,
    };
    return { ...finish('waiting'), wait: { ...wait, nodeId: node.id, nodeName: node.name }, resumeState };
  };

  try {
    while (ready.length || waiting.size || pendingWork.length) {
      if (options.signal?.aborted) throw new ExecutionCanceled();

      if (!ready.length) {
        // Nada mais vai chegar pelos ramos em andamento. Primeiro roda os nós de
        // várias entradas que começaram a esperar dentro da volta atual do loop;
        // depois devolve o controle ao loop mais recente; por fim, o que sobrar.
        const loop = pendingWork.at(-1);
        let latest: [string, PendingNode] | undefined;
        for (const entry of waiting) if (!latest || entry[1].seq > latest[1].seq) latest = entry;
        if (latest && (!loop || latest[1].seq > loop.seq)) {
          waiting.delete(latest[0]);
          ready.push({ node: byId.get(latest[0])!, inputs: latest[1].inputs });
        } else if (loop) {
          ready.push({ node: byId.get(loop.id)!, inputs: [[]] });
        } else {
          const [id, pending] = waiting.entries().next().value!;
          waiting.delete(id);
          ready.push({ node: byId.get(id)!, inputs: pending.inputs });
        }
      }

      const { node, inputs, resumeData } = ready.pop()!;
      const type = registry.get(node.type);
      if (!type) {
        return finish('error', { message: `Tipo de nó desconhecido: ${node.type}`, nodeId: node.id, nodeName: node.name });
      }
      if (runs.length >= maxRuns) {
        return finish('error', {
          message: `A execução passou do limite de ${maxRuns} execuções de nós. Verifique se algum loop volta sem parar.`,
          nodeId: node.id,
          nodeName: node.name,
        });
      }

      const state = nodeState.get(node.id) ?? {};
      nodeState.set(node.id, state);
      let waitRequest: Omit<WaitInfo, 'nodeId' | 'nodeName'> | null = null;
      const run = await runNode(node, type, inputs, nodeOutputs, options, sandbox, state, pools, {
        resumeData,
        putToWait: (w) => {
          if (options.canWait === false) return false;
          waitRequest = { kind: w.kind, until: w.until !== undefined ? new Date(w.until).toISOString() : undefined, config: w.config };
          return true;
        },
      });
      // O nó pediu a pausa e deu certo: ele roda de novo na retomada, então não entra no histórico agora.
      if (waitRequest && run.status === 'success') return pause(node, inputs, waitRequest);
      runs.push(run);
      seq++;
      await options.onNodeFinished?.(run);

      if (type.hasPendingWork) {
        const at = pendingWork.findIndex((p) => p.id === node.id);
        if (at >= 0) pendingWork.splice(at, 1);
        if (type.hasPendingWork(state)) pendingWork.push({ id: node.id, seq });
      }

      if (run.status === 'error' && !node.settings?.continueOnFail) {
        return finish('error', { ...run.error!, nodeId: node.id, nodeName: node.name });
      }

      const firstNonEmpty = run.output.find((o) => o.length) ?? [];
      nodeOutputs[node.name] = firstNonEmpty;
      lastOutput = firstNonEmpty;

      // Empilha os próximos nós em ordem reversa, para o ramo da saída 0 rodar primeiro.
      const next = (outgoing.get(node.id) ?? []).filter((c) => (run.output[c.fromOutput] ?? []).length > 0);
      for (const c of [...next].reverse()) {
        const target = byId.get(c.to)!;
        const targetType = registry.get(target.type);
        const items = run.output[c.fromOutput];
        const inputCount = Math.max(1, targetType?.description.inputs ?? 1);

        if (inputCount === 1) {
          ready.push({ node: target, inputs: [items] });
          continue;
        }

        const pending = waiting.get(target.id) ?? {
          inputs: Array.from({ length: inputCount }, () => []),
          received: Array.from({ length: inputCount }, () => false),
          seq,
        };
        pending.inputs[c.toInput] = [...pending.inputs[c.toInput], ...items];
        pending.received[c.toInput] = true;
        const connectedInputs = new Set(workflow.connections.filter((x) => x.to === target.id).map((x) => x.toInput));
        if ([...connectedInputs].every((idx) => pending.received[idx])) {
          waiting.delete(target.id);
          ready.push({ node: target, inputs: pending.inputs });
        } else {
          waiting.set(target.id, pending);
        }
      }
    }
    return finish('success');
  } catch (err) {
    if (err instanceof ExecutionCanceled) return finish('canceled', { message: 'Execução cancelada' });
    sandbox.dispose();
    void ownPools?.closeAll();
    throw err;
  }
}

function findStartNode(workflow: WorkflowDefinition, registry: NodeRegistry, startNodeId?: string): NodeInstance {
  if (startNodeId) {
    const node = workflow.nodes.find((n) => n.id === startNodeId);
    if (!node) throw new Error(`Nó inicial ${startNodeId} não existe no fluxo`);
    return node;
  }
  // Sem gatilho escolhido (botão Executar), começa pelo manual; senão, pelo primeiro gatilho.
  const triggers = workflow.nodes.filter((n) => !n.disabled && registry.get(n.type)?.description.group === 'trigger');
  const trigger = triggers.find((n) => n.type === 'manualTrigger') ?? triggers[0];
  if (!trigger) throw new Error('O fluxo não tem gatilho');
  return trigger;
}

export function executionUrls(options: Pick<ExecuteOptions, 'publicUrl' | 'executionId'>): { resumeUrl: string; resumeFormUrl: string; publicUrl: string } {
  const publicUrl = (options.publicUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
  return { publicUrl, resumeUrl: `${publicUrl}/webhook-waiting/${options.executionId}`, resumeFormUrl: `${publicUrl}/form-waiting/${options.executionId}` };
}

async function runNode(
  node: NodeInstance,
  type: NodeType,
  inputs: Item[][],
  nodeOutputs: Record<string, Item[]>,
  options: ExecuteOptions,
  sandbox: ExpressionSandbox,
  state: Record<string, unknown>,
  pools: DatabasePools,
  pause: { resumeData?: ResumeData; putToWait: NodeExecuteContextWait },
): Promise<NodeRun> {
  const urls = executionUrls(options);
  const started = Date.now();
  const base = {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    startedAt: new Date(started).toISOString(),
    input: inputs,
  };
  const meta: JsonObject = {};
  const done = (fields: Pick<NodeRun, 'status' | 'output' | 'tries'> & { error?: NodeError }): NodeRun => {
    const finished = Date.now();
    const run: NodeRun = { ...base, ...fields, finishedAt: new Date(finished).toISOString(), durationMs: finished - started };
    if (Object.keys(meta).length) run.meta = meta;
    return run;
  };

  // Nó desativado: repassa os itens adiante sem executar.
  if (node.disabled) return done({ status: 'success', output: [inputs[0] ?? []], tries: 0 });

  const settings = node.settings ?? {};
  const maxTries = settings.retryOnFail ? Math.max(1, settings.maxTries ?? 3) : 1;
  const wait = settings.waitBetweenTriesMs ?? 1000;
  // Acima de 2^31-1 ms (24,8 dias) o timer do Node dispara na hora; o limite fica nesse teto.
  const timeoutMs = Math.min(settings.timeoutMs ?? type.description.defaultTimeoutMs ?? options.defaultNodeTimeoutMs ?? 120_000, MAX_TIMER_MS);
  const defaults = Object.fromEntries(type.description.properties.map((p) => [p.name, p.default]));

  let lastError: NodeError = { message: 'Erro desconhecido' };
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const scope = await sandbox.createScope({
      nodeOutputs,
      execution: { id: options.executionId, mode: options.mode, resumeUrl: urls.resumeUrl, resumeFormUrl: urls.resumeFormUrl },
      vars: options.vars ?? {},
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const output = await withAbort(
        type.execute({
          node,
          inputs,
          signal,
          getParam: (name, itemIndex = 0) => {
            const value: JsonValue = node.parameters[name] !== undefined ? node.parameters[name] : (defaults[name] ?? null);
            return scope.resolve(value, inputs[0] ?? [], itemIndex);
          },
          getConnection: async (id) => {
            if (!options.getConnection) throw new NodeOperationError('Conexões não estão disponíveis nesta execução');
            return options.getConnection(id);
          },
          filesDirs: options.filesDirs ?? [],
          getFile: async (id) => {
            if (!options.getFile) throw new NodeOperationError('Arquivos não estão disponíveis nesta execução');
            return options.getFile(id);
          },
          database: (connectionId) => openDatabase(connectionId, node, options, pools),
          getApiEndpoint: async (erpClientId, endpointId) => {
            if (!options.getApiEndpoint) throw new NodeOperationError('O catálogo de APIs não está disponível nesta execução');
            return options.getApiEndpoint(erpClientId, endpointId);
          },
          runCode: (code, itemIndex) => scope.runCode(code, inputs[0] ?? [], itemIndex, timeoutMs),
          runPython: (code, mode) =>
            (options.python ?? defaultPythonRunner()).run({
              code,
              mode,
              input: inputs[0] ?? [],
              nodeOutputs: Object.fromEntries(referencedNodes(code).flatMap((name) => (nodeOutputs[name] ? [[name, nodeOutputs[name]]] : []))),
              execution: { id: options.executionId, mode: options.mode },
              vars: options.vars ?? {},
              timeoutMs,
              signal,
            }),
          executeWorkflow: async (workflowId, items) => {
            if (!options.executeSubworkflow) throw new NodeOperationError('Não é possível executar outro fluxo nesta execução');
            return options.executeSubworkflow({ workflowId, items, signal });
          },
          state,
          meta,
          mode: options.mode,
          ...urls,
          putToWait: pause.putToWait,
          resumeData: pause.resumeData,
          sendResponse: (response) => options.onResponse?.(response),
          logCommand: async (entry) => {
            try {
              await options.onCommand?.({ ...entry, nodeName: node.name, nodeType: node.type });
            } catch {
              // A auditoria não pode derrubar a execução.
            }
          },
          dataTables: options.dataTables!,
        }),
        signal,
      );
      return done({ status: 'success', output, tries: attempt });
    } catch (err) {
      if (options.signal?.aborted) throw new ExecutionCanceled();
      lastError = toNodeError(err, timeout.aborted ? timeoutMs : undefined);
    } finally {
      scope.release();
    }
    if (attempt < maxTries) await sleep(wait * attempt, options.signal);
  }

  if (settings.continueOnFail) {
    const errorItem: Item = { json: { error: lastError.message, details: lastError.details ?? null } };
    return done({ status: 'error', output: [[errorItem]], tries: maxTries, error: lastError });
  }
  return done({ status: 'error', output: [], tries: maxTries, error: lastError });
}

async function openDatabase(connectionId: string, node: NodeInstance, options: ExecuteOptions, pools: DatabasePools): Promise<DatabaseSession> {
  if (!options.getConnection) throw new NodeOperationError('Conexões não estão disponíveis nesta execução');
  const connection = await options.getConnection(connectionId);
  const client = pools.get(connection);

  const logged = async <T extends { rows: unknown[]; rowsAffected: number | null }>(
    operation: DatabaseCommandLog['operation'],
    sql: string,
    params: JsonValue,
    run: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    const entry = { nodeName: node.name, connectionId, connectionType: connection.type, operation, sql, params };
    const report = async (fields: Pick<DatabaseCommandLog, 'rows' | 'rowsAffected' | 'error'>) => {
      try {
        await options.onDatabaseCommand?.({ ...entry, ...fields, durationMs: Date.now() - started });
      } catch {
        // A auditoria não pode derrubar a execução.
      }
    };
    try {
      const result = await run();
      await report({ rows: result.rows.length, rowsAffected: result.rowsAffected });
      return result;
    } catch (err) {
      await report({ rows: null, rowsAffected: null, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  return {
    dialect: client.dialect,
    query: (sql, params, operation = 'query') => logged(operation, sql, params, () => client.query(sql, params)),
    procedure: (name, params) =>
      logged('procedure', name, params.map((p) => ({ name: p.name, direction: p.direction, type: p.type, value: p.value })), () => client.procedure(name, params)),
  };
}

function toNodeError(err: unknown, timedOutAfterMs?: number): NodeError {
  if (timedOutAfterMs !== undefined) return { message: `O nó passou do tempo limite de ${timedOutAfterMs / 1000} s` };
  if (err instanceof NodeOperationError) return { message: err.message, details: err.details };
  if (err instanceof CodeError) return { message: err.message, details: err.logs.length ? { logs: err.logs } : undefined };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
