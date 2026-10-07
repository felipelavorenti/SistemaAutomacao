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
  /** Execução pausada cujo tempo de espera acabou. */
  | { kind: 'resume'; executionId: string };

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

  /** Execução pausada que voltou para a fila: outro ID de job, porque o da primeira rodada ainda pode estar guardado. */
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

  /** Agenda a volta de uma execução pausada (Wait por tempo, ou o limite de espera do webhook e do formulário). */
  async scheduleResume(executionId: string, at: number): Promise<void> {
    await this.cancelResume(executionId);
    await this.queue.add(
      'resume',
      { kind: 'resume', executionId },
      { jobId: `resume-${executionId}`, delay: Math.max(0, at - Date.now()), removeOnComplete: true, removeOnFail: 1000 },
    );
  }

  async cancelResume(executionId: string): Promise<void> {
    await this.removeOnce(`resume-${executionId}`);
  }

  async requestCancel(executionId: string): Promise<void> {
    await this.redis.publish(CANCEL_CHANNEL, executionId);
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
