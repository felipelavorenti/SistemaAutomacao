import { describe, expect, it } from 'vitest';
import { API_REFERENCE } from '../src/api-reference.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { parseKey, type Config } from '../src/config.js';

const config: Config = {
  port: 0,
  databaseUrl: '',
  redisUrl: '',
  encryptionKey: parseKey('0'.repeat(64)),
  sessionTtlHours: 1,
  executionRetentionDays: 0,
  keepSuccessData: false,
  workerConcurrency: 1,
  runWorkerInProcess: false,
  secureCookies: false,
};

describe('Referência da API', () => {
  it('documenta todas as rotas da API, e só as que existem', async () => {
    // Registrar as rotas não toca no banco nem no Redis.
    const app = await buildApp({ db: {}, queue: {}, config } as unknown as AppDeps);
    await app.ready();
    const key = (method: string, path: string) => `${method} ${path}`;
    const registered = app.registeredRoutes
      .filter((r) => r.url.startsWith('/api/') && r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .map((r) => key(r.method, r.url.slice(4).replace(/:(\w+)/g, '{$1}')));
    const documented = API_REFERENCE.flatMap((g) => g.routes.map((r) => key(r.method, r.path)));

    expect(new Set(documented).size, 'rota documentada duas vezes').toBe(documented.length);
    expect(registered.filter((r) => !documented.includes(r)), 'rotas sem documentação em src/api-reference.ts').toEqual([]);
    expect(documented.filter((r) => !registered.includes(r)), 'rotas documentadas que não existem mais').toEqual([]);
    await app.close();
  });

  it('descreve cada rota por completo', () => {
    for (const route of API_REFERENCE.flatMap((g) => g.routes)) {
      const where = `${route.method} ${route.path}`;
      expect(route.summary.trim(), where).not.toBe('');
      expect(route.response.trim(), where).not.toBe('');
      // Todo parâmetro do caminho precisa estar descrito.
      const inPath = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect((route.params ?? []).map((p) => p.name).sort(), where).toEqual(inPath);
      for (const field of [...(route.params ?? []), ...(route.query ?? []), ...(route.body ?? [])]) {
        expect(field.description.trim(), `${where} ${field.name}`).not.toBe('');
      }
    }
  });
});
