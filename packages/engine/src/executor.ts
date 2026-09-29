import { CodeError, ExpressionSandbox, type SandboxOptions } from './expressions/sandbox.js';
import type { ConnectionData, NodeType, SubworkflowResult } from './node-types.js';
import { NodeOperationError } from './node-types.js';
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
  WorkflowDefinition,
} from './types.js';

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
  signal?: AbortSignal;
  onNodeFinished?: (run: NodeRun) => void | Promise<void>;
  registry?: NodeRegistry;
  sandbox?: SandboxOptions;
  /** Tempo máximo padrão de cada nó, em milissegundos. */
  defaultNodeTimeoutMs?: number;
  /** Executa outro fluxo (nó Execute Workflow). Quem chama cuida de registrar a execução filha. */
  executeSubworkflow?: (args: { workflowId: string; items: Item[]; signal: AbortSignal }) => Promise<SubworkflowResult>;
  /** Limite de execuções de nós, para um loop sem fim não travar o worker. */
  maxNodeRuns?: number;
}

class ExecutionCanceled extends Error {}

interface PendingNode {
  inputs: Item[][];
  received: boolean[];
  /** Momento (em número de nós executados) em que começou a esperar. */
  seq: number;
}

export async function executeWorkflow(options: ExecuteOptions): Promise<ExecutionResult> {
  const registry = options.registry ?? defaultRegistry;
  const { workflow } = options;
  const startedAt = new Date().toISOString();
  const runs: NodeRun[] = [];
  const nodeOutputs: Record<string, Item[]> = {};
  let lastOutput: Item[] = [];

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Connection[]>();
  for (const c of workflow.connections) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    outgoing.set(c.from, [...(outgoing.get(c.from) ?? []), c]);
  }

  const start = findStartNode(workflow, registry, options.startNodeId);
  const sandbox = new ExpressionSandbox(options.sandbox);

  // Nós prontos para rodar, com os itens de cada entrada. Nós de várias
  // entradas (ex.: Merge) esperam em `waiting` até receber todas.
  const ready: { node: NodeInstance; inputs: Item[][] }[] = [{ node: start, inputs: [options.triggerItems ?? []] }];
  const waiting = new Map<string, PendingNode>();
  // Estado dos nós que duram a execução toda (Loop) e os que ainda têm lotes pendentes,
  // do mais antigo para o mais recente, com o momento da última execução de cada um.
  const nodeState = new Map<string, Record<string, unknown>>();
  const pendingWork: { id: string; seq: number }[] = [];
  const maxRuns = options.maxNodeRuns ?? 50_000;
  let seq = 0;

  const finish = (status: ExecutionResult['status'], error?: ExecutionResult['error']): ExecutionResult => {
    sandbox.dispose();
    return { status, startedAt, finishedAt: new Date().toISOString(), runs, error, lastOutput };
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

      const { node, inputs } = ready.pop()!;
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
      const run = await runNode(node, type, inputs, nodeOutputs, options, sandbox, state);
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
    throw err;
  }
}

function findStartNode(workflow: WorkflowDefinition, registry: NodeRegistry, startNodeId?: string): NodeInstance {
  if (startNodeId) {
    const node = workflow.nodes.find((n) => n.id === startNodeId);
    if (!node) throw new Error(`Nó inicial ${startNodeId} não existe no fluxo`);
    return node;
  }
  const trigger = workflow.nodes.find((n) => !n.disabled && registry.get(n.type)?.description.group === 'trigger');
  if (!trigger) throw new Error('O fluxo não tem gatilho');
  return trigger;
}

async function runNode(
  node: NodeInstance,
  type: NodeType,
  inputs: Item[][],
  nodeOutputs: Record<string, Item[]>,
  options: ExecuteOptions,
  sandbox: ExpressionSandbox,
  state: Record<string, unknown>,
): Promise<NodeRun> {
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
  const timeoutMs = settings.timeoutMs ?? type.description.defaultTimeoutMs ?? options.defaultNodeTimeoutMs ?? 120_000;
  const defaults = Object.fromEntries(type.description.properties.map((p) => [p.name, p.default]));

  let lastError: NodeError = { message: 'Erro desconhecido' };
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const scope = await sandbox.createScope({
      nodeOutputs,
      execution: { id: options.executionId, mode: options.mode },
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
          runCode: (code, itemIndex) => scope.runCode(code, inputs[0] ?? [], itemIndex, timeoutMs),
          executeWorkflow: async (workflowId, items) => {
            if (!options.executeSubworkflow) throw new NodeOperationError('Não é possível executar outro fluxo nesta execução');
            return options.executeSubworkflow({ workflowId, items, signal });
          },
          state,
          meta,
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
