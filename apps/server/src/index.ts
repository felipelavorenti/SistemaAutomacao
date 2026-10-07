import { resolve } from 'node:path';
import type { WorkflowDefinition } from '@sa/engine';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, many, migrate } from './db/db.js';
import { createRedis, ExecutionQueue } from './executions/queue.js';
import { startWorker } from './executions/worker.js';
import { ensureAdmin } from './lib/auth.js';
import { TriggerManager } from './triggers/manager.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);

const applied = await migrate(db);
if (applied.length) console.log(`Migrações aplicadas: ${applied.join(', ')}`);
if (await ensureAdmin(db, config.admin)) console.log(`Administrador ${config.admin!.email} criado; troque a senha no primeiro acesso.`);

const redis = createRedis(config.redisUrl);
const queue = new ExecutionQueue(redis);

const active = await many<{ id: string; active: boolean; definition: WorkflowDefinition }>(db, 'SELECT id, active, definition FROM workflows WHERE active');
await queue.reconcileSchedules(active);
await queue.scheduleCleanup(config.executionRetentionDays > 0);

const worker = config.runWorkerInProcess ? startWorker({ db, config, redis: createRedis(config.redisUrl), subscriber: createRedis(config.redisUrl) }) : null;

const triggers = new TriggerManager({ db, config, queue });
const app = await buildApp({ db, config: { ...config, webDistDir: config.webDistDir && resolve(config.webDistDir) }, queue, triggers });
await app.listen({ port: config.port, host: '0.0.0.0' });
// Webhooks, formulários e gatilhos que escutam dos fluxos ativos.
await triggers.start();

const shutdown = async () => {
  await app.close();
  await triggers.close();
  await worker?.close();
  await queue.close();
  redis.disconnect();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
