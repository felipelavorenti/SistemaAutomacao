import type { Queryable } from '../db/db.js';

export interface AuditEntry {
  userId: string | null;
  action: string;
  entityType: 'user' | 'folder' | 'client' | 'connection' | 'workflow' | 'execution' | 'session' | 'api_token' | 'erp' | 'erp_endpoint' | 'erp_client';
  entityId?: string | null;
  entityName?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Registra quem fez o quê, com o antes e o depois. Nunca receba segredos aqui. */
export async function audit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, before, after, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.entityName ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
    ],
  );
}
