import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RETENTION_DAYS, loadConfig } from '../src/config.js';

describe('Configuração', () => {
  afterEach(() => vi.unstubAllEnvs());

  const load = (retention?: string) => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/x');
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    vi.stubEnv('EXECUTION_RETENTION_DAYS', retention ?? '');
    return loadConfig();
  };

  it('guarda as execuções por 30 dias quando o .env não diz', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(load().executionRetentionDays).toBe(30);
  });

  it('EXECUTION_RETENTION_DAYS troca o prazo, e 0 guarda para sempre', () => {
    expect(load('90').executionRetentionDays).toBe(90);
    expect(load('0').executionRetentionDays).toBe(0);
  });

  it('prazo que não é número inteiro é recusado na subida', () => {
    expect(() => load('um mês')).toThrow('EXECUTION_RETENTION_DAYS deve ser um número inteiro');
  });
});
