// Worker separado, para rodar as execuções em outro processo ou máquina.
import { loadConfig } from './config.js';
import { createDb, migrate } from './db/db.js';
import { createRedis } from './executions/queue.js';
import { startWorker } from './executions/worker.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await migrate(db);

const worker = startWorker({ db, config, redis: createRedis(config.redisUrl), subscriber: createRedis(config.redisUrl) });
console.log(`Worker iniciado com concorrência ${config.workerConcurrency}`);

const shutdown = async () => {
  await worker.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
