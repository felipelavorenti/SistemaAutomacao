import { gunzipSync, gzipSync } from 'node:zlib';
import type { ExecutionResult, Item, JsonValue, NodeRun, WorkflowDefinition } from '@sa/engine';
import { one, type Queryable } from '../db/db.js';

export type ExecutionMode = 'manual' | 'schedule' | 'subworkflow' | 'retry';

/** Limite por nó do que é guardado de entrada e saída, para o log não crescer demais. */
const MAX_RUN_BYTES = 256 * 1024;
const MAX_ERROR_DETAILS_BYTES = 64 * 1024;
/** Limite do total guardado por execução (antes de compactar); loops longos param de guardar dados depois disso. */
const MAX_EXECUTION_BYTES = 16 * 1024 * 1024;

/** Resumo por nó; um nó que rodou várias vezes (loop) vira uma linha só. */
export interface NodeRunSummary {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: NodeRun['status'];
  startedAt: string;
  durationMs: number;
  tries: number;
  runs: number;
  inputItems: number;
  outputItems: number[];
  error?: string;
}

export async function createExecution(
  db: Queryable,
  args: {
    workflowId: string;
    workflowVersion: number | null;
    mode: ExecutionMode;
    triggeredBy: string | null;
    definition: WorkflowDefinition;
    input?: Item[] | null;
    retryOf?: string | null;
    parentExecutionId?: string | null;
    /** Subfluxos já nascem rodando, dentro da execução de quem chamou. */
    status?: 'queued' | 'running';
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO executions (workflow_id, workflow_version, mode, status, triggered_by, definition, input, retry_of, parent_execution_id, started_at)
     VALUES ($1, $2, $3, $9, $4, $5, $6, $7, $8, CASE WHEN $9 = 'running' THEN now() END) RETURNING id`,
    [
      args.workflowId,
      args.workflowVersion,
      args.mode,
      args.triggeredBy,
      JSON.stringify(args.definition),
      args.input ? JSON.stringify(args.input) : null,
      args.retryOf ?? null,
      args.parentExecutionId ?? null,
      args.status ?? 'queued',
    ],
  );
  return row!.id;
}

export function summarize(runs: NodeRun[]): NodeRunSummary[] {
  const byNode = new Map<string, NodeRunSummary>();
  for (const r of runs) {
    const inputItems = r.input.reduce((n, i) => n + i.length, 0);
    const current = byNode.get(r.nodeId);
    if (!current) {
      byNode.set(r.nodeId, {
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        nodeType: r.nodeType,
        status: r.status,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        tries: r.tries,
        runs: 1,
        inputItems,
        outputItems: r.output.map((o) => o.length),
        error: r.error?.message,
      });
      continue;
    }
    current.runs++;
    current.durationMs += r.durationMs;
    current.tries = Math.max(current.tries, r.tries);
    current.inputItems += inputItems;
    r.output.forEach((o, i) => (current.outputItems[i] = (current.outputItems[i] ?? 0) + o.length));
    if (r.status === 'error') {
      current.status = 'error';
      current.error = r.error?.message;
    }
  }
  return [...byNode.values()];
}

/** Aplica o corte por nó e, passado o limite da execução, guarda só a contagem. */
export function trimRuns(runs: NodeRun[]): NodeRun[] {
  let total = 0;
  return runs.map((run) => {
    const trimmed = trimRun(run);
    const size = Buffer.byteLength(JSON.stringify({ input: trimmed.input, output: trimmed.output }));
    total += size;
    if (total <= MAX_EXECUTION_BYTES) return trimmed;
    const note = (items: Item[][]) => items.map((list) => [{ json: { _naoGuardado: true, itens: list.length } }]);
    return { ...trimmed, input: note(run.input), output: note(run.output) };
  });
}

/** Corta entradas e saídas grandes, mantendo a contagem de itens. */
export function trimRun(run: NodeRun): NodeRun {
  const size = Buffer.byteLength(JSON.stringify({ input: run.input, output: run.output }));
  if (size <= MAX_RUN_BYTES) return run;
  const note = (items: Item[][]) => items.map((list) => [{ json: { _truncado: true, itens: list.length, bytes: size } }]);
  return { ...run, input: note(run.input), output: note(run.output) };
}

function trimDetails(details: JsonValue | undefined): JsonValue | undefined {
  if (details === undefined) return undefined;
  const text = JSON.stringify(details);
  return text.length > MAX_ERROR_DETAILS_BYTES ? { _truncado: true, inicio: text.slice(0, MAX_ERROR_DETAILS_BYTES) } : details;
}

export async function saveResult(db: Queryable, id: string, result: ExecutionResult, keepData: boolean): Promise<void> {
  const data = keepData ? gzipSync(JSON.stringify({ runs: trimRuns(result.runs) })) : null;
  const error = result.error ? { ...result.error, details: trimDetails(result.error.details) } : null;
  await db.query(
    `UPDATE executions SET status = $2, started_at = $3, finished_at = $4, summary = $5, data = $6, data_size = $7,
       error = $8, error_message = $9, error_node = $10, input = CASE WHEN $11 THEN input END
     WHERE id = $1`,
    [
      id,
      result.status,
      result.startedAt,
      result.finishedAt,
      JSON.stringify(summarize(result.runs)),
      data,
      data?.length ?? null,
      error ? JSON.stringify(error) : null,
      result.error?.message ?? null,
      result.error?.nodeName ?? null,
      keepData,
    ],
  );
}

export async function failExecution(db: Queryable, id: string, message: string): Promise<void> {
  await db.query(
    `UPDATE executions SET status = 'error', finished_at = now(), started_at = coalesce(started_at, now()),
       error_message = $2, error = $3 WHERE id = $1 AND status IN ('queued', 'running')`,
    [id, message, JSON.stringify({ message })],
  );
}

export function decodeData(data: Buffer | null): { runs: NodeRun[] } | null {
  if (!data) return null;
  return JSON.parse(gunzipSync(data).toString('utf8'));
}

/** Decide se a entrada e a saída de cada nó ficam guardadas. */
export function shouldKeepData(mode: ExecutionMode, status: ExecutionResult['status'], keepSuccessData: boolean): boolean {
  if (status !== 'success') return true;
  if (mode === 'manual' || mode === 'retry') return true;
  return keepSuccessData;
}
