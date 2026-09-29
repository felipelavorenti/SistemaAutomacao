import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentUser, type AppDeps } from '../app.js';
import { many, one, transaction } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { checkPasswordStrength, hashPassword } from '../lib/auth.js';
import { HttpError, notFound, requireCap, ROLES } from '../lib/permissions.js';

const idParam = z.object({ id: z.string().uuid() });

const userBody = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1),
  role: z.enum(ROLES as [string, ...string[]]),
  active: z.boolean().default(true),
  password: z.string().optional(),
  folderIds: z.array(z.string().uuid()).default([]),
  clientIds: z.array(z.string().uuid()).default([]),
});

interface UserListRow {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  locked_until: Date | null;
  created_at: Date;
  folder_ids: string[];
  client_ids: string[];
}

const USER_SELECT = `
  SELECT u.id, u.email, u.name, u.role, u.active, u.locked_until, u.created_at,
    coalesce(array(SELECT folder_id FROM user_folders WHERE user_id = u.id), '{}') AS folder_ids,
    coalesce(array(SELECT client_id FROM user_clients WHERE user_id = u.id), '{}') AS client_ids
  FROM users u`;

export const adminRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // ---------- Usuários ----------
    app.get('/users', async (request) => {
      requireCap(currentUser(request), 'admin');
      return many<UserListRow>(db, `${USER_SELECT} ORDER BY u.name`);
    });

    app.post('/users', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const body = userBody.parse(request.body);
      const weak = body.password ? checkPasswordStrength(body.password) : 'Informe a senha inicial';
      if (weak) throw new HttpError(400, weak);
      const exists = await one(db, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [body.email]);
      if (exists) throw new HttpError(409, 'Já existe um usuário com esse e-mail');

      const id = await transaction(db, async (tx) => {
        const row = await one<{ id: string }>(
          tx,
          `INSERT INTO users (email, name, role, active, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
          [body.email, body.name, body.role, body.active, await hashPassword(body.password!)],
        );
        await setAccess(tx, row!.id, body.folderIds, body.clientIds);
        const { password: _, ...safe } = body;
        await audit(tx, { userId: me.id, action: 'create', entityType: 'user', entityId: row!.id, entityName: body.email, after: safe, ip: request.ip });
        return row!.id;
      });
      return one(db, `${USER_SELECT} WHERE u.id = $1`, [id]);
    });

    app.put('/users/:id', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const { id } = idParam.parse(request.params);
      const body = userBody.parse(request.body);
      const before = await one<UserListRow>(db, `${USER_SELECT} WHERE u.id = $1`, [id]);
      if (!before) throw notFound('Usuário');
      if (id === me.id && (body.role !== 'admin' || !body.active)) {
        throw new HttpError(400, 'Você não pode tirar o seu próprio acesso de administrador');
      }
      if (body.password) {
        const weak = checkPasswordStrength(body.password);
        if (weak) throw new HttpError(400, weak);
      }

      await transaction(db, async (tx) => {
        await tx.query('UPDATE users SET email = $2, name = $3, role = $4, active = $5, updated_at = now() WHERE id = $1', [
          id,
          body.email,
          body.name,
          body.role,
          body.active,
        ]);
        if (body.password) {
          await tx.query('UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1', [
            id,
            await hashPassword(body.password),
          ]);
        }
        if (!body.active || body.password) await tx.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        await setAccess(tx, id, body.folderIds, body.clientIds);
        const { password, ...safe } = body;
        await audit(tx, {
          userId: me.id,
          action: password ? 'update_and_reset_password' : 'update',
          entityType: 'user',
          entityId: id,
          entityName: body.email,
          before,
          after: safe,
          ip: request.ip,
        });
      });
      return one(db, `${USER_SELECT} WHERE u.id = $1`, [id]);
    });

    app.post('/users/:id/unlock', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const { id } = idParam.parse(request.params);
      await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
      await audit(db, { userId: me.id, action: 'unlock', entityType: 'user', entityId: id, ip: request.ip });
      return { ok: true };
    });

    // ---------- Pastas ----------
    app.get('/folders', async (request) => {
      const me = currentUser(request);
      if (me.folderIds === null) return many(db, 'SELECT id, name FROM folders ORDER BY name');
      return many(db, 'SELECT id, name FROM folders WHERE id = ANY($1) ORDER BY name', [me.folderIds]);
    });

    app.post('/folders', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const body = z.object({ name: z.string().trim().min(1) }).parse(request.body);
      const row = await one<{ id: string }>(db, 'INSERT INTO folders (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [body.name]);
      if (!row) throw new HttpError(409, 'Já existe uma pasta com esse nome');
      await audit(db, { userId: me.id, action: 'create', entityType: 'folder', entityId: row.id, entityName: body.name, ip: request.ip });
      return { id: row.id, name: body.name };
    });

    app.put('/folders/:id', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const { id } = idParam.parse(request.params);
      const body = z.object({ name: z.string().trim().min(1) }).parse(request.body);
      const before = await one<{ name: string }>(db, 'SELECT name FROM folders WHERE id = $1', [id]);
      if (!before) throw notFound('Pasta');
      await db.query('UPDATE folders SET name = $2 WHERE id = $1', [id, body.name]);
      await audit(db, { userId: me.id, action: 'update', entityType: 'folder', entityId: id, entityName: body.name, before, after: body, ip: request.ip });
      return { id, name: body.name };
    });

    app.delete('/folders/:id', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const { id } = idParam.parse(request.params);
      const used = await one(db, 'SELECT 1 FROM workflows WHERE folder_id = $1 LIMIT 1', [id]);
      if (used) throw new HttpError(409, 'A pasta tem fluxos; mova ou exclua os fluxos antes');
      const row = await one<{ name: string }>(db, 'DELETE FROM folders WHERE id = $1 RETURNING name', [id]);
      if (!row) throw notFound('Pasta');
      await audit(db, { userId: me.id, action: 'delete', entityType: 'folder', entityId: id, entityName: row.name, ip: request.ip });
      return { ok: true };
    });

    // ---------- Clientes ----------
    app.get('/clients', async (request) => {
      const me = currentUser(request);
      if (me.clientIds === null) return many(db, 'SELECT id, name, notes FROM clients ORDER BY name');
      return many(db, 'SELECT id, name, notes FROM clients WHERE id = ANY($1) ORDER BY name', [me.clientIds]);
    });

    const clientBody = z.object({ name: z.string().trim().min(1), notes: z.string().default('') });

    app.post('/clients', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const body = clientBody.parse(request.body);
      const row = await one<{ id: string }>(db, 'INSERT INTO clients (name, notes) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [
        body.name,
        body.notes,
      ]);
      if (!row) throw new HttpError(409, 'Já existe um cliente com esse nome');
      await audit(db, { userId: me.id, action: 'create', entityType: 'client', entityId: row.id, entityName: body.name, after: body, ip: request.ip });
      return { id: row.id, ...body };
    });

    app.put('/clients/:id', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const { id } = idParam.parse(request.params);
      const body = clientBody.parse(request.body);
      const before = await one(db, 'SELECT name, notes FROM clients WHERE id = $1', [id]);
      if (!before) throw notFound('Cliente');
      await db.query('UPDATE clients SET name = $2, notes = $3 WHERE id = $1', [id, body.name, body.notes]);
      await audit(db, { userId: me.id, action: 'update', entityType: 'client', entityId: id, entityName: body.name, before, after: body, ip: request.ip });
      return { id, ...body };
    });

    app.delete('/clients/:id', async (request) => {
      const me = currentUser(request);
      requireCap(me, 'admin');
      const { id } = idParam.parse(request.params);
      const used = await one(db, 'SELECT 1 FROM connections WHERE client_id = $1 LIMIT 1', [id]);
      if (used) throw new HttpError(409, 'O cliente tem conexões; exclua ou mova as conexões antes');
      const row = await one<{ name: string }>(db, 'DELETE FROM clients WHERE id = $1 RETURNING name', [id]);
      if (!row) throw notFound('Cliente');
      await audit(db, { userId: me.id, action: 'delete', entityType: 'client', entityId: id, entityName: row.name, ip: request.ip });
      return { ok: true };
    });

    // ---------- Auditoria ----------
    app.get('/audit', async (request) => {
      requireCap(currentUser(request), 'admin');
      const q = z
        .object({
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          userId: z.string().uuid().optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          before: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      return many(
        db,
        `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, a.entity_name, a.before, a.after, a.ip,
                u.name AS user_name, u.email AS user_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE ($1::text IS NULL OR a.entity_type = $1)
           AND ($2::text IS NULL OR a.entity_id = $2)
           AND ($3::uuid IS NULL OR a.user_id = $3)
           AND ($4::timestamptz IS NULL OR a.at >= $4)
           AND ($5::timestamptz IS NULL OR a.at <= $5)
           AND ($6::bigint IS NULL OR a.id < $6)
         ORDER BY a.id DESC LIMIT $7`,
        [q.entityType ?? null, q.entityId ?? null, q.userId ?? null, q.from ?? null, q.to ?? null, q.before ?? null, q.limit],
      );
    });
  };

async function setAccess(tx: import('pg').PoolClient, userId: string, folderIds: string[], clientIds: string[]): Promise<void> {
  await tx.query('DELETE FROM user_folders WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM user_clients WHERE user_id = $1', [userId]);
  if (folderIds.length) {
    await tx.query('INSERT INTO user_folders (user_id, folder_id) SELECT $1, unnest($2::uuid[])', [userId, folderIds]);
  }
  if (clientIds.length) {
    await tx.query('INSERT INTO user_clients (user_id, client_id) SELECT $1, unnest($2::uuid[])', [userId, clientIds]);
  }
}
