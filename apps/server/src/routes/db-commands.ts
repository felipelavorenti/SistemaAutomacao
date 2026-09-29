import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentUser, type AppDeps } from '../app.js';
import { many } from '../db/db.js';
import { requireCap } from '../lib/permissions.js';

/** Comandos executados nos bancos dos clientes, filtrados pelos clientes que o usuário enxerga. */
export const dbCommandRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/db-commands', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'execution:view');
      const q = z
        .object({
          clientId: z.string().uuid().optional(),
          connectionId: z.string().uuid().optional(),
          executionId: z.string().uuid().optional(),
          status: z.enum(['ok', 'error']).optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          search: z.string().trim().optional(),
          beforeId: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      return many(
        db,
        `SELECT d.id, d.at, d.execution_id, d.workflow_id, d.workflow_name, d.node_name, d.connection_id, d.connection_name,
                d.client_id, d.client_name, d.db_type, d.operation, d.sql, d.params, d.rows, d.rows_affected, d.duration_ms, d.error,
                u.name AS triggered_by_name
         FROM db_commands d LEFT JOIN users u ON u.id = d.triggered_by
         WHERE ($1::uuid[] IS NULL OR d.client_id IS NULL OR d.client_id = ANY($1))
           AND ($2::uuid IS NULL OR d.client_id = $2)
           AND ($3::uuid IS NULL OR d.connection_id = $3)
           AND ($4::uuid IS NULL OR d.execution_id = $4)
           AND ($5::text IS NULL OR ($5 = 'error') = (d.error IS NOT NULL))
           AND ($6::timestamptz IS NULL OR d.at >= $6)
           AND ($7::timestamptz IS NULL OR d.at <= $7)
           AND ($8::text IS NULL OR d.sql ILIKE '%' || $8 || '%' OR d.workflow_name ILIKE '%' || $8 || '%' OR d.error ILIKE '%' || $8 || '%')
           AND ($9::bigint IS NULL OR d.id < $9)
         ORDER BY d.id DESC LIMIT $10`,
        [
          user.clientIds,
          q.clientId ?? null,
          q.connectionId ?? null,
          q.executionId ?? null,
          q.status ?? null,
          q.from ?? null,
          q.to ?? null,
          q.search || null,
          q.beforeId ?? null,
          q.limit,
        ],
      );
    });
  };
