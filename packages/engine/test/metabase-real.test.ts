import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { ConnectionData } from '../src/node-types.js';
import type { JsonObject, WorkflowDefinition } from '../src/types.js';

// Roda contra um Metabase de verdade (no CI, o serviço metabase/metabase) com o banco de exemplo.
const url = process.env.TEST_METABASE_URL;
const admin = { email: 'teste@empresa.com', password: 'Teste_Forte_123!x' };

async function api(path: string, init: RequestInit & { session?: string } = {}): Promise<any> {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.session ? { 'X-Metabase-Session': init.session } : {}), ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

describe.skipIf(!url)('Metabase de verdade', { timeout: 420_000 }, () => {
  let session = '';
  let apiKey = '';
  let cardWithParams = 0;
  let cardOnlyTags = 0;

  beforeAll(async () => {
    const deadline = Date.now() + 360_000;
    for (;;) {
      try {
        if ((await api('/api/health')).status === 'ok') break;
      } catch {
        // ainda subindo
      }
      if (Date.now() > deadline) throw new Error('O Metabase de teste não subiu');
      await new Promise((r) => setTimeout(r, 3000));
    }
    const { 'setup-token': token } = await api('/api/session/properties');
    if (token) {
      session = (
        await api('/api/setup', {
          method: 'POST',
          body: JSON.stringify({
            token,
            user: { first_name: 'Teste', last_name: 'CI', email: admin.email, password: admin.password, site_name: 'Teste' },
            prefs: { site_name: 'Teste', site_locale: 'en', allow_tracking: false },
          }),
        })
      ).id;
    } else {
      session = (await api('/api/session', { method: 'POST', body: JSON.stringify({ username: admin.email, password: admin.password }) })).id;
    }

    let databaseId = 0;
    while (!databaseId) {
      const list = await api('/api/database', { session });
      const sample = (list.data ?? list).find((d: JsonObject) => d.is_sample || d.name === 'Sample Database');
      if (sample) databaseId = sample.id;
      else if (Date.now() > deadline) throw new Error('Banco de exemplo do Metabase não apareceu');
      else await new Promise((r) => setTimeout(r, 3000));
    }

    const tags = {
      categoria: { id: randomUUID(), name: 'categoria', 'display-name': 'Categoria', type: 'text' },
      preco_min: { id: randomUUID(), name: 'preco_min', 'display-name': 'Preço mínimo', type: 'number' },
    };
    const card = (name: string, parameters?: JsonObject[]) =>
      api('/api/card', {
        method: 'POST',
        session,
        body: JSON.stringify({
          name,
          display: 'table',
          visualization_settings: {},
          dataset_query: {
            type: 'native',
            database: databaseId,
            native: {
              query: 'SELECT ID, TITLE, CATEGORY, PRICE FROM PRODUCTS WHERE CATEGORY = {{categoria}} AND PRICE > {{preco_min}} ORDER BY ID',
              'template-tags': tags,
            },
          },
          ...(parameters ? { parameters } : {}),
        }),
      });
    // Como a tela do Metabase salva: com os parâmetros no card.
    cardWithParams = (
      await card('Produtos com parâmetros', [
        { id: tags.categoria.id, type: 'category', target: ['variable', ['template-tag', 'categoria']], name: 'Categoria', slug: 'categoria' },
        { id: tags.preco_min.id, type: 'number/=', target: ['variable', ['template-tag', 'preco_min']], name: 'Preço mínimo', slug: 'preco_min' },
      ])
    ).id;
    cardOnlyTags = (await card('Produtos só com variáveis')).id;

    const groups = await api('/api/permissions/group', { session });
    const admins = groups.find((g: JsonObject) => g.name === 'Administrators');
    apiKey = (await api('/api/api-key', { method: 'POST', session, body: JSON.stringify({ name: 'Teste CI', group_id: admins.id }) })).unmasked_key;
  }, 420_000);

  const run = (question: number, connection: ConnectionData, filters: JsonObject[]) => {
    const workflow: WorkflowDefinition = {
      nodes: [
        { id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'm', name: 'Metabase', type: 'metabase', position: { x: 0, y: 0 }, parameters: { connection: connection.id, question: String(question), filters } },
      ],
      connections: [{ from: 't', fromOutput: 0, to: 'm', toInput: 0 }],
    };
    return executeWorkflow({ workflow, executionId: 'x', mode: 'manual', getConnection: async () => connection });
  };
  const withPassword = (): ConnectionData => ({ id: 'mb', type: 'metabase', data: { url: url!, username: admin.email, password: admin.password } });
  const withKey = (): ConnectionData => ({ id: 'mb', type: 'metabase', data: { url: url!, apiKey } });
  const filters = [
    { name: 'Categoria', value: 'Gizmo' },
    { name: 'preco_min', value: '50' },
  ];

  it.each([
    ['com os parâmetros do card', () => cardWithParams],
    ['só com as variáveis do SQL', () => cardOnlyTags],
  ])('executa a question %s e aplica os filtros', async (_, card) => {
    const result = await run(card(), withPassword(), filters);
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    const rows = result.lastOutput.map((i) => i.json);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.CATEGORY).toBe('Gizmo');
      expect(Number(row.PRICE)).toBeGreaterThan(50);
    }
  });

  it('funciona com API key', async () => {
    const result = await run(cardWithParams, withKey(), filters);
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(result.lastOutput.length).toBeGreaterThan(0);
  });

  it('senha errada traz o retorno do Metabase', async () => {
    const result = await run(cardWithParams, { id: 'mb', type: 'metabase', data: { url: url!, username: admin.email, password: 'errada' } }, []);
    expect(result.error?.message).toMatch(/Metabase respondeu com status (400|401)/);
  });
});
