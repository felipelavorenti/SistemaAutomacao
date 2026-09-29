import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  executeWorkflow,
  NodeOperationError,
  type ConnectionData,
  type ExecuteOptions,
  type Item,
  type JsonObject,
  type WorkflowDefinition,
} from '@sa/engine';
import type { Config } from '../config.js';
import { one, type Db } from '../db/db.js';
import { decryptJson } from '../lib/crypto.js';
import { CANCEL_CHANNEL, QUEUE_NAME, type JobData } from './queue.js';
import { createExecution, failExecution, saveResult, shouldKeepData, type ExecutionMode } from './store.js';

interface ExecutionRow {
  id: string;
  workflow_id: string;
  mode: ExecutionMode;
  status: string;
  definition: WorkflowDefinition;
  input: Item[] | null;
}

/** Quantos subfluxos podem ser chamados um dentro do outro. */
const MAX_SUBWORKFLOW_DEPTH = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkerHandle {
  close(): Promise<void>;
}

export function startWorker(deps: { db: Db; config: Config; redis: Redis; subscriber: Redis }): WorkerHandle {
  const { db, config, redis, subscriber } = deps;
  const running = new Map<string, AbortController>();

  void subscriber.subscribe(CANCEL_CHANNEL);
  subscriber.on('message', (channel, executionId) => {
    if (channel === CANCEL_CHANNEL) running.get(executionId)?.abort();
  });

  const getConnection = async (id: string): Promise<ConnectionData> => {
    const row = await one<{ id: string; type: string; data_encrypted: Buffer }>(db, 'SELECT id, type, data_encrypted FROM connections WHERE id = $1', [id]);
    if (!row) throw new Error(`Conexão ${id} não existe mais`);
    return { id: row.id, type: row.type, data: decryptJson<JsonObject>(config.encryptionKey, row.data_encrypted) };
  };

  /**
   * Roda um subfluxo dentro da execução de quem chamou (sem passar pela fila,
   * para não disputar vaga com o próprio pai) e registra a execução filha.
   */
  const subworkflowRunner =
    (parentId: string, rootMode: ExecutionMode, depth: number): ExecuteOptions['executeSubworkflow'] =>
    async ({ workflowId, items, signal }) => {
      if (depth > MAX_SUBWORKFLOW_DEPTH) {
        throw new NodeOperationError(`Passou do limite de ${MAX_SUBWORKFLOW_DEPTH} subfluxos chamados um dentro do outro`);
      }
      const wf = UUID.test(workflowId)
        ? await one<{ id: string; name: string; version: number; definition: WorkflowDefinition }>(
            db,
            'SELECT id, name, version, definition FROM workflows WHERE id = $1',
            [workflowId],
          )
        : null;
      if (!wf) throw new NodeOperationError(`O fluxo ${workflowId} não existe`);
      const start = wf.definition.nodes.find((n) => n.type === 'executeWorkflowTrigger' && !n.disabled);
      if (!start) throw new NodeOperationError(`O fluxo "${wf.name}" não começa pelo gatilho "Chamado por outro fluxo"`);

      const id = await createExecution(db, {
        workflowId: wf.id,
        workflowVersion: wf.version,
        mode: 'subworkflow',
        triggeredBy: null,
        definition: wf.definition,
        input: items,
        parentExecutionId: parentId,
        status: 'running',
      });
      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });
      running.set(id, controller);
      try {
        const result = await executeWorkflow({
          workflow: wf.definition,
          executionId: id,
          mode: 'subworkflow',
          startNodeId: start.id,
          triggerItems: items,
          getConnection,
          signal: controller.signal,
          executeSubworkflow: subworkflowRunner(id, rootMode, depth + 1),
        });
        // Chamado a partir de um teste manual: guarda os dados do subfluxo também, para depurar.
        const keepAs: ExecutionMode = rootMode === 'manual' || rootMode === 'retry' ? rootMode : 'subworkflow';
        await saveResult(db, id, result, shouldKeepData(keepAs, result.status, config.keepSuccessData));
        return { executionId: id, status: result.status, output: result.lastOutput, error: result.error };
      } catch (err) {
        await failExecution(db, id, err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        signal.removeEventListener('abort', onParentAbort);
        running.delete(id);
      }
    };

  const run = async (executionId: string) => {
    const claimed = await one<ExecutionRow>(
      db,
      `UPDATE executions SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'
       RETURNING id, workflow_id, mode, status, definition, input`,
      [executionId],
    );
    if (!claimed) return; // cancelada antes de começar, ou já processada

    const controller = new AbortController();
    running.set(executionId, controller);
    try {
      const result = await executeWorkflow({
        workflow: claimed.definition,
        executionId,
        mode: claimed.mode,
        triggerItems: claimed.input ?? undefined,
        getConnection,
        signal: controller.signal,
        executeSubworkflow: subworkflowRunner(executionId, claimed.mode, 1),
      });
      await saveResult(db, executionId, result, shouldKeepData(claimed.mode, result.status, config.keepSuccessData));
    } catch (err) {
      await failExecution(db, executionId, err instanceof Error ? err.message : String(err));
    } finally {
      running.delete(executionId);
    }
  };

  const worker = new Worker<JobData>(
    QUEUE_NAME,
    async (job: Job<JobData>) => {
      const data = job.data;
      if (data.kind === 'run') {
        await run(data.executionId);
      } else if (data.kind === 'scheduled') {
        const wf = await one<{ id: string; version: number; definition: WorkflowDefinition }>(
          db,
          'SELECT id, version, definition FROM workflows WHERE id = $1 AND active',
          [data.workflowId],
        );
        if (!wf) return;
        const id = await createExecution(db, {
          workflowId: wf.id,
          workflowVersion: wf.version,
          mode: 'schedule',
          triggeredBy: null,
          definition: wf.definition,
        });
        await run(id);
      } else if (data.kind === 'cleanup' && config.executionRetentionDays > 0) {
        await db.query(`DELETE FROM executions WHERE created_at < now() - make_interval(days => $1)`, [config.executionRetentionDays]);
      }
    },
    { connection: redis, concurrency: config.workerConcurrency, maxStalledCount: 0 },
  );

  // Se o worker cair no meio, o job é marcado como travado e a execução vira erro.
  worker.on('failed', (job, err) => {
    if (job?.data.kind === 'run') void failExecution(db, job.data.executionId, `Execução interrompida: ${err.message}`);
  });

  return {
    async close() {
      for (const c of running.values()) c.abort();
      await worker.close();
      await subscriber.unsubscribe(CANCEL_CHANNEL);
    },
  };
}
