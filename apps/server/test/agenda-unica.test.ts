import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis, ExecutionQueue } from '../src/executions/queue.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function reachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await reachable();

describe.skipIf(!available)('Execução única na fila', () => {
  let redis: Redis;
  let queue: ExecutionQueue;

  beforeAll(() => {
    redis = createRedis(REDIS_URL);
    queue = new ExecutionQueue(redis);
  });

  afterAll(async () => {
    await queue.queue.close();
    redis.disconnect();
  });

  it('dispara no milissegundo pedido mesmo que o relógio ande entre o cálculo do atraso e o envio à fila', async () => {
    const workflowId = randomUUID();
    const at = Date.now() + 3_600_000;
    const definition = {
      nodes: [
        {
          id: 's',
          name: 'Agendamento',
          type: 'scheduleTrigger',
          position: { x: 0, y: 0 },
          parameters: { mode: 'once', dateTime: new Date(at).toISOString().slice(0, 23), timezone: 'UTC' },
        },
      ],
      connections: [],
    };

    // Cada leitura do relógio avança 1 ms, como acontece quando o milissegundo vira entre uma leitura e a outra.
    const real = Date.now.bind(Date);
    let ticks = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + ticks++);
    try {
      await queue.syncSchedule({ id: workflowId, active: true, definition });
    } finally {
      clock.mockRestore();
    }

    const job = await queue.queue.getJob(`once-${workflowId}`);
    try {
      expect(job).toBeTruthy();
      expect(job!.timestamp + (job!.delay ?? 0)).toBe(at);
      expect((await queue.nextRuns()).get(workflowId)).toBe(at);
    } finally {
      await job?.remove();
    }
  });
});
