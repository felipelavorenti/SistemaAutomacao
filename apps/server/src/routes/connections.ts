import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { testConnection, type JsonObject } from '@sa/engine';
import { currentUser, type AppDeps } from '../app.js';
import { many, one } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { connectionTypes, getConnectionType, mergeData, missingFields, publicData } from '../lib/connection-types.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { canSeeClient, forbidden, HttpError, notFound, requireCap, type CurrentUser } from '../lib/permissions.js';

interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  client_id: string | null;
  client_name: string | null;
  data_encrypted: Buffer;
  updated_at: Date;
  updated_by_name: string | null;
}

const SELECT = `
  SELECT c.id, c.name, c.type, c.client_id, cl.name AS client_name, c.data_encrypted, c.updated_at, u.name AS updated_by_name
  FROM connections c
  LEFT JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN users u ON u.id = c.updated_by`;

const body = z.object({
  name: z.string().trim().min(1),
  type: z.string(),
  clientId: z.string().uuid().nullable().default(null),
  data: z.record(z.unknown()).default({}),
});

export const connectionRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const toPublic = (row: ConnectionRow) => {
      const type = getConnectionType(row.type);
      const data = decryptJson<JsonObject>(config.encryptionKey, row.data_encrypted);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        typeName: type?.displayName ?? row.type,
        clientId: row.client_id,
        clientName: row.client_name,
        data: type ? publicData(type, data) : {},
        updatedAt: row.updated_at,
        updatedByName: row.updated_by_name,
      };
    };

    const load = async (user: CurrentUser, id: string) => {
      const row = await one<ConnectionRow>(db, `${SELECT} WHERE c.id = $1`, [id]);
      if (!row || !canSeeClient(user, row.client_id)) throw notFound('Conexão');
      return row;
    };

    const checkClient = (user: CurrentUser, clientId: string | null) => {
      if (!canSeeClient(user, clientId)) throw forbidden('Você não tem acesso a esse cliente');
    };

    app.get('/connection-types', async () => connectionTypes);

    /** Testa os dados do formulário; ao editar, as senhas em branco usam as já salvas. */
    app.post('/connections/test', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const b = z.object({ id: z.string().uuid().optional(), type: z.string(), data: z.record(z.unknown()).default({}) }).parse(request.body);
      const type = getConnectionType(b.type);
      if (!type?.testable) throw new HttpError(400, 'Este tipo de conexão é testado no próprio nó');
      const existing = b.id ? await load(user, b.id) : null;
      const data = mergeData(type, b.data, existing ? decryptJson<JsonObject>(config.encryptionKey, existing.data_encrypted) : {});
      const missing = missingFields(type, data);
      if (missing.length) throw new HttpError(400, `Preencha: ${missing.join(', ')}`);
      const started = Date.now();
      try {
        await Promise.race([
          testConnection({ id: b.id ?? 'teste', type: b.type, data }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Não respondeu em 20 s')), 20_000)),
        ]);
        return { ok: true, durationMs: Date.now() - started };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    });

    app.get('/connections', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:view');
      const rows = await many<ConnectionRow>(db, `${SELECT} ORDER BY cl.name NULLS FIRST, c.name`);
      return rows.filter((r) => canSeeClient(user, r.client_id)).map(toPublic);
    });

    app.get('/connections/:id', async (request) => {
      const user = currentUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return toPublic(await load(user, id));
    });

    app.get('/connections/:id/usage', async (request) => {
      const user = currentUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await load(user, id);
      return many(db, `SELECT id, name, active FROM workflows WHERE definition::text LIKE '%' || $1 || '%' ORDER BY name`, [id]);
    });

    app.post('/connections', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const b = body.parse(request.body);
      checkClient(user, b.clientId);
      const type = getConnectionType(b.type);
      if (!type) throw new HttpError(400, `Tipo de conexão desconhecido: ${b.type}`);
      const data = mergeData(type, b.data);
      const missing = missingFields(type, data);
      if (missing.length) throw new HttpError(400, `Preencha: ${missing.join(', ')}`);

      const row = await one<{ id: string }>(
        db,
        `INSERT INTO connections (name, type, client_id, data_encrypted, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [b.name, b.type, b.clientId, encryptJson(config.encryptionKey, data), user.id],
      );
      const after = { name: b.name, type: b.type, clientId: b.clientId, data: publicData(type, data) };
      await audit(db, { userId: user.id, action: 'create', entityType: 'connection', entityId: row!.id, entityName: b.name, after, ip: request.ip });
      return toPublic(await load(user, row!.id));
    });

    app.put('/connections/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = body.parse(request.body);
      const existing = await load(user, id);
      checkClient(user, b.clientId);
      if (b.type !== existing.type) throw new HttpError(400, 'Não é possível trocar o tipo de uma conexão; crie outra');
      const type = getConnectionType(b.type)!;
      const oldData = decryptJson<JsonObject>(config.encryptionKey, existing.data_encrypted);
      const data = mergeData(type, b.data, oldData);
      const missing = missingFields(type, data);
      if (missing.length) throw new HttpError(400, `Preencha: ${missing.join(', ')}`);

      await db.query(`UPDATE connections SET name = $2, client_id = $3, data_encrypted = $4, updated_by = $5, updated_at = now() WHERE id = $1`, [
        id,
        b.name,
        b.clientId,
        encryptJson(config.encryptionKey, data),
        user.id,
      ]);
      const changedSecrets = type.fields.filter((f) => f.secret && data[f.name] !== oldData[f.name]).map((f) => f.displayName);
      await audit(db, {
        userId: user.id,
        action: 'update',
        entityType: 'connection',
        entityId: id,
        entityName: b.name,
        before: { name: existing.name, clientId: existing.client_id, data: publicData(type, oldData) },
        after: { name: b.name, clientId: b.clientId, data: publicData(type, data), secretsChanged: changedSecrets },
        ip: request.ip,
      });
      return toPublic(await load(user, id));
    });

    app.delete('/connections/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const existing = await load(user, id);
      const used = await many<{ name: string }>(db, `SELECT name FROM workflows WHERE definition::text LIKE '%' || $1 || '%'`, [id]);
      if (used.length) {
        throw new HttpError(409, `A conexão é usada pelos fluxos: ${used.map((w) => w.name).join(', ')}`);
      }
      await db.query('DELETE FROM connections WHERE id = $1', [id]);
      await audit(db, { userId: user.id, action: 'delete', entityType: 'connection', entityId: id, entityName: existing.name, ip: request.ip });
      return { ok: true };
    });
  };
