import { randomUUID } from 'node:crypto';
import { Worker, type Job, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  closeDefaultPythonRunner,
  DatabasePools,
  executeWorkflow,
  NodeOperationError,
  type CommandLog,
  type DatabaseCommandLog,
  type ExecutionResult,
  type JsonValue,
  type ConnectionData,
  type ExecuteOptions,
  type FileData,
  type Item,
  type JsonObject,
  type WorkflowDefinition,
} from '@sa/engine';
import type { Config } from '../config.js';
import { many, one, transaction, type Db } from '../db/db.js';
import { loadApiEndpoint } from '../lib/catalog.js';
import { decryptJson } from '../lib/crypto.js';
import { ExecutionAccess, executionOwner } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { PgDataTableStore } from '../lib/data-tables.js';
import { CANCEL_CHANNEL, ExecutionQueue, executionChannel, HEARTBEAT_TTL_MS, isAbandoned, QUEUE_NAME, type JobData } from './queue.js';
import { CANCELED_BEFORE_PAUSE, cleanupOldExecutions, createExecution, decodeResume, enqueueOrFail, failExecution, saveResult, shouldKeepData, type ExecutionMode } from './store.js';
import type { ExecutionEvent } from './events.js';

/** Limites do que fica guardado de cada comando SQL. */
const MAX_SQL_CHARS = 32 * 1024;
/** Limite do texto de cada comando do Execute Command e do SSH na auditoria. */
const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_PARAMS_CHARS = 8 * 1024;

interface ExecutionRow {
  id: string;
  triggered_by: string | null;
  workflow_id: string;
  workflow_version: number | null;
  mode: ExecutionMode;
  status: string;
  definition: WorkflowDefinition;
  input: Item[] | null;
  start_node_id: string | null;
  retry_of: string | null;
  resume_state: Buffer | null;
  resume_data: Buffer | null;
}

/** Modos de produção: quando falham, rodam o fluxo de erro configurado. */
const ERROR_WORKFLOW_MODES = new Set<ExecutionMode>(['schedule', 'webhook', 'trigger']);

/** Quantos subfluxos podem ser chamados um dentro do outro. */
const MAX_SUBWORKFLOW_DEPTH = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** De quanto em quanto tempo o worker procura execuções abandonadas por um worker que parou. */
const SWEEP_INTERVAL_MS = 60_000;
/** De quanto em quanto tempo o worker renova o aviso de que está vivo (vale HEARTBEAT_TTL_MS). */
const HEARTBEAT_INTERVAL_MS = HEARTBEAT_TTL_MS / 4;
/** Execução na fila ou com a hora de voltar vencida, sem job, há mais que isto: perdeu o job. */
const ORPHAN_GRACE_SECONDS = 120;
/** Execução na fila que perdeu o job há mais que isto (ou entrou na fila há mais que isto) não roda mais: vira erro. */
const ORPHAN_REQUEUE_LIMIT_SECONDS = 60 * 60;
const ORPHAN_MESSAGE = 'Execução interrompida: ficou mais de 1 hora na fila sem o job que a rodaria';
const NEVER_QUEUED_MESSAGE = 'Execução interrompida: o job dela não chegou à fila (o servidor parou antes de pô-la na fila, ou o Redis perdeu o job)';
/** Por quanto tempo um pedido de cancelamento vale para uma execução que este worker ainda vai registrar. */
const EARLY_CANCEL_MS = 60_000;
/**
 * Tempo sem renovar a trava do job até a fila achar que o worker travou. Renovada a cada metade
 * disso; um nó que segura o processador por menos que isso não derruba mais a execução.
 */
const LOCK_DURATION_MS = 5 * 60_000;
const ABANDONED_MESSAGE = 'Execução interrompida: o servidor foi reiniciado ou o worker parou no meio dela';
const SHUTDOWN_MESSAGE = 'Execução interrompida porque o servidor foi desligado';

export interface WorkerHandle {
  close(): Promise<void>;
}

/** Opções do worker da fila. */
export function workerOptions(config: Config, workerId: string): Omit<WorkerOptions, 'connection'> {
  return {
    concurrency: config.workerConcurrency,
    // Job travado (o worker parou de renovar a trava) não roda de novo: falha, e a procura de abandonadas
    // marca a execução como interrompida. maxStalledCount não vale para os jobs dos agendamentos (a fila
    // sempre os devolve para a espera); maxStartedAttempts vale para todos e barra a segunda rodada.
    maxStalledCount: 0,
    maxStartedAttempts: 1,
    lockDuration: LOCK_DURATION_MS,
    // Nome da conexão no Redis (bull:<fila>:w:<id>): um dos sinais de que o worker está vivo.
    name: workerId,
  };
}

export function startWorker(deps: {
  db: Db;
  config: Config;
  redis: Redis;
  subscriber: Redis;
  /** Intervalo da procura de execuções abandonadas (os testes usam um menor). */
  sweepIntervalMs?: number;
}): WorkerHandle {
  const { db, config, redis, subscriber } = deps;
  /** Nome deste worker no Redis; gravado em cada execução que ele pega. */
  const workerId = randomUUID();
  const running = new Map<string, AbortController>();
  let stopping = false;
  const pools = new DatabasePools();
  const dataTables = new PgDataTableStore(db);
  const queue = new ExecutionQueue(redis);
  const publicUrl = config.publicUrl ?? `http://localhost:${config.port}`;
  const internalUrl = config.internalUrl ?? publicUrl;

  /** Avisa quem chamou por HTTP (webhook, formulário); sem ninguém escutando, não manda nada. */
  const publish = async (executionId: string, event: ExecutionEvent) => {
    try {
      const channel = executionChannel(executionId);
      const [, listeners] = (await redis.call('PUBSUB', 'NUMSUB', channel)) as [string, number];
      if (Number(listeners) > 0) await redis.publish(channel, JSON.stringify(event));
    } catch (err) {
      console.error(`Aviso da execução ${executionId} não foi enviado:`, err);
    }
  };

  /** Fluxo de erro: roda o fluxo escolhido nas configurações quando uma execução de produção falha. */
  const runErrorWorkflow = async (row: ExecutionRow, error: { message: string; nodeName?: string; details?: JsonValue } | undefined) => {
    const target = row.definition.settings?.errorWorkflowId;
    if (!target || !ERROR_WORKFLOW_MODES.has(row.mode) || !UUID.test(target)) return;
    const [wf, source] = await Promise.all([
      one<{ id: string; name: string; version: number; definition: WorkflowDefinition }>(db, 'SELECT id, name, version, definition FROM workflows WHERE id = $1', [target]),
      one<{ name: string }>(db, 'SELECT name FROM workflows WHERE id = $1', [row.workflow_id]),
    ]);
    const start = wf?.definition.nodes.find((n) => n.type === 'errorTrigger' && !n.disabled);
    if (!wf || !start) {
      console.error(`Fluxo de erro ${target} não existe ou não tem o gatilho Error Trigger`);
      return;
    }
    const payload: JsonObject = {
      execution: {
        id: row.id,
        url: `${publicUrl}/execucoes/${row.id}`,
        ...(row.retry_of ? { retryOf: row.retry_of } : {}),
        error: { message: error?.message ?? 'Erro desconhecido', ...(error?.details !== undefined ? { details: error.details } : {}) },
        lastNodeExecuted: error?.nodeName ?? null,
        mode: row.mode,
      },
      workflow: { id: row.workflow_id, name: source?.name ?? null },
    };
    const id = await createExecution(db, {
      workflowId: wf.id,
      workflowVersion: wf.version,
      mode: 'error',
      triggeredBy: null,
      definition: wf.definition,
      input: [{ json: payload }],
      startNodeId: start.id,
    });
    await enqueueOrFail(db, queue, id);
  };

  /**
   * Pedido de cancelamento que chegou antes de a execução entrar em `running` (o aviso pelo Redis chegou
   * antes da resposta do banco ao pegar a execução): vale quando ela entrar.
   */
  const earlyCancels = new Map<string, number>();
  void subscriber.subscribe(CANCEL_CHANNEL);
  subscriber.on('message', (channel, executionId) => {
    if (channel !== CANCEL_CHANNEL) return;
    const controller = running.get(executionId);
    if (controller) {
      controller.abort();
      return;
    }
    const now = Date.now();
    for (const [id, at] of earlyCancels) if (now - at > EARLY_CANCEL_MS) earlyCancels.delete(id);
    earlyCancels.set(executionId, now);
  });

  /** Dependências de cada execução: conexões e catálogo de APIs (com a conferência de acesso), auditoria dos comandos SQL. */
  const executionDeps = (
    executionId: string,
    execution: { workflowId: string; workflowVersion: number | null; triggeredBy: string | null; definition: WorkflowDefinition },
  ) => {
    const { workflowId, triggeredBy } = execution;
    const access = new ExecutionAccess(db, execution.definition, () => executionOwner(db, execution));
    let workflowName: Promise<string | null> | null = null;
    const connectionInfo = new Map<string, Promise<{ name: string | null; client_id: string | null; client_name: string | null } | null>>();

    const onDatabaseCommand = async (entry: DatabaseCommandLog) => {
      workflowName ??= one<{ name: string }>(db, 'SELECT name FROM workflows WHERE id = $1', [workflowId]).then((r) => r?.name ?? null);
      if (!connectionInfo.has(entry.connectionId)) {
        connectionInfo.set(
          entry.connectionId,
          one<{ name: string | null; client_id: string | null; client_name: string | null }>(
            db,
            'SELECT c.name, c.client_id, cl.name AS client_name FROM connections c LEFT JOIN clients cl ON cl.id = c.client_id WHERE c.id = $1',
            [entry.connectionId],
          ).then((r) => r ?? null),
        );
      }
      const conn = await connectionInfo.get(entry.connectionId)!;
      const params = JSON.stringify(entry.params ?? null);
      await db.query(
        `INSERT INTO db_commands (execution_id, workflow_id, workflow_name, node_name, connection_id, connection_name, client_id, client_name,
           db_type, operation, sql, params, rows, rows_affected, duration_ms, error, triggered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          executionId,
          workflowId,
          await workflowName,
          entry.nodeName,
          entry.connectionId,
          conn?.name ?? null,
          conn?.client_id ?? null,
          conn?.client_name ?? null,
          entry.connectionType,
          entry.operation,
          entry.sql.slice(0, MAX_SQL_CHARS),
          params.length > MAX_PARAMS_CHARS ? JSON.stringify({ _truncado: true, inicio: params.slice(0, MAX_PARAMS_CHARS) } satisfies Record<string, JsonValue>) : params,
          entry.rows,
          entry.rowsAffected,
          entry.durationMs,
          entry.error?.slice(0, 4000) ?? null,
          triggeredBy,
        ],
      );
    };

    /** Execute Command e SSH: cada comando vai para a Auditoria, em nome de quem disparou. */
    const onCommand = async (entry: CommandLog) => {
      workflowName ??= one<{ name: string }>(db, 'SELECT name FROM workflows WHERE id = $1', [workflowId]).then((r) => r?.name ?? null);
      await audit(db, {
        userId: triggeredBy,
        action: 'command',
        entityType: 'execution',
        entityId: executionId,
        entityName: await workflowName,
        after: {
          workflowId,
          node: entry.nodeName,
          nodeType: entry.nodeType,
          command: entry.command.slice(0, MAX_COMMAND_CHARS),
          ...(entry.host ? { host: entry.host } : {}),
          exitCode: entry.exitCode,
          durationMs: entry.durationMs,
          ...(entry.error ? { error: entry.error.slice(0, 2000) } : {}),
        },
      });
    };

    const getConnection = async (id: string): Promise<ConnectionData> => {
      const row = UUID.test(id)
        ? await one<{ id: string; type: string; client_id: string | null; data_encrypted: Buffer }>(
            db,
            'SELECT id, type, client_id, data_encrypted FROM connections WHERE id = $1',
            [id],
          )
        : undefined;
      if (!row) throw new Error(`Conexão ${id} não existe mais`);
      await access.checkConnection(row.id, row.client_id);
      return { id: row.id, type: row.type, data: decryptJson<JsonObject>(config.encryptionKey, row.data_encrypted) };
    };

    return {
      access,
      getConnection,
      onDatabaseCommand,
      onCommand,
      dataTables,
      databases: pools,
      getApiEndpoint: async (erpClientId: string, endpointId: string) => {
        if (UUID.test(erpClientId)) await access.checkErpClient(erpClientId);
        return loadApiEndpoint(db, config.encryptionKey, erpClientId, endpointId);
      },
      filesDirs: config.filesDirs,
      getFile: async (id: string): Promise<FileData> => {
        const row = await one<{ id: string; name: string; mime_type: string; content: Buffer }>(db, 'SELECT id, name, mime_type, content FROM files WHERE id = $1', [id]);
        if (!row) throw new Error(`O arquivo ${id} não existe mais; escolha o arquivo de novo no nó`);
        return { id: row.id, name: row.name, mimeType: row.mime_type, content: row.content };
      },
    };
  };

  /** Desligando o servidor, a execução abortada vira erro (e não "cancelada"), e o fluxo de erro roda. */
  const interruptedOnShutdown = (result: ExecutionResult): ExecutionResult =>
    stopping && result.status === 'canceled' ? { ...result, status: 'error', error: { message: SHUTDOWN_MESSAGE } } : result;

  /**
   * Roda um subfluxo dentro da execução de quem chamou (sem passar pela fila,
   * para não disputar vaga com o próprio pai) e registra a execução filha.
   */
  const subworkflowRunner =
    (parentId: string, rootMode: ExecutionMode, depth: number, triggeredBy: string | null, access: ExecutionAccess): ExecuteOptions['executeSubworkflow'] =>
    async ({ workflowId, items, signal }) => {
      if (depth > MAX_SUBWORKFLOW_DEPTH) {
        throw new NodeOperationError(`Passou do limite de ${MAX_SUBWORKFLOW_DEPTH} subfluxos chamados um dentro do outro`);
      }
      const wf = UUID.test(workflowId)
        ? await one<{ id: string; name: string; folder_id: string; version: number; definition: WorkflowDefinition }>(
            db,
            'SELECT id, name, folder_id, version, definition FROM workflows WHERE id = $1',
            [workflowId],
          )
        : null;
      if (!wf) throw new NodeOperationError(`O fluxo ${workflowId} não existe`);
      await access.checkWorkflow(wf.id, wf.folder_id);
      const start = wf.definition.nodes.find((n) => n.type === 'executeWorkflowTrigger' && !n.disabled);
      if (!start) throw new NodeOperationError(`O fluxo "${wf.name}" não começa pelo gatilho "Chamado por outro fluxo"`);

      const id = await createExecution(db, {
        workflowId: wf.id,
        workflowVersion: wf.version,
        mode: 'subworkflow',
        triggeredBy,
        definition: wf.definition,
        input: items,
        parentExecutionId: parentId,
        status: 'running',
        workerId,
      });
      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });
      running.set(id, controller);
      try {
        const { access: childAccess, ...deps } = executionDeps(id, { workflowId: wf.id, workflowVersion: wf.version, triggeredBy, definition: wf.definition });
        const result = await executeWorkflow({
          workflow: wf.definition,
          executionId: id,
          mode: 'subworkflow',
          startNodeId: start.id,
          triggerItems: items,
          signal: controller.signal,
          executeSubworkflow: subworkflowRunner(id, rootMode, depth + 1, triggeredBy, childAccess),
          ...deps,
          publicUrl,
          internalUrl,
          // O subfluxo roda dentro do worker de quem chamou: não pode pausar.
          canWait: false,
        }).then(interruptedOnShutdown);
        // Chamado a partir de um teste manual: guarda os dados do subfluxo também, para depurar.
        const keepAs: ExecutionMode = rootMode === 'manual' || rootMode === 'retry' ? rootMode : 'subworkflow';
        await saveResult(db, id, result, shouldKeepData(keepAs, result.status, config.keepSuccessData), keepAs === 'manual' || keepAs === 'retry', workerId);
        // Sem pausa (canWait: false), o subfluxo nunca termina esperando.
        return { executionId: id, status: result.status === 'waiting' ? 'error' : result.status, output: result.lastOutput, error: result.error };
      } catch (err) {
        await failExecution(db, id, err instanceof Error ? err.message : String(err), workerId);
        throw err;
      } finally {
        signal.removeEventListener('abort', onParentAbort);
        running.delete(id);
      }
    };

  const columns = 'id, workflow_id, workflow_version, mode, status, definition, input, triggered_by, start_node_id, retry_of, resume_state, resume_data';
  /** Roda uma execução da fila. `alreadyClaimed`: ela já nasceu rodando neste worker (agendamento). */
  const run = async (executionId: string, alreadyClaimed = false) => {
    const claimed = await one<ExecutionRow>(
      db,
      alreadyClaimed
        ? `SELECT ${columns} FROM executions WHERE id = $1 AND status = 'running' AND worker_id = $2`
        : `UPDATE executions SET status = 'running', started_at = coalesce(started_at, now()), worker_id = $2 WHERE id = $1 AND status = 'queued'
           RETURNING ${columns}`,
      [executionId, workerId],
    );
    if (!claimed) return; // cancelada antes de começar, ou já processada

    const controller = new AbortController();
    running.set(executionId, controller);
    if (earlyCancels.delete(executionId)) controller.abort();
    let responded = false;
    const { access, ...deps } = executionDeps(executionId, {
      workflowId: claimed.workflow_id,
      workflowVersion: claimed.workflow_version,
      triggeredBy: claimed.triggered_by,
      definition: claimed.definition,
    });
    try {
      const result = await executeWorkflow({
        workflow: claimed.definition,
        executionId,
        mode: claimed.mode,
        startNodeId: claimed.start_node_id ?? undefined,
        triggerItems: claimed.input ?? undefined,
        resume: decodeResume(claimed),
        signal: controller.signal,
        executeSubworkflow: subworkflowRunner(executionId, claimed.mode, 1, claimed.triggered_by, access),
        ...deps,
        publicUrl,
        internalUrl,
        onResponse: (response) => {
          // Só a primeira resposta vale, como no n8n.
          if (responded) return;
          responded = true;
          void publish(executionId, { type: 'response', response });
        },
      }).then(interruptedOnShutdown);
      const keepFiles = claimed.mode === 'manual' || claimed.mode === 'retry';
      const saved = await saveResult(db, executionId, result, shouldKeepData(claimed.mode, result.status, config.keepSuccessData), keepFiles, workerId);
      // Outro já encerrou a execução (cancelada, ou dada como interrompida): o resultado desta rodada não
      // vale. Quem chamou por HTTP fica sabendo como ela ficou (repetir o aviso não faz mal: vale o primeiro).
      if (!saved) {
        console.warn(`Execução ${executionId} já tinha sido encerrada por outro; o resultado não foi gravado`);
        const closed = await one<{ status: string; error_message: string | null }>(db, 'SELECT status, error_message FROM executions WHERE id = $1', [executionId]);
        if (closed?.status === 'canceled' || closed?.status === 'error') {
          await publish(executionId, { type: 'finished', status: closed.status, error: closed.error_message ?? undefined, lastOutput: [] });
        }
        return;
      }
      // Ia pausar, mas o cancelamento foi pedido enquanto ela rodava (depois do último nó): ficou cancelada.
      if (result.status === 'waiting' && saved === 'canceled') {
        await publish(executionId, { type: 'finished', status: 'canceled', error: CANCELED_BEFORE_PAUSE, lastOutput: [] });
        return;
      }
      if (result.status === 'waiting') {
        if (result.wait?.until) await queue.scheduleResume(executionId, Date.parse(result.wait.until));
        await publish(executionId, { type: 'waiting', wait: result.wait! });
        return;
      }
      await publish(executionId, { type: 'finished', status: result.status, error: result.error?.message, lastOutput: result.lastOutput });
      if (result.status === 'error') await runErrorWorkflow(claimed, result.error).catch((e) => console.error('Fluxo de erro não iniciado:', e));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // O fim já foi gravado (por este worker, ou por outro que a encerrou) e algo falhou depois: fica só
      // no log. Se ela ficou pausada sem o job da volta, a procura de execuções sem job agenda a volta.
      if (!(await failExecution(db, executionId, message, workerId))) {
        console.error(`Execução ${executionId}: falha depois de gravar o resultado:`, err);
        return;
      }
      await publish(executionId, { type: 'finished', status: 'error', error: message, lastOutput: [] });
      await runErrorWorkflow(claimed, { message }).catch((e) => console.error('Fluxo de erro não iniciado:', e));
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
        const wf = await one<{ id: string; name: string; version: number; definition: WorkflowDefinition }>(
          db,
          'SELECT id, name, version, definition FROM workflows WHERE id = $1 AND active',
          [data.workflowId],
        );
        if (!wf) return;
        if (data.once) {
          // Execução única: depois de disparar, o fluxo fica desativado.
          await db.query('UPDATE workflows SET active = false, updated_at = now() WHERE id = $1', [wf.id]);
          await audit(db, { userId: null, action: 'deactivate', entityType: 'workflow', entityId: wf.id, entityName: wf.name, after: { reason: 'execução única agendada' } });
        }
        const args = {
          workflowId: wf.id,
          workflowVersion: wf.version,
          mode: 'schedule' as const,
          triggeredBy: null,
          definition: wf.definition,
          startNodeId: wf.definition.nodes.find((n) => n.type === 'scheduleTrigger' && !n.disabled)?.id ?? null,
          // Nasce rodando neste worker: se ele parar antes de terminar, a procura de abandonadas a encontra.
          status: 'running' as const,
          workerId,
        };
        // A execução única não é pulada: o fluxo já foi desativado e o horário não voltaria.
        const id = wf.definition.settings?.skipIfRunning && !data.once
          ? await transaction(db, async (client) => {
              // Trava por fluxo: dois horários pegos ao mesmo tempo não passam juntos pela conferência.
              await client.query('SELECT pg_advisory_xact_lock(1105, hashtext($1))', [wf.id]);
              const previous = await one(
                client,
                `SELECT id FROM executions WHERE workflow_id = $1 AND mode = 'schedule' AND status IN ('queued', 'running', 'waiting') LIMIT 1`,
                [wf.id],
              );
              return previous ? null : createExecution(client, args);
            })
          : await createExecution(db, args);
        if (!id) {
          console.log(`Agendamento do fluxo "${wf.name}" pulado: a execução agendada anterior ainda não terminou`);
          return;
        }
        await run(id, true);
      } else if (data.kind === 'resume') {
        // O tempo de espera acabou: volta para a fila sem dados de retomada (segue com os itens de antes).
        // Job de uma pausa que já acabou (retomada antes da hora, ou outra pausa depois dela) não faz nada.
        // A pausa seguinte não tem a mesma hora deste job: um Wait cujo limite já passou não pausa.
        const resumed = await one(
          db,
          `UPDATE executions SET status = 'queued', queued_at = now(), resume_data = NULL
           WHERE id = $1 AND status = 'waiting' AND ($2::double precision IS NULL OR abs(extract(epoch FROM wait_till) * 1000 - $2) < 1)
           RETURNING id`,
          [data.executionId, data.at ?? null],
        );
        if (resumed) await run(data.executionId);
      } else if (data.kind === 'cleanup' && config.executionRetentionDays > 0) {
        const removed = await cleanupOldExecutions(db, config.executionRetentionDays);
        if (removed.executions || removed.dbCommands) {
          console.log(`Limpeza: ${removed.executions} execuções e ${removed.dbCommands} comandos SQL apagados`);
        }
      }
    },
    { connection: redis, ...workerOptions(config, workerId) },
  );

  // Aviso de vida: enquanto ele vale, as execuções deste worker não são dadas como abandonadas.
  const beat = () => void queue.heartbeat(workerId).catch((err) => console.error('Aviso de vida do worker não foi gravado:', err));
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const failedColumns = `e.id, e.workflow_id, e.workflow_version, e.mode, e.status, e.definition, e.input, e.triggered_by, e.start_node_id,
    e.retry_of, NULL AS resume_state, NULL AS resume_data`;
  /** Execuções que o worker não encerrou e viraram erro: avisa quem chamou por HTTP e roda o fluxo de erro de cada uma. */
  const notifyFailed = async (rows: ExecutionRow[], message: string) => {
    for (const row of rows) {
      await publish(row.id, { type: 'finished', status: 'error', error: message, lastOutput: [] });
      await runErrorWorkflow(row, { message }).catch((e) => console.error('Fluxo de erro não iniciado:', e));
    }
  };

  /** Marca como erro as execuções abandonadas e roda o fluxo de erro de cada uma (agendadas, webhooks, gatilhos). */
  const failAbandoned = async (rows: { id: string; worker_id: string | null }[]) => {
    if (!rows.length) return;
    // Só se ainda é do worker visto parado: outro pode tê-la pego de volta nesse meio-tempo.
    const failed = await many<ExecutionRow>(
      db,
      `UPDATE executions e SET status = 'error', finished_at = now(), error_message = $3, error = $4
       FROM unnest($1::uuid[], $2::text[]) AS a(id, worker_id)
       WHERE e.id = a.id AND e.worker_id IS NOT DISTINCT FROM a.worker_id AND e.status = 'running'
       RETURNING ${failedColumns}`,
      [rows.map((r) => r.id), rows.map((r) => r.worker_id), ABANDONED_MESSAGE, JSON.stringify({ message: ABANDONED_MESSAGE })],
    );
    for (const row of failed) console.warn(`Execução ${row.id} estava abandonada e foi marcada como erro`);
    await notifyFailed(failed, ABANDONED_MESSAGE);
  };

  /**
   * Procura execuções 'running' que ninguém está rodando: o worker delas não está mais vivo (sem aviso de
   * vida e sem conexão com a fila: reinício, queda), ou é este worker e ela já saiu da lista do que ele roda
   * (falha ao gravar o fim). Na subida e no aviso de falha de um job, o worker morto basta. Na procura de
   * cada minuto, só vira erro o que aparecer abandonado duas vezes seguidas, para uma queda rápida do Redis
   * não derrubar nada.
   */
  let suspects = new Set<string>();
  const sweepRunning = async (immediate: boolean) => {
    const rows = await many<{ id: string; worker_id: string | null }>(db, `SELECT id, worker_id FROM executions WHERE status = 'running'`);
    if (!rows.length) {
      suspects = new Set();
      return;
    }
    const live = await queue.liveWorkers(rows.map((r) => r.worker_id));
    if (!live) return;
    live.ids.add(workerId);
    const key = (r: { id: string; worker_id: string | null }) => `${r.id}:${r.worker_id ?? ''}`;
    const ownLost = (r: { id: string; worker_id: string | null }) => r.worker_id === workerId && !running.has(r.id);
    const abandoned = rows.filter((r) => isAbandoned(r.worker_id, live) || ownLost(r));
    const confirmed = abandoned.filter((r) => (immediate && !ownLost(r)) || suspects.has(key(r)));
    suspects = new Set(abandoned.map(key));
    await failAbandoned(confirmed);
  };

  /**
   * Execução que perdeu o job: na fila sem job para rodá-la, ou pausada com a hora de voltar vencida e sem
   * o job da volta. Só o que aparecer assim em duas procuras seguidas, para não pegar quem está no meio da
   * passagem para a fila. Na fila:
   * - o job chegou ao Redis e falhou antes de ela começar (o banco caiu na hora de pegá-la), ou ela já tinha
   *   rodado e voltou de uma pausa (webhook ou formulário aceitos): volta para a fila, porque quem a pediu
   *   ouviu que ela foi aceita; tenta de novo a cada duas procuras, até 1 hora depois da primeira falha
   *   (ou da entrada na fila, se não há falha guardada);
   * - nenhum job dela chegou à fila (o processo que a criou parou antes, ou o Redis perdeu o job): vira
   *   erro, porque quem a pediu pode ter recebido o erro e tentado de novo (rodá-la repetiria o que ela faz);
   * - passou da 1 hora: vira erro, em vez de rodar muito depois do que se esperava.
   * Quem esperava a resposta do webhook ou do formulário fica sabendo, e o fluxo de erro roda. A pausada
   * volta na hora. Sem isto, ela ficaria parada para sempre (e, com "Pular este horário", travaria o
   * agendamento).
   */
  let orphanSuspects = new Set<string>();
  const sweepOrphans = async () => {
    const rows = await many<{ id: string; status: 'queued' | 'waiting'; started: boolean; entered: Date; wait_till: Date | null }>(
      db,
      `SELECT id, status, started_at IS NOT NULL AS started, coalesce(queued_at, created_at) AS entered, wait_till FROM executions
       WHERE (status = 'queued' AND coalesce(queued_at, created_at) < now() - make_interval(secs => $1))
          OR (status = 'waiting' AND wait_till < now() - make_interval(secs => $1))`,
      [ORPHAN_GRACE_SECONDS],
    );
    if (!rows.length) {
      orphanSuspects = new Set();
      return;
    }
    const withJobs = await queue.executionsWithJobs();
    const key = (r: { id: string; status: string }) => `${r.id}:${r.status}`;
    const orphans = rows.filter((r) => !withJobs.has(r.id));
    const confirmed = orphans.filter((r) => orphanSuspects.has(key(r)));
    orphanSuspects = new Set(orphans.map(key));
    const failedJobs = confirmed.some((r) => r.status === 'queued') ? await queue.failedJobs() : new Map<string, number[]>();
    const old: string[] = [];
    const neverQueued: string[] = [];
    for (const r of confirmed) {
      if (r.status === 'waiting') {
        console.warn(`Execução ${r.id} esperava sem o job da volta; volta agora`);
        // Se o job aparecer de novo, não roda duas vezes: só um tira a execução de 'waiting'.
        await queue.scheduleResume(r.id, r.wait_till!.getTime());
        continue;
      }
      // Falhas de jobs dela desde que entrou na fila (com folga para relógios diferentes).
      const entered = r.entered.getTime();
      const failures = (failedJobs.get(r.id) ?? []).filter((at) => at > entered - ORPHAN_GRACE_SECONDS * 1000);
      const since = failures.length ? Math.min(...failures) : entered;
      if (Date.now() - since > ORPHAN_REQUEUE_LIMIT_SECONDS * 1000) {
        old.push(r.id);
      } else if (failures.length || r.started) {
        console.warn(`Execução ${r.id} estava na fila sem job; volta para a fila`);
        await queue.enqueueResumed(r.id);
        // A próxima tentativa só depois de mais duas procuras sem job.
        orphanSuspects.delete(key(r));
      } else {
        neverQueued.push(r.id);
      }
    }
    for (const [ids, message] of [
      [old, ORPHAN_MESSAGE],
      [neverQueued, NEVER_QUEUED_MESSAGE],
    ] as const) {
      if (!ids.length) continue;
      const failed = await many<ExecutionRow>(
        db,
        `UPDATE executions e SET status = 'error', started_at = coalesce(started_at, now()), finished_at = now(), error_message = $2, error = $3,
           resume_state = NULL, resume_data = NULL
         WHERE e.id = ANY($1::uuid[]) AND e.status = 'queued'
         RETURNING ${failedColumns}`,
        [ids, message, JSON.stringify({ message })],
      );
      for (const row of failed) console.warn(`Execução ${row.id} estava na fila sem job e foi marcada como erro: ${message}`);
      await notifyFailed(failed, message);
    }
  };

  let sweeping: Promise<void> | null = null;
  const sweep = (immediate: boolean): Promise<void> => {
    sweeping ??= (async () => {
      await sweepRunning(immediate);
      if (!immediate) await sweepOrphans();
    })()
      .catch((err) => console.error('Procura de execuções abandonadas falhou:', err))
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  };

  void worker
    .waitUntilReady()
    .then(() => sweep(true))
    .catch(() => undefined);
  const sweepTimer = setInterval(() => void sweep(false), deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // Job que falhou (travado porque o worker parou, ou erro do banco antes de a execução começar): a
  // procura acha na hora a que ficou 'running' sem ninguém rodando (inclusive a do agendamento, que nasce
  // rodando). A que ficou na fila sem começar não rodou nada: a procura de execuções sem job a põe de
  // novo na fila depois de uns minutos, e de novo a cada duas procuras, até 1 hora depois da primeira falha.
  worker.on('failed', () => {
    if (!stopping) void sweep(true);
  });

  return {
    async close() {
      stopping = true;
      clearInterval(sweepTimer);
      for (const c of running.values()) c.abort();
      await worker.close();
      // Só agora: enquanto terminava as execuções, o worker ainda contava como vivo para os outros.
      clearInterval(heartbeatTimer);
      await queue.clearHeartbeat(workerId).catch(() => undefined);
      await queue.close();
      await pools.closeAll();
      await closeDefaultPythonRunner();
      await subscriber.unsubscribe(CANCEL_CHANNEL);
    },
  };
}
