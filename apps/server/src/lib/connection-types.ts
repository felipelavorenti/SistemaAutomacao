import type { JsonObject } from '@sa/engine';

export interface ConnectionField {
  name: string;
  displayName: string;
  /** Campos secretos são criptografados e nunca voltam para a tela. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

export interface ConnectionTypeDescription {
  type: string;
  displayName: string;
  fields: ConnectionField[];
}

export const connectionTypes: ConnectionTypeDescription[] = [
  {
    type: 'httpHeaderAuth',
    displayName: 'API key no header',
    fields: [
      { name: 'name', displayName: 'Nome do header', secret: false, required: true, placeholder: 'X-API-Key' },
      { name: 'value', displayName: 'Valor', secret: true, required: true },
    ],
  },
  {
    type: 'httpBearerAuth',
    displayName: 'Bearer token',
    fields: [{ name: 'token', displayName: 'Token', secret: true, required: true }],
  },
  {
    type: 'httpBasicAuth',
    displayName: 'Usuário e senha (Basic)',
    fields: [
      { name: 'user', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha', secret: true, required: true },
    ],
  },
];

export function getConnectionType(type: string): ConnectionTypeDescription | undefined {
  return connectionTypes.find((t) => t.type === type);
}

/** Versão segura dos dados para mostrar na tela: secretos só dizem se estão preenchidos. */
export function publicData(type: ConnectionTypeDescription, data: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const field of type.fields) {
    const value = data[field.name];
    out[field.name] = field.secret ? (value ? '••••••' : '') : (value ?? '');
  }
  return out;
}

/**
 * Junta os dados enviados pela tela com os já salvos. Um campo secreto vazio
 * mantém o valor anterior, para o usuário não precisar redigitar senhas.
 */
export function mergeData(type: ConnectionTypeDescription, incoming: Record<string, unknown>, existing: JsonObject = {}): JsonObject {
  const out: JsonObject = {};
  for (const field of type.fields) {
    const raw = incoming[field.name];
    const value = typeof raw === 'string' ? raw : '';
    out[field.name] = field.secret && value === '' ? (existing[field.name] ?? '') : value;
  }
  return out;
}

export function missingFields(type: ConnectionTypeDescription, data: JsonObject): string[] {
  return type.fields.filter((f) => f.required && !data[f.name]).map((f) => f.displayName);
}
