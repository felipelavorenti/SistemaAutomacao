import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { WorkflowDefinition } from '@sa/engine';

export const QUEUE_NAME = 'executions';
export const CANCEL_CHANNEL = 'sa:cancel';

export type JobData = { kind: 'run'; executionId: string } | { kind: 'scheduled'; workflowId: string } | { kind: 'cleanup' };

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
   * Execuções agendadas esperando vaga no worker. Elas só viram uma linha em executions
   * quando o worker as pega, então sem isto não apareceriam em lugar nenhum.
   */
  async waitingScheduled(): Promise<{ workflowId: string; dueAt: number }[]> {
    const jobs = await this.queue.getJobs(['wait', 'prioritized', 'paused'], 0, 999, true);
    return jobs.flatMap((job) =>
      job?.data?.kind === 'scheduled' ? [{ workflowId: job.data.workflowId, dueAt: job.timestamp + (job.delay ?? 0) }] : [],
    );
  }

  async requestCancel(executionId: string): Promise<void> {
    await this.redis.publish(CANCEL_CHANNEL, executionId);
  }

  /** Cria, atualiza ou remove o agendamento de um fluxo. */
  async syncSchedule(workflow: { id: string; active: boolean; definition: WorkflowDefinition }): Promise<void> {
    const schedulerId = `wf:${workflow.id}`;
    const trigger = workflow.definition.nodes.find((n) => n.type === 'scheduleTrigger' && !n.disabled);
    if (!workflow.active || !trigger) {
      await this.queue.removeJobScheduler(schedulerId);
      return;
    }
    const p = trigger.parameters;
    const repeat =
      p.mode === 'cron'
        ? { pattern: String(p.cron ?? ''), tz: String(p.timezone || 'America/Sao_Paulo') }
        : { every: Math.max(1, Number(p.intervalMinutes ?? 60)) * 60_000 };
    await this.queue.upsertJobScheduler(schedulerId, repeat, {
      name: 'scheduled',
      data: { kind: 'scheduled', workflowId: workflow.id },
      opts: { removeOnComplete: 1000, removeOnFail: 1000 },
    });
  }

  /** Deixa os agendamentos do Redis iguais aos fluxos ativos do banco. */
  async reconcileSchedules(workflows: { id: string; active: boolean; definition: WorkflowDefinition }[]): Promise<void> {
    const wanted = new Set(workflows.filter((w) => w.active).map((w) => `wf:${w.id}`));
    for (const s of await this.queue.getJobSchedulers()) {
      if (s.key.startsWith('wf:') && !wanted.has(s.key)) await this.queue.removeJobScheduler(s.key);
    }
    for (const w of workflows) if (w.active) await this.syncSchedule(w);
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
