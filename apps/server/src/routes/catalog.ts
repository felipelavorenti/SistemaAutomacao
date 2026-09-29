import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { endpointVariables, type JsonObject } from '@sa/engine';
import { currentUser, type AppDeps } from '../app.js';
import { many, one } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { DEFAULT_CLIENT_FIELDS, mergeValues, publicValues, type ClientField } from '../lib/catalog.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { canSeeClient, forbidden, HttpError, notFound, requireCap } from '../lib/permissions.js';

const idParam = z.object({ id: z.string().uuid() });
const identifier = z.string().trim().regex(/^[A-Za-z_]\w*$/, 'Use só letras, números e _ no nome');
const pair = z.object({ name: z.string().trim(), value: z.string() });

const erpBody = z.object({
  name: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  authType: z.enum(['none', 'bearer', 'basic', 'header']),
  authHeader: z.string().trim().nullable().default(null),
  clientFields: z.array(z.object({ name: identifier, label: z.string().trim().min(1), secret: z.boolean() })).default(DEFAULT_CLIENT_FIELDS),
  notes: z.string().default(''),
});

const endpointBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().trim().min(1),
  headers: z.array(pair).default([]),
  query: z.array(pair).default([]),
  bodyType: z.enum(['none', 'json', 'form', 'text']).default('none'),
  body: z.string().default(''),
  variables: z
    .array(
      z.object({
        name: identifier,
        label: z.string().trim().default(''),
        type: z.enum(['text', 'number', 'boolean', 'json']).default('text'),
        required: z.boolean().default(true),
        default: z.string().default(''),
      }),
    )
    .default([]),
  usesAuth: z.boolean().default(true),
});

const erpClientBody = z.object({
  clientId: z.string().uuid(),
  label: z.string().trim().default(''),
  values: z.record(z.unknown()).default({}),
});

interface ErpRow {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  auth_header: string | null;
  client_fields: ClientField[];
  notes: string;
  updated_at: Date;
}

export const catalogRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const loadErp = async (id: string) => {
      const row = await one<ErpRow>(db, 'SELECT id, name, base_url, auth_type, auth_header, client_fields, notes, updated_at FROM erps WHERE id = $1', [id]);
      if (!row) throw notFound('ERP');
      return row;
    };
    const erpJson = (r: ErpRow) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      authType: r.auth_type,
      authHeader: r.auth_header,
      clientFields: r.client_fields,
      notes: r.notes,
      updatedAt: r.updated_at,
    });
    /** Fluxos que usam um ID (endpoint, cliente no ERP), para avisar antes de excluir. */
    const usedBy = (id: string) => many<{ name: string }>(db, `SELECT name FROM workflows WHERE definition::text LIKE '%' || $1 || '%' ORDER BY name`, [id]);

    // ---------- ERPs ----------
    app.get('/erps', async (request) => {
      requireCap(currentUser(request), 'workflow:view');
      const rows = await many<ErpRow & { endpoints: number; clients: number }>(
        db,
        `SELECT e.*, (SELECT count(*)::int FROM erp_endpoints WHERE erp_id = e.id) AS endpoints,
                (SELECT count(*)::int FROM erp_clients WHERE erp_id = e.id) AS clients
         FROM erps e ORDER BY e.name`,
      );
      return rows.map((r) => ({ ...erpJson(r), endpoints: r.endpoints, clients: r.clients }));
    });

    app.get('/erps/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:view');
      const { id } = idParam.parse(request.params);
      const erp = await loadErp(id);
      const endpoints = await many(
        db,
        `SELECT id, name, description, method, path, headers, query, body_type AS "bodyType", body, variables, uses_auth AS "usesAuth", updated_at AS "updatedAt"
         FROM erp_endpoints WHERE erp_id = $1 ORDER BY name`,
        [id],
      );
      const clients = await many<{ id: string; client_id: string; client_name: string; label: string; values_encrypted: Buffer; updated_at: Date }>(
        db,
        `SELECT ec.id, ec.client_id, c.name AS client_name, ec.label, ec.values_encrypted, ec.updated_at
         FROM erp_clients ec JOIN clients c ON c.id = ec.client_id WHERE ec.erp_id = $1 ORDER BY c.name, ec.label`,
        [id],
      );
      return {
        ...erpJson(erp),
        endpoints,
        clients: clients
          .filter((c) => canSeeClient(user, c.client_id))
          .map((c) => ({
            id: c.id,
            clientId: c.client_id,
            clientName: c.client_name,
            label: c.label,
            values: publicValues(erp.client_fields, decryptJson<JsonObject>(config.encryptionKey, c.values_encrypted)),
            updatedAt: c.updated_at,
          })),
      };
    });

    app.post('/erps', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const b = erpBody.parse(request.body);
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO erps (name, base_url, auth_type, auth_header, client_fields, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (name) DO NOTHING RETURNING id`,
        [b.name, b.baseUrl, b.authType, b.authHeader, JSON.stringify(b.clientFields), b.notes, user.id],
      );
      if (!row) throw new HttpError(409, 'Já existe um ERP com esse nome');
      await audit(db, { userId: user.id, action: 'create', entityType: 'erp', entityId: row.id, entityName: b.name, after: b, ip: request.ip });
      return erpJson(await loadErp(row.id));
    });

    app.put('/erps/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const b = erpBody.parse(request.body);
      const before = await loadErp(id);
      await db.query(
        `UPDATE erps SET name = $2, base_url = $3, auth_type = $4, auth_header = $5, client_fields = $6, notes = $7, updated_by = $8, updated_at = now() WHERE id = $1`,
        [id, b.name, b.baseUrl, b.authType, b.authHeader, JSON.stringify(b.clientFields), b.notes, user.id],
      );
      await audit(db, { userId: user.id, action: 'update', entityType: 'erp', entityId: id, entityName: b.name, before: erpJson(before), after: b, ip: request.ip });
      return erpJson(await loadErp(id));
    });

    app.delete('/erps/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const erp = await loadErp(id);
      if (await one(db, 'SELECT 1 FROM erp_clients WHERE erp_id = $1 LIMIT 1', [id])) {
        throw new HttpError(409, 'O ERP tem clientes cadastrados; remova os clientes antes');
      }
      await db.query('DELETE FROM erps WHERE id = $1', [id]);
      await audit(db, { userId: user.id, action: 'delete', entityType: 'erp', entityId: id, entityName: erp.name, before: erpJson(erp), ip: request.ip });
      return { ok: true };
    });

    // ---------- Endpoints ----------
    app.post('/erps/:id/endpoints', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const erp = await loadErp(id);
      const b = endpointBody.parse(request.body);
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO erp_endpoints (erp_id, name, description, method, path, headers, query, body_type, body, variables, uses_auth, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (erp_id, name) DO NOTHING RETURNING id`,
        [id, b.name, b.description, b.method, b.path, JSON.stringify(b.headers), JSON.stringify(b.query), b.bodyType, b.body, JSON.stringify(b.variables), b.usesAuth, user.id],
      );
      if (!row) throw new HttpError(409, `O ${erp.name} já tem um endpoint com esse nome`);
      await audit(db, { userId: user.id, action: 'create', entityType: 'erp_endpoint', entityId: row.id, entityName: `${erp.name} · ${b.name}`, after: b, ip: request.ip });
      return { id: row.id };
    });

    app.put('/erp-endpoints/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const b = endpointBody.parse(request.body);
      const before = await one<{ erp_name: string }>(
        db,
        `SELECT ep.*, e.name AS erp_name FROM erp_endpoints ep JOIN erps e ON e.id = ep.erp_id WHERE ep.id = $1`,
        [id],
      );
      if (!before) throw notFound('Endpoint');
      await db.query(
        `UPDATE erp_endpoints SET name = $2, description = $3, method = $4, path = $5, headers = $6, query = $7, body_type = $8, body = $9,
           variables = $10, uses_auth = $11, updated_by = $12, updated_at = now() WHERE id = $1`,
        [id, b.name, b.description, b.method, b.path, JSON.stringify(b.headers), JSON.stringify(b.query), b.bodyType, b.body, JSON.stringify(b.variables), b.usesAuth, user.id],
      );
      await audit(db, { userId: user.id, action: 'update', entityType: 'erp_endpoint', entityId: id, entityName: `${before.erp_name} · ${b.name}`, before, after: b, ip: request.ip });
      return { ok: true };
    });

    app.delete('/erp-endpoints/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const used = await usedBy(id);
      if (used.length) throw new HttpError(409, `O endpoint é usado pelos fluxos: ${used.map((w) => w.name).join(', ')}`);
      const row = await one<{ name: string }>(db, 'DELETE FROM erp_endpoints WHERE id = $1 RETURNING name', [id]);
      if (!row) throw notFound('Endpoint');
      await audit(db, { userId: user.id, action: 'delete', entityType: 'erp_endpoint', entityId: id, entityName: row.name, ip: request.ip });
      return { ok: true };
    });

    // ---------- Cliente no ERP ----------
    const loadErpClient = async (id: string) => {
      const row = await one<{ id: string; erp_id: string; client_id: string; label: string; values_encrypted: Buffer; client_fields: ClientField[]; erp_name: string }>(
        db,
        `SELECT ec.id, ec.erp_id, ec.client_id, ec.label, ec.values_encrypted, e.client_fields, e.name AS erp_name
         FROM erp_clients ec JOIN erps e ON e.id = ec.erp_id WHERE ec.id = $1`,
        [id],
      );
      return row;
    };

    app.post('/erps/:id/clients', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const erp = await loadErp(id);
      const b = erpClientBody.parse(request.body);
      if (!canSeeClient(user, b.clientId)) throw forbidden('Você não tem acesso a esse cliente');
      const values = mergeValues(erp.client_fields, b.values);
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO erp_clients (erp_id, client_id, label, values_encrypted, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (erp_id, client_id, label) DO NOTHING RETURNING id`,
        [id, b.clientId, b.label, encryptJson(config.encryptionKey, values), user.id],
      );
      if (!row) throw new HttpError(409, 'Esse cliente já está cadastrado neste ERP com esse nome; use um nome diferente (ex.: Homologação)');
      await audit(db, {
        userId: user.id,
        action: 'create',
        entityType: 'erp_client',
        entityId: row.id,
        entityName: erp.name,
        after: { clientId: b.clientId, label: b.label, values: publicValues(erp.client_fields, values) },
        ip: request.ip,
      });
      return { id: row.id };
    });

    app.put('/erp-clients/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const existing = await loadErpClient(id);
      if (!existing || !canSeeClient(user, existing.client_id)) throw notFound('Cliente no ERP');
      const b = erpClientBody.parse(request.body);
      if (!canSeeClient(user, b.clientId)) throw forbidden('Você não tem acesso a esse cliente');
      const old = decryptJson<JsonObject>(config.encryptionKey, existing.values_encrypted);
      const values = mergeValues(existing.client_fields, b.values, old);
      await db.query(`UPDATE erp_clients SET client_id = $2, label = $3, values_encrypted = $4, updated_by = $5, updated_at = now() WHERE id = $1`, [
        id,
        b.clientId,
        b.label,
        encryptJson(config.encryptionKey, values),
        user.id,
      ]);
      const secretsChanged = existing.client_fields.filter((f) => f.secret && values[f.name] !== old[f.name]).map((f) => f.label);
      await audit(db, {
        userId: user.id,
        action: 'update',
        entityType: 'erp_client',
        entityId: id,
        entityName: existing.erp_name,
        before: { clientId: existing.client_id, label: existing.label, values: publicValues(existing.client_fields, old) },
        after: { clientId: b.clientId, label: b.label, values: publicValues(existing.client_fields, values), secretsChanged },
        ip: request.ip,
      });
      return { ok: true };
    });

    app.delete('/erp-clients/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = idParam.parse(request.params);
      const existing = await loadErpClient(id);
      if (!existing || !canSeeClient(user, existing.client_id)) throw notFound('Cliente no ERP');
      const used = await usedBy(id);
      if (used.length) throw new HttpError(409, `O cadastro é usado pelos fluxos: ${used.map((w) => w.name).join(', ')}`);
      await db.query('DELETE FROM erp_clients WHERE id = $1', [id]);
      await audit(db, { userId: user.id, action: 'delete', entityType: 'erp_client', entityId: id, entityName: existing.erp_name, ip: request.ip });
      return { ok: true };
    });

    // ---------- Para o nó HTTP Request ----------
    /** Clientes no ERP que o usuário pode usar, com os endpoints de cada ERP e as variáveis que pedem. */
    app.get('/api-catalog', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:view');
      const clients = await many<{ id: string; erp_id: string; erp_name: string; client_id: string; client_name: string; label: string }>(
        db,
        `SELECT ec.id, ec.erp_id, e.name AS erp_name, ec.client_id, c.name AS client_name, ec.label
         FROM erp_clients ec JOIN erps e ON e.id = ec.erp_id JOIN clients c ON c.id = ec.client_id ORDER BY e.name, c.name, ec.label`,
      );
      const endpoints = await many<{ id: string; erp_id: string; name: string; description: string; method: string; path: string; variables: never[]; uses_auth: boolean; auth_type: never }>(
        db,
        `SELECT ep.id, ep.erp_id, ep.name, ep.description, ep.method, ep.path, ep.variables, ep.uses_auth, e.auth_type
         FROM erp_endpoints ep JOIN erps e ON e.id = ep.erp_id ORDER BY ep.name`,
      );
      return {
        clients: clients
          .filter((c) => canSeeClient(user, c.client_id))
          .map((c) => ({ id: c.id, erpId: c.erp_id, erpName: c.erp_name, clientName: c.client_name, label: c.label })),
        endpoints: endpoints.map((e) => ({
          id: e.id,
          erpId: e.erp_id,
          name: e.name,
          description: e.description,
          method: e.method,
          path: e.path,
          variables: endpointVariables({ variables: e.variables, authType: e.auth_type, usesAuth: e.uses_auth }),
        })),
      };
    });

  };
