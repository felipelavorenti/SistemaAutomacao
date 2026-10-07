import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DATA_TABLE_COLUMN_TYPES, DATA_TABLE_CONDITIONS, type DataTableColumnType, type DataTableConditionType, type JsonObject } from '@sa/engine';
import { currentUser, type AppDeps } from '../app.js';
import { many } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { PgDataTableStore } from '../lib/data-tables.js';
import { notFound, requireCap } from '../lib/permissions.js';

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));
const columnsSchema = z
  .array(z.object({ name: z.string().trim().min(1), type: z.enum(DATA_TABLE_COLUMN_TYPES as [DataTableColumnType, ...DataTableColumnType[]]) }))
  .max(200);
const idParam = z.object({ id: z.string().uuid() });

/**
 * Tabelas de dados: a tela Tabelas de dados e quem usa a API. Todo usuário logado vê as tabelas;
 * criar, alterar e apagar (tabelas e linhas) exige o perfil Editor ou acima, como editar fluxos.
 */
export const dataTableRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const storeFor = (userId: string) => new PgDataTableStore(db, userId);

    app.get('/data-tables', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:view');
      const q = z.object({ name: z.string().trim().optional() }).parse(request.query);
      const tables = await storeFor(user.id).list({ name: q.name || undefined });
      const counts = await many<{ table_id: string; n: string }>(db, 'SELECT table_id, count(*) AS n FROM data_table_rows WHERE table_id = ANY($1) GROUP BY table_id', [
        tables.map((t) => t.id),
      ]);
      return tables.map((t) => ({ ...t, rowCount: Number(counts.find((c) => c.table_id === t.id)?.n ?? 0) }));
    });

    app.post('/data-tables', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const b = z.object({ name: z.string().trim().min(1).max(128), columns: columnsSchema.default([]) }).parse(request.body);
      const table = await storeFor(user.id).create(b.name, b.columns);
      await audit(db, { userId: user.id, action: 'create', entityType: 'data_table', entityId: table.id, entityName: table.name, after: { columns: table.columns }, ip: request.ip });
      return { ...table, rowCount: 0 };
    });

    app.get('/data-tables/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:view');
      const { id } = idParam.parse(request.params);
      const store = storeFor(user.id);
      const table = await store.get(id);
      return { ...table, rowCount: await store.count(table.id) };
    });

    app.put('/data-tables/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const b = z.object({ name: z.string().trim().min(1).max(128).optional(), columns: columnsSchema.optional() }).parse(request.body);
      const store = storeFor(user.id);
      const before = await store.get(id);
      let table = before;
      if (b.name !== undefined && b.name !== before.name) table = await store.rename(id, b.name);
      if (b.columns) table = await store.setColumns(id, b.columns);
      await audit(db, {
        userId: user.id,
        action: 'update',
        entityType: 'data_table',
        entityId: id,
        entityName: table.name,
        before: { name: before.name, columns: before.columns },
        after: { name: table.name, columns: table.columns },
        ip: request.ip,
      });
      return { ...table, rowCount: await store.count(id) };
    });

    app.delete('/data-tables/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const store = storeFor(user.id);
      const table = await store.get(id);
      const rows = await store.count(id);
      await store.delete(id);
      await audit(db, { userId: user.id, action: 'delete', entityType: 'data_table', entityId: id, entityName: table.name, before: { columns: table.columns, rows }, ip: request.ip });
      return { ok: true };
    });

    app.get('/data-tables/:id/rows', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:view');
      const { id } = idParam.parse(request.params);
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(1000).default(100),
          offset: z.coerce.number().int().min(0).default(0),
          orderBy: z.string().trim().optional(),
          orderDirection: z.enum(['asc', 'desc']).default('asc'),
          /** Filtro em JSON: { type: 'and' | 'or', conditions: [{ column, condition, value }] }. */
          filter: z.string().optional(),
        })
        .parse(request.query);
      const filter = q.filter
        ? z
            .object({
              type: z.enum(['and', 'or']).default('and'),
              conditions: z.array(
                z.object({ column: z.string(), condition: z.enum(DATA_TABLE_CONDITIONS as unknown as [DataTableConditionType, ...DataTableConditionType[]]), value: jsonValue.optional() }),
              ),
            })
            .parse(JSON.parse(q.filter))
        : undefined;
      const store = storeFor(user.id);
      const table = await store.get(id);
      const [rows, total] = await Promise.all([
        store.getRows(table.id, { filter: filter as never, limit: q.limit, offset: q.offset, orderBy: q.orderBy || undefined, orderDirection: q.orderDirection }),
        store.count(table.id, filter as never),
      ]);
      return { rows, total };
    });

    app.post('/data-tables/:id/rows', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const b = z.object({ rows: z.array(z.record(jsonValue)).min(1).max(10_000) }).parse(request.body);
      const store = storeFor(user.id);
      const table = await store.get(id);
      const rows = await store.insertRows(table.id, b.rows as JsonObject[]);
      await audit(db, { userId: user.id, action: 'insert_rows', entityType: 'data_table', entityId: table.id, entityName: table.name, after: { rows: rows.length }, ip: request.ip });
      return rows;
    });

    app.put('/data-tables/:id/rows/:rowId', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id, rowId } = z.object({ id: z.string().uuid(), rowId: z.coerce.number().int().min(1) }).parse(request.params);
      const b = z.object({ data: z.record(jsonValue) }).parse(request.body);
      const store = storeFor(user.id);
      const table = await store.get(id);
      const [row] = await store.updateRows(table.id, { type: 'and', conditions: [{ column: 'id', condition: 'eq', value: rowId }] }, b.data as JsonObject);
      if (!row) throw notFound('Linha');
      await audit(db, { userId: user.id, action: 'update_rows', entityType: 'data_table', entityId: table.id, entityName: table.name, after: { ids: [rowId] }, ip: request.ip });
      return row;
    });

    app.post('/data-tables/:id/rows/delete', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const b = z.object({ ids: z.array(z.number().int().min(1)).min(1).max(10_000) }).parse(request.body);
      const store = storeFor(user.id);
      const table = await store.get(id);
      const removed = await store.deleteRowIds(table.id, b.ids);
      await audit(db, { userId: user.id, action: 'delete_rows', entityType: 'data_table', entityId: table.id, entityName: table.name, before: { ids: removed }, ip: request.ip });
      return { deleted: removed.length };
    });
  };
