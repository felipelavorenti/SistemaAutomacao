import type { ApiEndpointData, ApiVariable, JsonObject } from '@sa/engine';
import { one, type Queryable } from '../db/db.js';
import { decryptJson } from './crypto.js';

export interface ClientField {
  name: string;
  label: string;
  secret: boolean;
}

/** Campos que todo ERP novo pede do cliente; dá para mudar no cadastro do ERP. */
export const DEFAULT_CLIENT_FIELDS: ClientField[] = [
  { name: 'host', label: 'Host', secret: false },
  { name: 'porta', label: 'Porta', secret: false },
  { name: 'usuario', label: 'Usuário', secret: false },
  { name: 'senha', label: 'Senha', secret: true },
];

/** Valores do cliente no ERP para mostrar na tela: secretos só dizem se estão preenchidos. */
export function publicValues(fields: ClientField[], values: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const f of fields) out[f.name] = f.secret ? (values[f.name] ? '••••••' : '') : (values[f.name] ?? '');
  return out;
}

/** Campo secreto em branco mantém o valor salvo. */
export function mergeValues(fields: ClientField[], incoming: Record<string, unknown>, existing: JsonObject = {}): JsonObject {
  const out: JsonObject = {};
  for (const f of fields) {
    const raw = incoming[f.name];
    const value = typeof raw === 'string' ? raw : '';
    out[f.name] = f.secret && value === '' ? (existing[f.name] ?? '') : value;
  }
  return out;
}

/** Monta o que o nó HTTP Request precisa para chamar um endpoint para um cliente. */
export async function loadApiEndpoint(db: Queryable, key: Buffer, erpClientId: string, endpointId: string): Promise<ApiEndpointData> {
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(erpClientId) || !uuid.test(endpointId)) throw new Error('Cliente no ERP ou endpoint inválido');
  const row = await one<{
    erp_id: string;
    erp_name: string;
    base_url: string;
    auth_type: ApiEndpointData['authType'];
    auth_header: string | null;
    client_name: string;
    label: string;
    values_encrypted: Buffer;
  }>(
    db,
    `SELECT e.id AS erp_id, e.name AS erp_name, e.base_url, e.auth_type, e.auth_header, c.name AS client_name, ec.label, ec.values_encrypted
     FROM erp_clients ec JOIN erps e ON e.id = ec.erp_id JOIN clients c ON c.id = ec.client_id WHERE ec.id = $1`,
    [erpClientId],
  );
  if (!row) throw new Error('O cadastro do cliente no ERP não existe mais');
  const endpoint = await one<{
    erp_id: string;
    name: string;
    method: string;
    path: string;
    headers: { name: string; value: string }[];
    query: { name: string; value: string }[];
    body_type: ApiEndpointData['bodyType'];
    body: string;
    variables: ApiVariable[];
    uses_auth: boolean;
  }>(db, 'SELECT erp_id, name, method, path, headers, query, body_type, body, variables, uses_auth FROM erp_endpoints WHERE id = $1', [endpointId]);
  if (!endpoint) throw new Error('O endpoint não existe mais no catálogo');
  if (endpoint.erp_id !== row.erp_id) throw new Error(`O endpoint "${endpoint.name}" não é do ERP ${row.erp_name}`);
  return {
    erpName: row.erp_name,
    endpointName: endpoint.name,
    clientName: row.label ? `${row.client_name} (${row.label})` : row.client_name,
    baseUrl: row.base_url,
    authType: row.auth_type,
    authHeader: row.auth_header,
    usesAuth: endpoint.uses_auth,
    method: endpoint.method,
    path: endpoint.path,
    headers: endpoint.headers,
    query: endpoint.query,
    bodyType: endpoint.body_type,
    body: endpoint.body,
    variables: endpoint.variables,
    clientValues: decryptJson<JsonObject>(key, row.values_encrypted),
  };
}
