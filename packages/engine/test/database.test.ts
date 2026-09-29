import { afterAll, describe, expect, it } from 'vitest';
import { createDbClient, type DbClient } from '../src/database/drivers.js';
import { compileNamedParams } from '../src/database/params.js';
import { executeWorkflow } from '../src/executor.js';
import type { ConnectionData, DatabaseCommandLog } from '../src/node-types.js';
import type { Item, JsonObject, NodeInstance, WorkflowDefinition } from '../src/types.js';

describe('parâmetros nomeados', () => {
  it('converte para cada banco sem mexer em textos, comentários e cast', () => {
    const sql = "SELECT :a, ':b', x::int, :a -- :c\n FROM t WHERE y = :d /* :e */";
    expect(compileNamedParams(sql, 'postgres')).toEqual({ sql: "SELECT $1, ':b', x::int, $1 -- :c\n FROM t WHERE y = $2 /* :e */", names: ['a', 'd'] });
    expect(compileNamedParams(sql, 'mssql').sql).toBe("SELECT @a, ':b', x::int, @a -- :c\n FROM t WHERE y = @d /* :e */");
    expect(compileNamedParams("SELECT 'it''s :x', :y FROM dual", 'oracle')).toEqual({ sql: "SELECT 'it''s :x', :y FROM dual", names: ['y'] });
  });
});

// Bancos de teste: Postgres local ou do CI; SQL Server e Oracle só no CI (serviços do workflow).
function postgresFromUrl(url: string): ConnectionData {
  const u = new URL(url);
  return {
    id: 'pg',
    type: 'postgres',
    data: { host: u.hostname, port: u.port || '5432', database: u.pathname.slice(1), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
  };
}

const env = process.env;
const targets: { name: string; connection: ConnectionData; setup: string[]; cursor: boolean; required?: boolean }[] = [
  {
    name: 'Postgres',
    connection: postgresFromUrl(env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/automacao_test'),
    cursor: true,
    setup: [
      'DROP SCHEMA IF EXISTS engine_test CASCADE',
      'CREATE SCHEMA engine_test',
      'CREATE TABLE engine_test.produtos (codigo int, nome text, preco numeric(10,2))',
      `CREATE PROCEDURE engine_test.dobra(IN x int, INOUT resultado int, INOUT cur refcursor) LANGUAGE plpgsql AS $$
       BEGIN resultado := x * 2; OPEN cur FOR SELECT codigo, nome FROM engine_test.produtos ORDER BY codigo; END $$`,
    ],
  },
  ...(env.TEST_MSSQL_HOST
    ? [
        {
          name: 'SQL Server',
          required: true,
          connection: {
            id: 'mssql',
            type: 'mssql',
            data: { host: env.TEST_MSSQL_HOST, port: env.TEST_MSSQL_PORT ?? '1433', database: 'master', user: 'sa', password: env.TEST_MSSQL_PASSWORD ?? '', trustServerCertificate: 'true' },
          },
          cursor: false,
          setup: [
            "IF OBJECT_ID('dbo.dobra', 'P') IS NOT NULL DROP PROCEDURE dbo.dobra",
            "IF OBJECT_ID('dbo.produtos', 'U') IS NOT NULL DROP TABLE dbo.produtos",
            'CREATE TABLE dbo.produtos (codigo int, nome nvarchar(100), preco decimal(10,2))',
            'CREATE PROCEDURE dbo.dobra @x INT, @resultado INT OUTPUT AS BEGIN SET @resultado = @x * 2; SELECT codigo, nome FROM dbo.produtos ORDER BY codigo; END',
          ],
        },
      ]
    : []),
  ...(env.TEST_ORACLE_CONNECT
    ? [
        {
          name: 'Oracle',
          required: true,
          connection: { id: 'oracle', type: 'oracle', data: { connectString: env.TEST_ORACLE_CONNECT, user: env.TEST_ORACLE_USER ?? '', password: env.TEST_ORACLE_PASSWORD ?? '' } },
          cursor: true,
          setup: [
            "BEGIN EXECUTE IMMEDIATE 'DROP TABLE produtos'; EXCEPTION WHEN OTHERS THEN NULL; END;",
            'CREATE TABLE produtos (codigo NUMBER, nome VARCHAR2(100), preco NUMBER(10,2))',
            `CREATE OR REPLACE PROCEDURE dobra(x IN NUMBER, resultado OUT NUMBER, cur OUT SYS_REFCURSOR) AS
             BEGIN resultado := x * 2; OPEN cur FOR SELECT codigo, nome FROM produtos ORDER BY codigo; END;`,
          ],
        },
      ]
    : []),
];

async function reachable(connection: ConnectionData): Promise<boolean> {
  const client = createDbClient(connection);
  try {
    await client.query(connection.type === 'oracle' ? 'SELECT 1 FROM dual' : 'SELECT 1', {});
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

const lower = (row: JsonObject) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));

/** No CI, SQL Server e Oracle demoram a subir: espera até 4 minutos e falha se não subirem. */
async function waitReachable(connection: ConnectionData, required: boolean): Promise<boolean> {
  const deadline = Date.now() + (required ? 240_000 : 0);
  for (;;) {
    if (await reachable(connection)) return true;
    if (Date.now() >= deadline) {
      if (required) throw new Error(`Banco de teste ${connection.type} não respondeu`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

for (const target of targets) {
  const available = await waitReachable(target.connection, !!target.required);
  const table = target.connection.type === 'postgres' ? 'engine_test.produtos' : target.connection.type === 'mssql' ? 'dbo.produtos' : 'produtos';
  const proc = target.connection.type === 'postgres' ? 'engine_test.dobra' : target.connection.type === 'mssql' ? 'dbo.dobra' : 'dobra';

  describe.skipIf(!available)(`Banco de dados: ${target.name}`, () => {
    let admin: DbClient;
    const logs: DatabaseCommandLog[] = [];
    const node = (parameters: NodeInstance['parameters']): NodeInstance => ({ id: 'db', name: 'Banco', type: 'database', position: { x: 0, y: 0 }, parameters });
    const run = (parameters: NodeInstance['parameters'], input: Item[]) => {
      const workflow: WorkflowDefinition = {
        nodes: [{ id: 't', name: 'Início', type: 'manualTrigger', position: { x: 0, y: 0 }, parameters: {} }, node({ connection: target.connection.id, ...parameters })],
        connections: [{ from: 't', fromOutput: 0, to: 'db', toInput: 0 }],
      };
      return executeWorkflow({
        workflow,
        executionId: 'x',
        mode: 'manual',
        triggerItems: input,
        getConnection: async () => target.connection,
        onDatabaseCommand: (entry) => void logs.push(entry),
      });
    };

    afterAll(async () => admin?.close());

    it('cria as tabelas de teste', async () => {
      admin = createDbClient(target.connection);
      for (const sql of target.setup) await admin.query(sql, {});
    });

    it('insere os itens e consulta com parâmetros', async () => {
      const inserted = await run({ operation: 'insert', table }, [
        { json: { codigo: 1, nome: 'Arroz', preco: 10.5 } },
        { json: { codigo: 2, nome: 'Feijão', preco: 8 } },
      ]);
      expect(inserted.status, JSON.stringify(inserted.error)).toBe('success');
      expect(inserted.lastOutput[0].json.linhasAfetadas).toBe(1);

      const result = await run(
        { operation: 'query', sql: `SELECT codigo, nome FROM ${table} WHERE preco > :minimo ORDER BY codigo`, queryParams: [{ name: 'minimo', value: '={{ $json.minimo }}' }] },
        [{ json: { minimo: 9 } }],
      );
      expect(result.status, JSON.stringify(result.error)).toBe('success');
      expect(result.lastOutput.map((i) => lower(i.json))).toEqual([{ codigo: 1, nome: 'Arroz' }]);

      const updated = await run({ operation: 'query', sql: `UPDATE ${table} SET preco = preco + 1`, executeOnce: true }, [{ json: {} }, { json: {} }]);
      expect(updated.lastOutput).toEqual([{ json: { linhasAfetadas: 2 } }]);
    });

    it('executa procedure com parâmetro de saída e cursor', async () => {
      const params = [
        { name: 'x', direction: 'in', type: 'int', value: '={{ $json.n }}' },
        { name: 'resultado', direction: target.connection.type === 'postgres' ? 'inout' : 'out', type: 'int', value: '' },
        ...(target.cursor ? [{ name: 'cur', direction: 'out', type: 'cursor', value: '' }] : []),
      ];
      const result = await run({ operation: 'procedure', procedure: proc, procedureParams: params }, [{ json: { n: 21 } }]);
      expect(result.status, JSON.stringify(result.error)).toBe('success');
      const json = result.lastOutput[0].json;
      expect(Number(json.resultado)).toBe(42);
      const rows = (target.cursor ? json.cur : json.linhas) as JsonObject[];
      expect(rows.map(lower)).toEqual([{ codigo: 1, nome: 'Arroz' }, { codigo: 2, nome: 'Feijão' }]);
    });

    it('erro do banco vem com o código e fica registrado', async () => {
      const result = await run({ operation: 'query', sql: 'SELECT * FROM tabela_que_nao_existe' }, [{ json: {} }]);
      expect(result.status).toBe('error');
      expect(result.error?.nodeName).toBe('Banco');
      expect((result.error?.details as JsonObject).codigo).toBeTruthy();
      const last = logs.at(-1)!;
      expect(last).toMatchObject({ operation: 'query', sql: 'SELECT * FROM tabela_que_nao_existe', rows: null, connectionType: target.connection.type });
      expect(last.error).toBeTruthy();
      expect(logs.find((l) => l.operation === 'insert')).toMatchObject({ rowsAffected: 1, params: { p0: 1, p1: 'Arroz', p2: 10.5 } });
    });
  });
}
