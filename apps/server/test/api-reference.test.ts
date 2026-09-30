import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_EXAMPLES } from '../src/api-examples.js';
import { replaceRoutes } from '../src/api-markdown.js';
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
      // Todo parâmetro do caminho precisa estar descrito.
      const inPath = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect((route.params ?? []).map((p) => p.name).sort(), where).toEqual(inPath);
      for (const field of [...(route.params ?? []), ...(route.query ?? []), ...(route.body ?? [])]) {
        expect(field.description.trim(), `${where} ${field.name}`).not.toBe('');
      }
    }
  });

  it('traz um exemplo em cada rota, com o caminho e os campos dela', () => {
    for (const route of API_REFERENCE.flatMap((g) => g.routes)) {
      const where = `${route.method} ${route.path}`;
      const example = route.example;
      expect(example, `${where} sem exemplo em src/api-examples.ts`).toBeDefined();
      const [path, search = ''] = (example!.path ?? route.path).split('?');
      expect(path, where).toMatch(new RegExp(`^${route.path.replace(/\{\w+\}/g, '[^/]+')}$`));
      const query = (route.query ?? []).map((f) => f.name);
      expect([...new URLSearchParams(search).keys()].filter((k) => !query.includes(k)), `${where}: filtro do exemplo sem descrição`).toEqual([]);
      const body = (route.body ?? []).map((f) => f.name);
      const sent = example!.body === undefined ? [] : Object.keys(example!.body as object);
      expect(sent.filter((k) => !body.includes(k)), `${where}: campo do exemplo sem descrição`).toEqual([]);
    }
    const documented = API_REFERENCE.flatMap((g) => g.routes.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(API_EXAMPLES).filter((k) => !documented.includes(k)), 'exemplos de rotas que não existem').toEqual([]);
  });

  it('mostra no exemplo de GET /docs o começo da referência de verdade', () => {
    const [first] = API_REFERENCE;
    expect(API_EXAMPLES['GET /docs'].response).toEqual([{ ...first, routes: first.routes.slice(0, 1) }]);
  });

  it('mantém docs/api.md igual à referência', () => {
    const doc = readFileSync(new URL('../../../docs/api.md', import.meta.url), 'utf8');
    expect(doc === replaceRoutes(doc, API_REFERENCE), 'docs/api.md ficou para trás: rode npm run docs:api -w @sa/server').toBe(true);
  });
});
