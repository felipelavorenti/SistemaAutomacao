import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { scheduleRepeat, type WorkflowDefinition } from '@sa/engine';

export const QUEUE_NAME = 'executions';
export const CANCEL_CHANNEL = 'sa:cancel';
/** Canal de cada execução: resposta do Respond to Webhook ou do Form, pausa e fim (para quem chamou por HTTP). */
export const executionChannel = (executionId: string) => `sa:exec:${executionId}`;

export type JobData =
  | { kind: 'run'; executionId: string }
  | { kind: 'scheduled'; workflowId: string; once?: number }
  | { kind: 'cleanup' }
  /** Execução pausada cujo tempo de espera acabou. `at`: a hora marcada (wait_till) da pausa deste job. */
  | { kind: 'resume'; executionId: string; at?: number };

/** Quanto tempo o aviso de vida de um worker vale no Redis sem ser renovado. */
export const HEARTBEAT_TTL_MS = 60_000;
/**
 * Conexão da fila parada há mais que isto não prova que o worker está vivo: a de uma máquina que caiu
 * (sem avisar o Redis) fica na lista por uns 15 minutos. Com o aviso de vida em dia, o worker conta como
 * vivo mesmo assim (com todas as vagas ocupadas, a conexão da fila fica parada).
 */
const STALE_CONNECTION_SECONDS = 300;
const workerKey = (workerId: string) => `sa:worker:${workerId}`;
const resumeJobId = (executionId: string, at: number) => `resume-${executionId}-${at}`;

export interface LiveWorkers {
  ids: Set<string>;
  unnamed: boolean;
}

/** Execução 'running' que nenhum worker vivo está rodando (o worker parou ou o servidor reiniciou). */
export function isAbandoned(workerId: string | null, live: LiveWorkers): boolean {
  return workerId === null ? !live.unnamed : !live.ids.has(workerId);
}

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export class ExecutionQueue {
  readonly queue: Queue<JobData>;

  constructor(private redis: Redis) {
    this.queue = new Queue<JobData>(QUEUE_NAME, { connection: redis });
  }

  async enqueueRun(executionId: string): Promise<void> {
    await this.queue.add('run', { kind: 'run', executionId }, { jobId: executionId, removeOnComplete: 1000, removeOnFail: 1000 });
  }

  /**
   * Execução pausada que voltou para a fila (ou que perdeu o job): outro ID de job, porque o da
   * primeira rodada ainda pode estar guardado.
   */
  async enqueueResumed(executionId: string): Promise<void> {
    await this.queue.add('run', { kind: 'run', executionId }, { jobId: `${executionId}-${Date.now()}`, removeOnComplete: 1000, removeOnFail: 1000 });
  }

  /**
   * Execuções agendadas esperando vaga no worker. Elas só viram uma linha em executions
   * quando o worker as pega, então sem isto não apareceriam em lugar nenhum.
   */
  async waitingScheduled(): Promise<{ workflowId: string; dueAt: number }[]> {
    const jobs = await this.queue.getJobs(['wait', 'prioritized', 'paused'], 0, 999, true);
    return jobs.flatMap((job) =>
      job?.data?.kind === 'scheduled' ? [{ workflowId: job.data.workflowId, dueAt: job.timestamp + (job.delay ?? 0) }] : [],
    );
  }

  /**
   * Próxima execução agendada de cada fluxo. O agendamento (e a execução única) deixa
   * sempre o próximo disparo como um job atrasado na fila; vale o mais cedo de cada fluxo.
   */
  async nextRuns(): Promise<Map<string, number>> {
    const next = new Map<string, number>();
    for (const job of await this.queue.getJobs(['delayed'], 0, -1, true)) {
      if (job?.data?.kind !== 'scheduled') continue;
      const at = job.timestamp + (job.delay ?? 0);
      const current = next.get(job.data.workflowId);
      if (current === undefined || at < current) next.set(job.data.workflowId, at);
    }
    return next;
  }

  /**
   * Agenda a volta de uma execução pausada (Wait por tempo, ou o limite de espera do webhook e do
   * formulário) para `at`, o wait_till da pausa. Cada pausa tem o seu job: a pausa seguinte começa
   * dentro do job da anterior, que ainda está rodando, e a fila ignora um job novo com o mesmo ID.
   */
  async scheduleResume(executionId: string, at: number): Promise<void> {
    const jobId = resumeJobId(executionId, at);
    // Sobra de uma tentativa que falhou com o mesmo horário: sem tirar, a fila ignoraria o job novo.
    await this.removeOnce(jobId);
    await this.queue.add('resume', { kind: 'resume', executionId, at }, { jobId, delay: Math.max(0, at - Date.now()), removeOnComplete: true, removeOnFail: 1000 });
  }

  /** Tira o job da volta de uma pausa que acabou antes da hora (webhook, formulário, cancelamento). */
  async cancelResume(executionId: string, waitTill: Date | string | null): Promise<void> {
    if (waitTill) await this.removeOnce(resumeJobId(executionId, new Date(waitTill).getTime()));
    // Job de uma versão anterior do Info8n, com um ID só por execução.
    await this.removeOnce(`resume-${executionId}`);
  }

  /**
   * Avisa quem chamou a execução por HTTP (webhook, formulário) que ela terminou, quando quem a encerrou
   * não foi o worker (cancelada na fila, ou cancelada com o worker parado).
   */
  async publishFinished(executionId: string, status: 'canceled' | 'error', error: string): Promise<void> {
    await this.redis.publish(executionChannel(executionId), JSON.stringify({ type: 'finished', status, error, lastOutput: [] }));
  }

  async requestCancel(executionId: string): Promise<void> {
    await this.redis.publish(CANCEL_CHANNEL, executionId);
  }

  /** Avisa que este worker está vivo. Vale por HEARTBEAT_TTL_MS; o worker renova bem antes disso. */
  async heartbeat(workerId: string): Promise<void> {
    await this.redis.set(workerKey(workerId), '1', 'PX', HEARTBEAT_TTL_MS);
  }

  /** Apaga o aviso de vida; o worker chama só depois de terminar as execuções que estava rodando. */
  async clearHeartbeat(workerId: string): Promise<void> {
    await this.redis.del(workerKey(workerId));
  }

  /**
   * Quais destes workers estão vivos: com o aviso de vida no Redis, ou com a conexão da fila
   * (`bull:<fila>:w:<id>`) aberta e usada há pouco. A conexão sozinha não basta: a fila a fecha antes de
   * o worker terminar as execuções ao desligar, ela cai por instantes quando reconecta, e a de uma
   * máquina que caiu sem avisar fica na lista por minutos. `unnamed`: há worker sem nome (versão anterior
   * do Info8n), que roda execuções sem worker_id. Null quando o Redis não lista as conexões; aí não dá
   * para saber quem está vivo.
   */
  async liveWorkers(candidates: Iterable<string | null>): Promise<LiveWorkers | null> {
    const connected = new Map<string, number>();
    let unnamed = false;
    for (const client of await this.queue.getWorkers()) {
      const name = client.rawname;
      if (typeof name !== 'string') return null;
      const at = name.indexOf(':w:');
      if (at === -1) unnamed = true;
      else connected.set(name.slice(at + 3), Number(client.idle));
    }
    const asked = [...new Set([...candidates].filter((id): id is string => !!id))];
    const beats = asked.length ? await this.redis.mget(asked.map(workerKey)) : [];
    const ids = new Set<string>();
    asked.forEach((id, i) => {
      const idle = connected.get(id);
      // Sem o tempo parado na lista (Redis diferente), a conexão aberta vale.
      const recent = idle !== undefined && !(idle >= STALE_CONNECTION_SECONDS);
      if (beats[i] !== null || recent) ids.add(id);
    });
    return { ids, unnamed };
  }

  /** Execuções que têm job na fila (esperando vaga, rodando ou com hora marcada para voltar). */
  async executionsWithJobs(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const job of await this.queue.getJobs(['active', 'wait', 'prioritized', 'paused', 'delayed', 'waiting-children'], 0, -1, true)) {
      const data = job?.data;
      if (data?.kind === 'run' || data?.kind === 'resume') ids.add(data.executionId);
    }
    return ids;
  }

  /** Cria, atualiza ou remove o agendamento de um fluxo. */
  async syncSchedule(workflow: { id: string; active: boolean; definition: WorkflowDefinition }): Promise<void> {
    const schedulerId = `wf:${workflow.id}`;
    const onceId = `once-${workflow.id}`;
    const trigger = workflow.definition.nodes.find((n) => n.type === 'scheduleTrigger' && !n.disabled);
    const repeat = workflow.active && trigger ? scheduleRepeat(trigger.parameters) : null;

    if (repeat?.kind === 'once') {
      await this.queue.removeJobScheduler(schedulerId);
      // Mantém o job que já está esperando para o mesmo horário (ao reiniciar o servidor, por exemplo).
      const existing = await this.queue.getJob(onceId);
      if (existing?.data.kind === 'scheduled' && existing.data.once === repeat.at && ['delayed', 'waiting'].includes(await existing.getState())) return;
      await this.removeOnce(onceId);
      // Data que já passou não roda: o fluxo foi ativado ou o servidor voltou depois da hora.
      if (repeat.at <= Date.now()) return;
      await this.queue.add(
        'scheduled',
        { kind: 'scheduled', workflowId: workflow.id, once: repeat.at },
        { jobId: onceId, delay: repeat.at - Date.now(), removeOnComplete: true, removeOnFail: true },
      );
      return;
    }

    await this.removeOnce(onceId);
    if (!repeat) {
      await this.queue.removeJobScheduler(schedulerId);
      return;
    }
    await this.queue.upsertJobScheduler(schedulerId, repeat.kind === 'cron' ? { pattern: repeat.pattern, tz: repeat.tz } : { every: repeat.every }, {
      name: 'scheduled',
      data: { kind: 'scheduled', workflowId: workflow.id },
      opts: { removeOnComplete: 1000, removeOnFail: 1000 },
    });
  }

  private async removeOnce(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job && (await job.getState()) !== 'active') await job.remove();
  }

  /** Deixa os agendamentos do Redis iguais aos fluxos ativos do banco. */
  async reconcileSchedules(workflows: { id: string; active: boolean; definition: WorkflowDefinition }[]): Promise<void> {
    const wanted = new Set(workflows.filter((w) => w.active).map((w) => `wf:${w.id}`));
    for (const s of await this.queue.getJobSchedulers()) {
      if (s.key.startsWith('wf:') && !wanted.has(s.key)) await this.queue.removeJobScheduler(s.key);
    }
    for (const w of workflows) {
      if (!w.active) continue;
      // Um agendamento inválido não pode impedir os outros de subir.
      await this.syncSchedule(w).catch((err) => console.error(`Agendamento do fluxo ${w.id} não foi criado:`, err));
    }
  }

  async scheduleCleanup(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.queue.upsertJobScheduler('cleanup', { pattern: '30 3 * * *' }, { name: 'cleanup', data: { kind: 'cleanup' } });
    } else {
      await this.queue.removeJobScheduler('cleanup');
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
