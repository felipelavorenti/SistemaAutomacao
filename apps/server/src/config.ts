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
  /**
   * Proxies em que o Info8n confia para saber o IP de quem chamou (X-Forwarded-For). Desligado,
   * vale o IP da conexão; ligado sem um proxy na frente, qualquer um falsifica o IP.
   */
  trustProxy: boolean | string[];
  /** Endereço do Info8n que o navegador usa (ex.: https://info8n.empresa.com.br), para o login com Google. */
  publicUrl?: string;
  webDistDir?: string;
  /** Pastas do servidor que os nós Read/Write Files from Disk podem usar. */
  filesDirs: string[];
  admin?: { email: string; password: string; name: string };
}

export function parseKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex ou base64)');
  return key;
}

/** TRUST_PROXY: vazio ou false (padrão), true, ou IPs e redes dos proxies separados por vírgula. */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const value = (raw ?? '').trim();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    webDistDir: process.env.WEB_DIST_DIR,
    filesDirs: (process.env.FILES_DIRS ?? '')
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    admin: process.env.ADMIN_EMAIL
      ? { email: process.env.ADMIN_EMAIL, password: required('ADMIN_PASSWORD'), name: process.env.ADMIN_NAME ?? 'Administrador' }
      : undefined,
  };
}

/** Senhas de exemplo do .env.example que ficaram no .env de verdade. */
const EXAMPLE_PASSWORDS = new Set(['troque-esta-senha', 'postgres', 'automacao']);

/** Configurações perigosas que valem um aviso no log ao subir o servidor. */
export function insecureSettings(config: Config): string[] {
  const warnings: string[] = [];
  try {
    const password = decodeURIComponent(new URL(config.databaseUrl).password);
    if (EXAMPLE_PASSWORDS.has(password)) {
      warnings.push('a senha do Postgres do Info8n é a do exemplo; troque POSTGRES_PASSWORD no .env (veja a documentação técnica, "Trocar a senha do Postgres")');
    }
  } catch {
    // DATABASE_URL sem o formato de URL: o pg avisa ao conectar.
  }
  if (config.trustProxy === true) {
    warnings.push('TRUST_PROXY=true: use só com o Info8n atrás de um proxy e com a porta 3000 fechada para a rede, senão o IP dos pedidos pode ser falsificado');
  }
  return warnings;
}
