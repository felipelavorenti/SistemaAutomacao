import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzipSync, gzip, gzipSync } from 'node:zlib';
import type { BinaryData, ExecutionResult, Item, JsonObject, JsonValue, NodeRun, ResumeData, ResumeState, WorkflowDefinition } from '@sa/engine';
import { one, type Queryable } from '../db/db.js';

/** Compacta fora da thread principal: um log grande não segura o worker (nem a renovação do job na fila). */
const gzipAsync = promisify(gzip);

export type ExecutionMode = 'manual' | 'schedule' | 'subworkflow' | 'retry' | 'webhook' | 'trigger' | 'error';

/** Limite por nó do que é guardado de entrada e saída, para o log não crescer demais. */
const MAX_RUN_BYTES = 256 * 1024;
const MAX_ERROR_DETAILS_BYTES = 64 * 1024;
/** Limite do total guardado por execução (antes de compactar); loops longos param de guardar dados depois disso. */
const MAX_EXECUTION_BYTES = 16 * 1024 * 1024;
/** Limite do total de arquivos guardados por execução manual, para baixar na tela. */
const MAX_EXECUTION_FILE_BYTES = 64 * 1024 * 1024;

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

/**
 * Definição do fluxo que a execução rodou, para usar numa lista de colunas. A execução de uma versão salva não guarda cópia
 * (`definition` é NULL): vem de `workflow_versions`. `alias` é o nome da tabela `executions` na consulta.
 */
export const executionDefinitionSql = (alias: string): string =>
  `coalesce(${alias}.definition, (SELECT v.definition FROM workflow_versions v WHERE v.workflow_id = ${alias}.workflow_id AND v.version = ${alias}.workflow_version))`;

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
    /** Worker que roda a execução (subfluxos: o mesmo de quem chamou). */
    workerId?: string | null;
    /** Gatilho de onde começa (webhook, formulário, Error Trigger…); sem ele, o primeiro gatilho do fluxo. */
    startNodeId?: string | null;
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO executions (workflow_id, workflow_version, mode, status, triggered_by, definition, input, retry_of, parent_execution_id, started_at, start_node_id, worker_id)
     VALUES ($1, $2, $3, $9, $4,
             CASE WHEN EXISTS (SELECT 1 FROM workflow_versions v WHERE v.workflow_id = $1 AND v.version = $2 AND v.definition = $5::jsonb) THEN NULL ELSE $5::jsonb END,
             $6, $7, $8, CASE WHEN $9 = 'running' THEN now() END, $10, $11) RETURNING id`,
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
      args.startNodeId ?? null,
      args.workerId ?? null,
    ],
  );
  return row!.id;
}

export function summarize(runs: NodeRun[]): NodeRunSummary[] {
  const byNode = new Map<string, NodeRunSummary>();
  for (const r of runs) {
    const inputItems = r.compacted ? r.compacted.inputItems.reduce((n, i) => n + i, 0) : r.input.reduce((n, i) => n + i.length, 0);
    const outputCounts = r.compacted ? r.compacted.outputItems : r.output.map((o) => o.length);
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
        outputItems: outputCounts,
        error: r.error?.message,
      });
      continue;
    }
    current.runs++;
    current.durationMs += r.durationMs;
    current.tries = Math.max(current.tries, r.tries);
    current.inputItems += inputItems;
    outputCounts.forEach((n, i) => (current.outputItems[i] = (current.outputItems[i] ?? 0) + n));
    if (r.status === 'error') {
      current.status = 'error';
      current.error = r.error?.message;
    }
  }
  return [...byNode.values()];
}

/** Aviso no lugar dos itens de uma entrada ou saída grande demais (o corte por nó). */
const truncatedNote = (items: Item[][], bytes: number): Item[][] => items.map((list) => [{ json: { _truncado: true, itens: list.length, bytes } }]);
/** Aviso no lugar dos itens depois do limite da execução: só a contagem. */
const unsavedNote = (items: Item[][]): Item[][] => items.map((list) => [{ json: { _naoGuardado: true, itens: list.length } }]);

/** Aplica o corte por nó e, passado o limite da execução, guarda só a contagem. */
export function trimRuns(runs: NodeRun[]): NodeRun[] {
  let total = 0;
  return runs.map((run) => {
    if (run.compacted) {
      // Já veio com o aviso no lugar dos itens (RunRecorder); a contagem fica só no resumo.
      const { compacted: _compacted, ...kept } = run;
      total += sizeOfRun(kept);
      return kept;
    }
    const { run: trimmed, size } = trimRunSized(run);
    total += size;
    if (total <= MAX_EXECUTION_BYTES) return trimmed;
    return { ...trimmed, input: unsavedNote(run.input), output: unsavedNote(run.output) };
  });
}

/** Corta entradas e saídas grandes, mantendo a contagem de itens. */
export function trimRun(run: NodeRun): NodeRun {
  return trimRunSized(run).run;
}

const sizeOfRun = (r: NodeRun) => Buffer.byteLength(JSON.stringify({ input: r.input, output: r.output }));

/** O corte por nó e o tamanho que ficou, medido uma vez só (o JSON de uma passagem grande é caro de montar). */
function trimRunSized(run: NodeRun): { run: NodeRun; size: number } {
  const size = sizeOfRun(run);
  if (size <= MAX_RUN_BYTES) return { run, size };
  const trimmed = { ...run, input: truncatedNote(run.input, size), output: truncatedNote(run.output, size) };
  return { run: trimmed, size: sizeOfRun(trimmed) };
}

/**
 * Quantos bytes o JSON de `value` ocupa, no mínimo, parando de somar quando passa de `limit`: serve para saber se
 * algo passou de um tamanho sem montar o texto inteiro. Nunca conta a mais (texto com acento ou aspas ocupa mais).
 */
export function jsonBytesAtLeast(value: unknown, limit: number): number {
  let bytes = 0;
  const walk = (v: unknown): void => {
    if (bytes > limit) return;
    if (v === null || v === undefined) bytes += 4;
    else if (typeof v === 'string') bytes += v.length + 2;
    else if (typeof v === 'number') bytes += Number.isFinite(v) ? String(v).length : 4;
    else if (typeof v === 'boolean') bytes += v ? 4 : 5;
    else if (Array.isArray(v)) {
      bytes += 2 + Math.max(0, v.length - 1);
      for (let i = 0; i < v.length && bytes <= limit; i++) walk(v[i]);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => {
        const x = (v as Record<string, unknown>)[k];
        return x !== undefined && typeof x !== 'function' && typeof x !== 'symbol';
      });
      bytes += 2 + Math.max(0, keys.length - 1);
      for (let i = 0; i < keys.length && bytes <= limit; i++) {
        bytes += keys[i].length + 3;
        walk((v as Record<string, unknown>)[keys[i]]);
      }
    }
  };
  walk(value);
  return bytes;
}

/**
 * Decide o que fica na memória de cada passagem enquanto a execução roda. Sem isto, o histórico segura até o fim
 * os itens de todas as passagens, e um loop grande enche a memória com dados que o log nem vai guardar. Aplica,
 * já no meio da execução, os mesmos cortes do `saveResult` (arquivos dos itens fora, corte por nó, limite da
 * execução), de modo que o que é gravado no fim é igual ao de antes; só deixa de ficar na memória o que seria cortado.
 * Para execuções que não guardam arquivos (as manuais e as reexecuções guardam).
 */
export function createRunRecorder(): (run: NodeRun) => NodeRun {
  let total = 0;
  return (run) => {
    const { runs } = stripBinaries([run], false);
    const slim = runs[0];
    const compact = (input: Item[][], output: Item[][]): NodeRun => ({
      ...slim,
      input,
      output,
      compacted: { inputItems: run.input.map((l) => l.length), outputItems: run.output.map((l) => l.length) },
    });
    // Passou do limite da execução: daqui em diante, só a contagem (e sem medir nada).
    if (total > MAX_EXECUTION_BYTES) return compact(unsavedNote(run.input), unsavedNote(run.output));
    const known = jsonBytesAtLeast({ input: slim.input, output: slim.output }, MAX_RUN_BYTES);
    if (known <= MAX_RUN_BYTES) {
      total += known;
      return total > MAX_EXECUTION_BYTES ? compact(unsavedNote(run.input), unsavedNote(run.output)) : slim;
    }
    const { run: cut, size } = trimRunSized(slim);
    total += size;
    return compact(cut.input, cut.output);
  };
}

function trimDetails(details: JsonValue | undefined): JsonValue | undefined {
  if (details === undefined) return undefined;
  const text = JSON.stringify(details);
  return text.length > MAX_ERROR_DETAILS_BYTES ? { _truncado: true, inicio: text.slice(0, MAX_ERROR_DETAILS_BYTES) } : details;
}

/** Arquivo tirado dos itens para ser guardado à parte. */
export interface ExecutionFile {
  ref: string;
  fileName: string | null;
  mimeType: string;
  content: Buffer;
}

/**
 * Tira o conteúdo dos arquivos dos itens antes de gravar a execução. Com `keepFiles`, cada arquivo
 * diferente (pelo hash) vai para a lista devolvida, até o limite da execução, e o item guarda só a
 * referência; sem, ou passado o limite, o item fica só com os dados do arquivo (`omitted`).
 */
export function stripBinaries(runs: NodeRun[], keepFiles: boolean): { runs: NodeRun[]; files: ExecutionFile[] } {
  const files = new Map<string, ExecutionFile>();
  let total = 0;
  const stripFile = (file: BinaryData): BinaryData => {
    const { data, ...meta } = file;
    if (typeof data !== 'string' || file.omitted || file.ref) return file;
    if (keepFiles) {
      const content = Buffer.from(data, 'base64');
      const ref = createHash('sha256').update(content).digest('hex');
      if (files.has(ref)) return { ...meta, data: '', ref };
      if (total + content.length <= MAX_EXECUTION_FILE_BYTES) {
        total += content.length;
        files.set(ref, { ref, fileName: file.fileName ?? null, mimeType: file.mimeType, content });
        return { ...meta, data: '', ref };
      }
    }
    return { ...meta, data: '', omitted: true };
  };
  const stripItems = (lists: Item[][]): Item[][] =>
    lists.map((list) =>
      list.map((item) => (item.binary ? { json: item.json, binary: Object.fromEntries(Object.entries(item.binary).map(([k, f]) => [k, stripFile(f)])) } : item)),
    );
  const stripped = runs.map((run) => {
    const hasFiles = (lists: Item[][]) => lists.some((list) => list.some((item) => item.binary));
    return hasFiles(run.input) || hasFiles(run.output) ? { ...run, input: stripItems(run.input), output: stripItems(run.output) } : run;
  });
  return { runs: stripped, files: [...files.values()] };
}

/** Mensagem da execução que ia pausar, mas alguém pediu para cancelar enquanto ela rodava. */
export const CANCELED_BEFORE_PAUSE = 'Execução cancelada';

/**
 * Grava o fim da execução e devolve o status gravado. `owner`: só grava se ela ainda é deste worker e está
 * rodando; devolve null quando outro já a encerrou (cancelada ou marcada como interrompida), e aí nada
 * muda. A pausa de uma execução com o cancelamento pedido (cancel_requested) é gravada como cancelada.
 */
export async function saveResult(db: Queryable, id: string, result: ExecutionResult, keepData: boolean, keepFiles = false, owner?: string): Promise<string | null> {
  const stripped = stripBinaries(result.runs, keepData && keepFiles);
  const data = keepData ? await gzipAsync(JSON.stringify({ runs: trimRuns(stripped.runs) })) : null;
  for (const file of stripped.files) {
    await db.query(
      `INSERT INTO execution_files (execution_id, ref, file_name, mime_type, size, content) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (execution_id, ref) DO NOTHING`,
      [id, file.ref, file.fileName, file.mimeType, file.content.length, file.content],
    );
  }
  const error = result.error ? { ...result.error, details: trimDetails(result.error.details) } : null;
  const waiting = result.status === 'waiting';
  const res = await db.query<{ status: string }>(
    `UPDATE executions SET status = CASE WHEN $13 AND cancel_requested THEN 'canceled' ELSE $2 END, started_at = $3,
       finished_at = CASE WHEN $13 AND cancel_requested THEN now() ELSE $4::timestamptz END, summary = $5, data = $6, data_size = $7,
       error = CASE WHEN $13 AND cancel_requested THEN $19::jsonb ELSE $8::jsonb END,
       error_message = CASE WHEN $13 AND cancel_requested THEN $18::text ELSE $9 END, error_node = $10,
       input = CASE WHEN $11 OR $13 THEN input END, custom_data = $12,
       wait_till = CASE WHEN cancel_requested THEN NULL ELSE $14::timestamptz END, wait_info = CASE WHEN cancel_requested THEN NULL ELSE $15::jsonb END,
       resume_state = CASE WHEN cancel_requested THEN NULL ELSE $16::bytea END, resume_data = NULL
     WHERE id = $1 AND ($17::text IS NULL OR (status = 'running' AND worker_id = $17))
     RETURNING status`,
    [
      id,
      result.status,
      result.startedAt,
      waiting ? null : result.finishedAt,
      JSON.stringify(summarize(result.runs)),
      data,
      data?.length ?? null,
      error ? JSON.stringify(error) : null,
      result.error?.message ?? null,
      result.error?.nodeName ?? null,
      keepData,
      customData(result.runs),
      waiting,
      waiting ? (result.wait?.until ?? null) : null,
      waiting && result.wait ? JSON.stringify(result.wait) : null,
      waiting && result.resumeState ? encodeJson(result.resumeState) : null,
      owner ?? null,
      CANCELED_BEFORE_PAUSE,
      JSON.stringify({ message: CANCELED_BEFORE_PAUSE }),
    ],
  );
  return res.rows[0]?.status ?? null;
}

export function encodeJson(value: unknown): Buffer {
  return gzipSync(JSON.stringify(value));
}

export function decodeJson<T>(data: Buffer | null): T | null {
  return data ? (JSON.parse(gunzipSync(data).toString('utf8')) as T) : null;
}

/** Estado e dados da retomada de uma execução pausada que voltou para a fila. */
export function decodeResume(row: { resume_state: Buffer | null; resume_data: Buffer | null }): { state: ResumeState; data?: ResumeData } | undefined {
  const state = decodeJson<ResumeState>(row.resume_state);
  if (!state) return undefined;
  return { state, data: decodeJson<ResumeData>(row.resume_data) ?? undefined };
}

/** Junta o que os nós Execution Data gravaram; um nó rodado depois sobrescreve a mesma chave. */
export function customData(runs: NodeRun[]): string | null {
  const merged: JsonObject = {};
  for (const run of runs) {
    const saved = run.meta?.executionData;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.assign(merged, saved);
  }
  return Object.keys(merged).length ? JSON.stringify(merged) : null;
}

/** Marca a execução como erro. `owner`: como no saveResult, só a que ainda é deste worker; devolve se gravou. */
export async function failExecution(db: Queryable, id: string, message: string, owner?: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE executions SET status = 'error', finished_at = now(), started_at = coalesce(started_at, now()),
       error_message = $2, error = $3, resume_state = NULL, resume_data = NULL, wait_till = NULL
     WHERE id = $1 AND CASE WHEN $4::text IS NULL THEN status IN ('queued', 'running') ELSE status = 'running' AND worker_id = $4 END`,
    [id, message, JSON.stringify({ message }), owner ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Execução que não chegou à fila (o Redis falhou ao enfileirar): vira erro. Quem pediu recebeu o erro e
 * pode tentar de novo; sem isto, ela ficaria Na fila, e a procura de execuções sem job a encerraria
 * minutos depois. Só a que ainda está na fila: se o job chegou ao Redis apesar do erro, ele não roda.
 */
export async function failQueued(db: Queryable, id: string, err: unknown): Promise<void> {
  const message = `Não foi possível pôr a execução na fila: ${err instanceof Error ? err.message : String(err)}`;
  await db
    .query(
      `UPDATE executions SET status = 'error', started_at = coalesce(started_at, now()), finished_at = now(), error_message = $2, error = $3
       WHERE id = $1 AND status = 'queued'`,
      [id, message, JSON.stringify({ message })],
    )
    .catch((e) => console.error(`Execução ${id} não foi marcada como erro:`, e));
}

/** Põe na fila uma execução recém-criada; se o Redis falhar, ela vira erro (failQueued) e o erro segue. */
export async function enqueueOrFail(db: Queryable, queue: { enqueueRun(id: string): Promise<void> }, id: string): Promise<void> {
  try {
    await queue.enqueueRun(id);
  } catch (err) {
    await failQueued(db, id, err);
    throw err;
  }
}

/** Quantas linhas cada comando da limpeza apaga: tudo de uma vez seguraria o banco com meses de histórico. */
export const CLEANUP_BATCH = 5000;

/**
 * Apaga, em lotes, os comandos SQL e as execuções terminadas mais antigos que o prazo. Execuções na
 * fila, rodando ou esperando ficam, mesmo antigas. Os comandos saem primeiro: apagar a execução antes
 * faria o banco limpar a referência de cada comando dela (milhares por execução) dentro do mesmo lote.
 */
export async function cleanupOldExecutions(db: Queryable, days: number, batch = CLEANUP_BATCH): Promise<{ executions: number; dbCommands: number }> {
  const deleteAll = async (sql: string) => {
    let total = 0;
    for (;;) {
      const res = await db.query(sql, [days, batch]);
      total += res.rowCount ?? 0;
      if ((res.rowCount ?? 0) < batch) return total;
    }
  };
  const dbCommands = await deleteAll(`DELETE FROM db_commands WHERE id IN (SELECT id FROM db_commands WHERE at < now() - make_interval(days => $1) LIMIT $2)`);
  const executions = await deleteAll(
    `DELETE FROM executions WHERE id IN (
       SELECT id FROM executions WHERE created_at < now() - make_interval(days => $1) AND status IN ('success', 'error', 'canceled') LIMIT $2)`,
  );
  return { executions, dbCommands };
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
