import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { executeWorkflow, type ConnectionData, type Item, type JsonObject, type WorkflowDefinition } from '@sa/engine';
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
