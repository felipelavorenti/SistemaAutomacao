import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentUser, type AppDeps } from '../app.js';
import { one } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { HttpError, notFound, requireCap } from '../lib/permissions.js';

/** Mesmo limite de anexos do Gmail. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface FileRow {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  created_at: Date;
  created_by_name: string | null;
}

const toPublic = (row: FileRow) => ({
  id: row.id,
  name: row.name,
  mimeType: row.mime_type,
  size: row.size,
  createdAt: row.created_at,
  createdByName: row.created_by_name,
});

const SELECT = `
  SELECT f.id, f.name, f.mime_type, f.size, f.created_at, u.name AS created_by_name
  FROM files f
  LEFT JOIN users u ON u.id = f.created_by`;

const idParam = z.object({ id: z.string().uuid() });

export const fileRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // O arquivo chega como está no corpo, sem base64.
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_request, body, done) => done(null, body));

    /** Guarda um arquivo enviado pela tela e devolve o ID que o fluxo usa. */
    app.post('/files', { bodyLimit: MAX_FILE_BYTES }, async (request, reply) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const q = z
        .object({ name: z.string().trim().min(1).max(255), type: z.string().trim().max(255).default('') })
        .parse(request.query);
      if (!Buffer.isBuffer(request.body)) throw new HttpError(400, 'Envie o arquivo no corpo, com Content-Type: application/octet-stream');
      const content = request.body;
      if (!content.length) throw new HttpError(400, 'O arquivo está vazio');
      const mimeType = q.type || 'application/octet-stream';
      const row = await one<FileRow>(
        db,
        `WITH f AS (
           INSERT INTO files (name, mime_type, size, content, created_by) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, mime_type, size, created_at, created_by
         )
         SELECT f.id, f.name, f.mime_type, f.size, f.created_at, u.name AS created_by_name FROM f LEFT JOIN users u ON u.id = f.created_by`,
        [q.name, mimeType, content.length, content, user.id],
      );
      await audit(db, {
        userId: user.id,
        action: 'create',
        entityType: 'file',
        entityId: row!.id,
        entityName: row!.name,
        after: { name: row!.name, mimeType, size: row!.size },
        ip: request.ip,
      });
      reply.code(201);
      return toPublic(row!);
    });

    /** Nome, tipo e tamanho do arquivo. */
    app.get('/files/:id', async (request) => {
      requireCap(currentUser(request), 'workflow:view');
      const { id } = idParam.parse(request.params);
      const row = await one<FileRow>(db, `${SELECT} WHERE f.id = $1`, [id]);
      if (!row) throw notFound('Arquivo');
      return toPublic(row);
    });

    /** Baixa o conteúdo do arquivo. */
    app.get('/files/:id/content', async (request, reply) => {
      requireCap(currentUser(request), 'workflow:view');
      const { id } = idParam.parse(request.params);
      const row = await one<{ name: string; mime_type: string; content: Buffer }>(db, 'SELECT name, mime_type, content FROM files WHERE id = $1', [id]);
      if (!row) throw notFound('Arquivo');
      reply.header('content-type', row.mime_type);
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
      return reply.send(row.content);
    });
  };
