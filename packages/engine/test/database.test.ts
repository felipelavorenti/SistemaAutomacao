import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDbClient, type DbClient } from '../src/database/drivers.js';
import { buildInsertSql, compileNamedParams, insertBatchRows, insertParams } from '../src/database/params.js';
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

describe('INSERT em lote: texto do comando e limites', () => {
  const cols = ['codigo', 'nome'];

  it('uma linha mantém o texto de sempre, várias linhas usam linha_coluna', () => {
    expect(buildInsertSql('postgres', 't', cols, 1)).toBe('INSERT INTO t (codigo, nome) VALUES (:p0, :p1)');
    expect(insertParams([[1, 'a']])).toEqual({ p0: 1, p1: 'a' });
    expect(buildInsertSql('postgres', 't', cols, 2)).toBe('INSERT INTO t (codigo, nome) VALUES (:p0_0, :p0_1), (:p1_0, :p1_1)');
    expect(buildInsertSql('mssql', 't', cols, 2)).toBe('INSERT INTO t (codigo, nome) VALUES (:p0_0, :p0_1), (:p1_0, :p1_1)');
    expect(insertParams([[1, 'a'], [2, null]])).toEqual({ p0_0: 1, p0_1: 'a', p1_0: 2, p1_1: null });
  });

  it('Oracle usa INSERT ALL quando são várias linhas', () => {
    expect(buildInsertSql('oracle', 't', cols, 1)).toBe('INSERT INTO t (codigo, nome) VALUES (:p0, :p1)');
    expect(buildInsertSql('oracle', 't', cols, 2)).toBe('INSERT ALL INTO t (codigo, nome) VALUES (:p0_0, :p0_1) INTO t (codigo, nome) VALUES (:p1_0, :p1_1) SELECT 1 FROM DUAL');
  });

  it('o lote respeita os limites de cada banco e nunca fica abaixo de 1', () => {
    expect(insertBatchRows('postgres', 3, 500)).toBe(500);
    expect(insertBatchRows('postgres', 3, 100_000)).toBe(10_000);
    expect(insertBatchRows('postgres', 100, 5_000)).toBe(600);
    expect(insertBatchRows('mssql', 3, 500)).toBe(500);
    expect(insertBatchRows('mssql', 3, 5_000)).toBe(666);
    expect(insertBatchRows('mssql', 1, 5_000)).toBe(1_000);
    expect(insertBatchRows('oracle', 3, 500)).toBe(333);
    expect(insertBatchRows('oracle', 1_500, 500)).toBe(1);
    expect(insertBatchRows('postgres', 3, 1)).toBe(1);
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
      'CREATE TABLE engine_test.lote (codigo int, nome text, preco numeric(10,2))',
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
            "IF OBJECT_ID('dbo.lote', 'U') IS NOT NULL DROP TABLE dbo.lote",
            'CREATE TABLE dbo.lote (codigo int, nome nvarchar(100), preco decimal(10,2))',
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
            "BEGIN EXECUTE IMMEDIATE 'DROP TABLE lote'; EXCEPTION WHEN OTHERS THEN NULL; END;",
            'CREATE TABLE lote (codigo NUMBER, nome VARCHAR2(100), preco NUMBER(10,2))',
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
  const lote = target.connection.type === 'postgres' ? 'engine_test.lote' : target.connection.type === 'mssql' ? 'dbo.lote' : 'lote';
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
      // Os dois itens do primeiro teste foram num INSERT só.
      expect(logs.filter((l) => l.operation === 'insert')).toHaveLength(1);
      expect(logs.find((l) => l.operation === 'insert')).toMatchObject({
        rowsAffected: 2,
        params: { p0_0: 1, p0_1: 'Arroz', p0_2: 10.5, p1_0: 2, p1_1: 'Feijão', p1_2: 8 },
      });
    });

    describe('INSERT em lote', () => {
      const countOf = async () => {
        const row = (await admin.query(`SELECT COUNT(*) AS n FROM ${lote}`, {})).rows[0];
        return Number(Object.values(row)[0]);
      };
      const items = (from: number, n: number): Item[] => Array.from({ length: n }, (_, i) => ({ json: { codigo: from + i, nome: `Produto ${from + i}`, preco: 1.5 } }));
      const inserts = (since: number) => logs.slice(since).filter((l) => l.operation === 'insert');

      it('manda os itens em lotes: um comando por lote e uma linha de saída por item', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const since = logs.length;
        const result = await run({ operation: 'insert', table: lote, batchSize: 2 }, items(1, 5));
        expect(result.status, JSON.stringify(result.error)).toBe('success');
        expect(inserts(since).map((l) => l.rowsAffected)).toEqual([2, 2, 1]);
        expect(result.lastOutput).toHaveLength(5);
        expect(result.lastOutput.map((i) => i.json.codigo)).toEqual([1, 2, 3, 4, 5]);
        expect(result.lastOutput.every((i) => i.json.linhasAfetadas === 1)).toBe(true);
        expect(await countOf()).toBe(5);
      });

      it('mudar as colunas ou a tabela começa outro lote', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const since = logs.length;
        const mixed: Item[] = [{ json: { codigo: 1, nome: 'a' } }, { json: { codigo: 2, nome: 'b' } }, { json: { codigo: 3, nome: 'c', preco: 2 } }, { json: { codigo: 4, nome: 'd', preco: 3 } }];
        const result = await run({ operation: 'insert', table: lote }, mixed);
        expect(result.status, JSON.stringify(result.error)).toBe('success');
        expect(inserts(since).map((l) => l.rowsAffected)).toEqual([2, 2]);
        expect(result.lastOutput.map((i) => i.json.codigo)).toEqual([1, 2, 3, 4]);
        expect(await countOf()).toBe(4);
      });

      it('valores por item (expressão) e colunas escolhidas também vão em lote', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const since = logs.length;
        const result = await run(
          { operation: 'insert', table: lote, columnsMode: 'manual', columns: [{ column: 'codigo', value: '={{ $json.n }}' }, { column: 'nome', value: '={{ "x" + $json.n }}' }] },
          [{ json: { n: 10 } }, { json: { n: 11 } }, { json: { n: 12 } }],
        );
        expect(result.status, JSON.stringify(result.error)).toBe('success');
        expect(inserts(since)).toHaveLength(1);
        expect(inserts(since)[0].rowsAffected).toBe(3);
        const rows = (await admin.query(`SELECT codigo, nome FROM ${lote} ORDER BY codigo`, {})).rows.map(lower);
        expect(rows).toEqual([{ codigo: 10, nome: 'x10' }, { codigo: 11, nome: 'x11' }, { codigo: 12, nome: 'x12' }]);
      });

      it('com 1 linha por comando, cada item é um INSERT como antes dos lotes', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const since = logs.length;
        const result = await run({ operation: 'insert', table: lote, batchSize: 1 }, items(1, 3));
        expect(result.status, JSON.stringify(result.error)).toBe('success');
        expect(inserts(since)).toHaveLength(3);
        expect(inserts(since)[0]).toMatchObject({ rowsAffected: 1, params: { p0: 1, p1: 'Produto 1', p2: 1.5 } });
        expect(await countOf()).toBe(3);
      });

      it('o lote respeita o limite de parâmetros do banco', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const since = logs.length;
        const result = await run({ operation: 'insert', table: lote, batchSize: 100_000 }, items(1, 1_200));
        expect(result.status, JSON.stringify(result.error)).toBe('success');
        const size = insertBatchRows(target.connection.type as 'postgres' | 'mssql' | 'oracle', 3, 100_000);
        expect(inserts(since)).toHaveLength(Math.ceil(1_200 / size));
        expect(result.lastOutput).toHaveLength(1_200);
        expect(await countOf()).toBe(1_200);
      });

      it('lote com erro não insere nenhuma linha dele e a mensagem diz quais itens eram', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const bad: Item[] = [{ json: { codigo: 1, nome: 'a' } }, { json: { codigo: 'abc', nome: 'b' } }, { json: { codigo: 3, nome: 'c' } }];
        const result = await run({ operation: 'insert', table: lote }, bad);
        expect(result.status).toBe('error');
        expect(result.error?.message).toMatch(/^Itens 0 a 2: /);
        expect(await countOf()).toBe(0);

        // Um lote que já tinha ido continua inserido; o que deu erro é dito pelo item.
        const second = await run({ operation: 'insert', table: lote, batchSize: 2 }, [...items(1, 2), { json: { codigo: 'abc', nome: 'x' } }]);
        expect(second.status).toBe('error');
        expect(second.error?.message).toMatch(/^Item 2: /);
        expect(await countOf()).toBe(2);
      });

      it('um item com problema na própria leitura não impede os anteriores de serem inseridos', async () => {
        await admin.query(`DELETE FROM ${lote}`, {});
        const result = await run({ operation: 'insert', table: lote, columnsMode: 'manual', columns: [{ column: '={{ $json.coluna }}', value: '1' }] }, [
          { json: { coluna: 'codigo' } },
          { json: { coluna: 'codigo' } },
          { json: { coluna: 'coluna inválida' } },
        ]);
        expect(result.status).toBe('error');
        expect(result.error?.message).toMatch(/^Item 2: /);
        expect(await countOf()).toBe(2);
      });
    });
  });
}

describe('SQL Server fora do ar', () => {
  it('tenta conectar de novo na próxima consulta depois de uma falha', async () => {
    const mssql = (await import('mssql')).default;
    const connect = vi.spyOn(mssql.ConnectionPool.prototype, 'connect');
    // Porta fechada: a conexão falha na hora.
    const client = createDbClient({ id: 'mssql-off', type: 'mssql', data: { host: '127.0.0.1', port: '1', user: 'sa', password: 'x', database: 'db' } });
    try {
      await expect(client.query('SELECT 1', {})).rejects.toThrow();
      await expect(client.query('SELECT 1', {})).rejects.toThrow();
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      connect.mockRestore();
      await client.close();
    }
  });
});
