import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { WorkflowDefinition } from '@sa/engine';
import { currentUser, type AppDeps } from '../app.js';
import { many, one } from '../db/db.js';
import { createExecution, decodeData } from '../executions/store.js';
import { audit } from '../lib/audit.js';
import { canSeeFolder, HttpError, notFound, requireCap, type CurrentUser } from '../lib/permissions.js';

interface ExecutionRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  folder_id: string;
  workflow_version: number | null;
  mode: string;
  status: string;
  triggered_by_name: string | null;
  retry_of: string | null;
  parent_execution_id: string | null;
  definition: WorkflowDefinition;
  input: unknown;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error_message: string | null;
  error_node: string | null;
  error: unknown;
  summary: unknown;
  custom_data: unknown;
  data: Buffer | null;
  data_size: number | null;
}

export const executionRoutes =
  ({ db, queue }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const load = async (user: CurrentUser, id: string): Promise<ExecutionRow> => {
      const row = await one<ExecutionRow>(
        db,
        `SELECT e.*, w.name AS workflow_name, w.folder_id, u.name AS triggered_by_name
         FROM executions e JOIN workflows w ON w.id = e.workflow_id LEFT JOIN users u ON u.id = e.triggered_by
         WHERE e.id = $1`,
        [id],
      );
      if (!row || !canSeeFolder(user, row.folder_id)) throw notFound('Execução');
      return row;
    };

    app.get('/executions', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'execution:view');
      const q = z
        .object({
          workflowId: z.string().uuid().optional(),
          status: z.enum(['queued', 'running', 'success', 'error', 'canceled']).optional(),
          mode: z.enum(['manual', 'schedule', 'subworkflow', 'retry']).optional(),
          parentId: z.string().uuid().optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          search: z.string().trim().optional(),
          /** Dados gravados pelo nó Execution Data: chave e, opcionalmente, o valor exato. */
          dataKey: z.string().trim().min(1).max(50).optional(),
          dataValue: z.string().max(512).optional(),
          before: z.string().datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      return many(
        db,
        `SELECT e.id, e.workflow_id, w.name AS workflow_name, e.mode, e.status, e.created_at, e.started_at, e.finished_at,
                e.error_message, e.error_node, u.name AS triggered_by_name, e.data_size, e.parent_execution_id, e.custom_data,
                round(extract(epoch FROM (e.finished_at - e.started_at)) * 1000)::float8 AS duration_ms
         FROM executions e JOIN workflows w ON w.id = e.workflow_id LEFT JOIN users u ON u.id = e.triggered_by
         WHERE ($1::uuid[] IS NULL OR w.folder_id = ANY($1))
           AND ($2::uuid IS NULL OR e.workflow_id = $2)
           AND ($3::text IS NULL OR e.status = $3)
           AND ($4::text IS NULL OR e.mode = $4)
           AND ($5::timestamptz IS NULL OR e.created_at >= $5)
           AND ($6::timestamptz IS NULL OR e.created_at <= $6)
           AND ($7::text IS NULL OR w.name ILIKE '%' || $7 || '%' OR e.error_message ILIKE '%' || $7 || '%' OR e.error_node ILIKE '%' || $7 || '%')
           AND ($8::timestamptz IS NULL OR e.created_at < $8)
           AND ($10::uuid IS NULL OR e.parent_execution_id = $10)
           AND ($11::text IS NULL OR (e.custom_data ? $11 AND ($12::text IS NULL OR e.custom_data ->> $11 = $12)))
         ORDER BY e.created_at DESC LIMIT $9`,
        [
          user.folderIds,
          q.workflowId ?? null,
          q.status ?? null,
          q.mode ?? null,
          q.from ?? null,
          q.to ?? null,
          q.search || null,
          q.before ?? null,
          q.limit,
          q.parentId ?? null,
          q.dataKey ?? null,
          q.dataKey ? (q.dataValue ?? null) : null,
        ],
      );
    });

    /** Fluxos agendados que já deviam ter começado e esperam uma vaga no worker. */
    app.get('/executions/waiting', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'execution:view');
      const waiting = await queue.waitingScheduled();
      if (!waiting.length) return [];
      const names = await many<{ id: string; name: string; folder_id: string }>(db, 'SELECT id, name, folder_id FROM workflows WHERE id = ANY($1::uuid[])', [
        [...new Set(waiting.map((w) => w.workflowId))],
      ]);
      const byId = new Map(names.filter((w) => canSeeFolder(user, w.folder_id)).map((w) => [w.id, w]));
      return waiting
        .filter((w) => byId.has(w.workflowId))
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((w) => ({ workflowId: w.workflowId, workflowName: byId.get(w.workflowId)!.name, dueAt: new Date(w.dueAt).toISOString() }));
    });

    app.get('/executions/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'execution:view');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const row = await load(user, id);
      const { data, ...rest } = row;
      // Subfluxos que esta execução chamou, só os que o usuário pode ver.
      const children = await many(
        db,
        `SELECT e.id, e.workflow_id, w.name AS workflow_name, e.status, e.created_at, e.error_message
         FROM executions e JOIN workflows w ON w.id = e.workflow_id
         WHERE e.parent_execution_id = $1 AND ($2::uuid[] IS NULL OR w.folder_id = ANY($2))
         ORDER BY e.created_at LIMIT 500`,
        [id, user.folderIds],
      );
      return { ...rest, runs: decodeData(data)?.runs ?? null, children };
    });

    // Arquivo gerado numa execução manual (dados binários de um item), para baixar ou ver na tela.
    app.get('/executions/:id/files/:ref', async (request, reply) => {
      const user = currentUser(request);
      requireCap(user, 'execution:view');
      const { id, ref } = z.object({ id: z.string().uuid(), ref: z.string().regex(/^[0-9a-f]{64}$/) }).parse(request.params);
      const { download } = z.object({ download: z.enum(['true', 'false']).optional() }).parse(request.query);
      await load(user, id);
      const file = await one<{ file_name: string | null; mime_type: string; content: Buffer }>(
        db,
        'SELECT file_name, mime_type, content FROM execution_files WHERE execution_id = $1 AND ref = $2',
        [id, ref],
      );
      if (!file) throw notFound('Arquivo');
      const name = file.file_name || 'arquivo';
      // Abrir na aba só tipos seguros; o resto (inclusive HTML e SVG) sempre baixa.
      const inline = download !== 'true' && /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|text\/plain|text\/csv|application\/json)$/.test(file.mime_type);
      reply.header('content-type', file.mime_type);
      reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      return reply.send(file.content);
    });

    app.post('/executions/:id/cancel', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:execute');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const row = await load(user, id);
      if (row.status === 'queued') {
        await db.query(`UPDATE executions SET status = 'canceled', finished_at = now(), error_message = 'Cancelada antes de começar' WHERE id = $1 AND status = 'queued'`, [id]);
      } else if (row.status === 'running') {
        await queue.requestCancel(id);
      } else {
        throw new HttpError(400, 'A execução já terminou');
      }
      await audit(db, { userId: user.id, action: 'cancel', entityType: 'execution', entityId: id, entityName: row.workflow_name, ip: request.ip });
      return { ok: true };
    });

    /** Roda de novo com a mesma definição e os mesmos dados de entrada. */
    app.post('/executions/:id/retry', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:execute');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const row = await load(user, id);
      if (row.status === 'queued' || row.status === 'running') throw new HttpError(400, 'A execução ainda está em andamento');
      const executionId = await createExecution(db, {
        workflowId: row.workflow_id,
        workflowVersion: row.workflow_version,
        mode: 'retry',
        triggeredBy: user.id,
        definition: row.definition,
        input: row.input as never,
        retryOf: id,
      });
      await queue.enqueueRun(executionId);
      await audit(db, { userId: user.id, action: 'retry', entityType: 'execution', entityId: executionId, entityName: row.workflow_name, after: { retryOf: id }, ip: request.ip });
      return { executionId };
    });
  };
