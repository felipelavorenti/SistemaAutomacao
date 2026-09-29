import type { JsonObject } from '@sa/engine';

export interface ConnectionField {
  name: string;
  displayName: string;
  /** Campos secretos são criptografados e nunca voltam para a tela. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  /** Valor sugerido ao criar a conexão. */
  default?: string;
  /** Quando preenchido, o campo vira uma lista de escolha. */
  options?: { name: string; value: string }[];
  hint?: string;
}

export interface ConnectionTypeDescription {
  type: string;
  displayName: string;
  /** Tipos que têm o botão "Testar conexão". */
  testable?: boolean;
  fields: ConnectionField[];
}

const yesNo = [
  { name: 'Sim', value: 'true' },
  { name: 'Não', value: 'false' },
];
const timeoutField: ConnectionField = {
  name: 'queryTimeoutSeconds',
  displayName: 'Tempo limite por comando (s)',
  secret: false,
  required: false,
  default: '300',
};

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
  {
    type: 'postgres',
    displayName: 'Postgres',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: '10.0.0.5' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '5432' },
      { name: 'database', displayName: 'Banco', secret: false, required: true },
      { name: 'user', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha', secret: true, required: false },
      {
        name: 'ssl',
        displayName: 'SSL',
        secret: false,
        required: false,
        default: 'disable',
        options: [
          { name: 'Sem SSL', value: 'disable' },
          { name: 'Exigir SSL', value: 'require' },
          { name: 'SSL sem validar o certificado', value: 'no-verify' },
        ],
      },
      timeoutField,
    ],
  },
  {
    type: 'mssql',
    displayName: 'SQL Server',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: '10.0.0.5' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '1433' },
      { name: 'instance', displayName: 'Instância (opcional)', secret: false, required: false, hint: 'Com instância nomeada, a porta é ignorada.' },
      { name: 'database', displayName: 'Banco', secret: false, required: true },
      { name: 'user', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha', secret: true, required: true },
      { name: 'encrypt', displayName: 'Criptografar a conexão', secret: false, required: false, default: 'false', options: yesNo },
      { name: 'trustServerCertificate', displayName: 'Aceitar certificado do servidor', secret: false, required: false, default: 'true', options: yesNo },
      timeoutField,
    ],
  },
  {
    type: 'oracle',
    displayName: 'Oracle',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: false, placeholder: '10.0.0.5' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '1521' },
      { name: 'serviceName', displayName: 'Service name', secret: false, required: false, placeholder: 'ORCL' },
      {
        name: 'connectString',
        displayName: 'Connect string (opcional)',
        secret: false,
        required: false,
        placeholder: '(DESCRIPTION=...)',
        hint: 'Se preenchida, substitui servidor, porta e service name.',
      },
      { name: 'user', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha', secret: true, required: true },
      timeoutField,
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
  const missing = type.fields.filter((f) => f.required && !data[f.name]).map((f) => f.displayName);
  if (type.type === 'oracle' && !data.connectString && !(data.host && data.serviceName)) missing.push('Servidor e service name, ou a connect string');
  return missing;
}
