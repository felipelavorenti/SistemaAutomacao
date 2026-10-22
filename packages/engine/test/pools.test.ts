import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DatabasePools } from '../src/database/drivers.js';
import { executeWorkflow } from '../src/executor.js';
import type { ConnectionData } from '../src/node-types.js';
import type { WorkflowDefinition } from '../src/types.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/automacao_test';

function postgresFromUrl(url: string, extra: Record<string, string> = {}): ConnectionData {
  const u = new URL(url);
  return {
    id: 'pg',
    type: 'postgres',
    data: { host: u.hostname, port: u.port || '5432', database: u.pathname.slice(1), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ...extra },
  };
}

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

describe('pools de banco', () => {
  const pools = new DatabasePools();
  afterAll(() => pools.closeAll());

  it('conexão alterada usa pool novo e só fecha o antigo quando ninguém mais usa', () => {
    const first = pools.acquire(postgresFromUrl(DATABASE_URL));
    const second = pools.acquire(postgresFromUrl(DATABASE_URL));
    expect(second.client).toBe(first.client);
    const close = vi.spyOn(first.client, 'close');

    // A conexão mudou no cadastro enquanto dois nós usavam o pool.
    const changed = pools.acquire(postgresFromUrl(DATABASE_URL, { password: 'outra' }));
    expect(changed.client).not.toBe(first.client);
    expect(close).not.toHaveBeenCalled();

    first.release();
    first.release(); // devolver duas vezes não conta em dobro
    expect(close).not.toHaveBeenCalled();
    second.release();
    expect(close).toHaveBeenCalledOnce();
    changed.release();
  });

  it('pool sem ninguém usando fecha na hora da troca', () => {
    const lease = pools.acquire(postgresFromUrl(DATABASE_URL, { comentario: 'a' }));
    const close = vi.spyOn(lease.client, 'close');
    lease.release();
    pools.acquire(postgresFromUrl(DATABASE_URL, { comentario: 'b' })).release();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe.skipIf(!(await reachable()))('pools de banco com Postgres', () => {
  const pools = new DatabasePools();
  afterAll(() => pools.closeAll());

  it('consulta em andamento termina mesmo com a conexão alterada no meio', async () => {
    const lease = pools.acquire(postgresFromUrl(DATABASE_URL));
    const slow = lease.client.query('SELECT pg_sleep(0.5), 1 AS ok', {});
    await new Promise((r) => setTimeout(r, 100));
    const changed = pools.acquire(postgresFromUrl(DATABASE_URL, { comentario: 'nova versão' }));
    await expect(slow).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    // O nó que já tinha o pool segue usando até o fim (ex.: os próximos itens de um loop).
    await expect(lease.client.query('SELECT 3 AS ok', {})).resolves.toMatchObject({ rows: [{ ok: 3 }] });
    lease.release();
    // Devolvido o último uso, o pool antigo fecha.
    await expect(lease.client.query('SELECT 1', {})).rejects.toThrow();
    await expect(changed.client.query('SELECT 2 AS ok', {})).resolves.toMatchObject({ rows: [{ ok: 2 }] });
    changed.release();
  });

  it('o nó Banco de dados devolve o pool quando termina', async () => {
    const connection = postgresFromUrl(DATABASE_URL, { comentario: 'nó' });
    const probe = pools.acquire(connection);
    const close = vi.spyOn(probe.client, 'close');
    probe.release();

    const workflow: WorkflowDefinition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'd', name: 'Banco', type: 'database', position: { x: 200, y: 0 }, parameters: { connection: 'pg', operation: 'query', sql: 'SELECT 1 AS ok' } },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'd', toInput: 0 }],
    };
    const result = await executeWorkflow({ workflow, executionId: 'x', mode: 'manual', databases: pools, getConnection: async () => connection });
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(close).not.toHaveBeenCalled();

    pools.acquire(postgresFromUrl(DATABASE_URL, { comentario: 'nó, versão 2' })).release();
    expect(close).toHaveBeenCalledOnce();
  });
});
