function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ${name} não configurada`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Variável de ambiente ${name} deve ser um número inteiro`);
  return n;
}

export interface Config {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Chave de 32 bytes (hex ou base64) usada para criptografar as conexões. */
  encryptionKey: Buffer;
  sessionTtlHours: number;
  /** Dias de retenção das execuções; 0 guarda para sempre. */
  executionRetentionDays: number;
  /** Guarda entrada e saída de cada nó também nas execuções agendadas com sucesso. */
  keepSuccessData: boolean;
  workerConcurrency: number;
  /** Roda o worker no mesmo processo da API (útil em instalação pequena). */
  runWorkerInProcess: boolean;
  secureCookies: boolean;
  webDistDir?: string;
  admin?: { email: string; password: string; name: string };
}

export function parseKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex ou base64)');
  return key;
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    encryptionKey: parseKey(required('ENCRYPTION_KEY')),
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    executionRetentionDays: int('EXECUTION_RETENTION_DAYS', 0),
    keepSuccessData: process.env.KEEP_SUCCESS_DATA === 'true',
    workerConcurrency: int('WORKER_CONCURRENCY', 5),
    runWorkerInProcess: process.env.RUN_WORKER_IN_PROCESS !== 'false',
    secureCookies: process.env.SECURE_COOKIES === 'true',
    webDistDir: process.env.WEB_DIST_DIR,
    admin: process.env.ADMIN_EMAIL
      ? { email: process.env.ADMIN_EMAIL, password: required('ADMIN_PASSWORD'), name: process.env.ADMIN_NAME ?? 'Administrador' }
      : undefined,
  };
}
