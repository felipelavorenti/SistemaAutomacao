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
  /** Texto de várias linhas (ex.: chave privada). */
  multiline?: boolean;
}

export interface ConnectionTypeDescription {
  type: string;
  displayName: string;
  /** Tipos que têm o botão "Testar conexão". */
  testable?: boolean;
  /** Tipos que entram na conta com o botão "Conectar com Google". */
  oauth?: 'google';
  fields: ConnectionField[];
}

/** Dados que o login com Google grava na conexão; não aparecem no formulário. */
export const OAUTH_REFRESH_TOKEN = 'oauthRefreshToken';
export const OAUTH_ACCOUNT = 'oauthAccount';

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
  {
    type: 'metabase',
    displayName: 'Metabase',
    testable: true,
    fields: [
      { name: 'url', displayName: 'URL do Metabase', secret: false, required: true, placeholder: 'https://metabase.empresa.com.br' },
      {
        name: 'apiKey',
        displayName: 'API key',
        secret: true,
        required: false,
        hint: 'Com a API key, usuário e senha não são usados. Sem ela, o nó faz login com usuário e senha.',
      },
      { name: 'username', displayName: 'Usuário (e-mail)', secret: false, required: false },
      { name: 'password', displayName: 'Senha', secret: true, required: false },
    ],
  },
  {
    type: 'clickup',
    displayName: 'ClickUp',
    testable: true,
    fields: [
      {
        name: 'token',
        displayName: 'Token pessoal da API',
        secret: true,
        required: true,
        placeholder: 'pk_...',
        hint: 'No ClickUp: Configurações > Apps > API Token.',
      },
    ],
  },
  {
    type: 'gmailOAuth2',
    displayName: 'Gmail (login com Google)',
    testable: true,
    oauth: 'google',
    fields: [
      {
        name: 'clientId',
        displayName: 'Client ID',
        secret: false,
        required: true,
        placeholder: '1234-abc.apps.googleusercontent.com',
        hint: 'Do app OAuth criado no Google Cloud (APIs e serviços > Credenciais).',
      },
      { name: 'clientSecret', displayName: 'Client secret', secret: true, required: true },
    ],
  },
  {
    type: 'imap',
    displayName: 'IMAP (caixa de e-mail)',
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: 'imap.gmail.com' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '993', hint: '993 com SSL/TLS; 143 sem.' },
      { name: 'user', displayName: 'Usuário', secret: false, required: true, placeholder: 'contato@empresa.com.br' },
      {
        name: 'password',
        displayName: 'Senha',
        secret: true,
        required: true,
        hint: 'No Gmail e no Outlook com verificação em duas etapas, use uma senha de app.',
      },
      { name: 'secure', displayName: 'SSL/TLS', secret: false, required: false, default: 'true', options: yesNo },
      { name: 'allowUnauthorizedCerts', displayName: 'Aceitar certificado inválido', secret: false, required: false, default: 'false', options: yesNo },
    ],
  },
  {
    type: 'smtp',
    displayName: 'SMTP (envio de e-mail)',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: 'smtp.office365.com' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '465', hint: '465 com SSL/TLS; 587 ou 25 sem (usa STARTTLS quando o servidor oferece).' },
      { name: 'secure', displayName: 'SSL/TLS', secret: false, required: false, default: 'true', options: yesNo, hint: 'Sim para a porta 465; Não para 587 e 25.' },
      { name: 'disableStartTls', displayName: 'Desligar STARTTLS', secret: false, required: false, default: 'false', options: yesNo },
      { name: 'user', displayName: 'Usuário', secret: false, required: false, placeholder: 'automacao@empresa.com.br', hint: 'Vazio: envia sem login (relay interno).' },
      { name: 'password', displayName: 'Senha', secret: true, required: false, hint: 'No Gmail e no Outlook com verificação em duas etapas, use uma senha de app.' },
      { name: 'hostName', displayName: 'Nome deste servidor (EHLO)', secret: false, required: false, hint: 'Opcional. Alguns servidores exigem um nome conhecido.' },
    ],
  },
  {
    type: 'ftp',
    displayName: 'FTP',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: 'ftp.empresa.com.br' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '21' },
      { name: 'user', displayName: 'Usuário', secret: false, required: false, hint: 'Vazio: entra como anonymous.' },
      { name: 'password', displayName: 'Senha', secret: true, required: false },
      { name: 'secure', displayName: 'FTPS (TLS explícito)', secret: false, required: false, default: 'false', options: yesNo },
      { name: 'allowUnauthorizedCerts', displayName: 'Aceitar certificado inválido', secret: false, required: false, default: 'false', options: yesNo },
    ],
  },
  {
    type: 'sftp',
    displayName: 'SFTP',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: 'sftp.empresa.com.br' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '22' },
      { name: 'user', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha', secret: true, required: false, hint: 'Senha, chave privada ou as duas.' },
      { name: 'privateKey', displayName: 'Chave privada (PEM ou OpenSSH)', secret: true, required: false, multiline: true, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' },
      { name: 'passphrase', displayName: 'Senha da chave', secret: true, required: false },
    ],
  },
  {
    type: 'ssh',
    displayName: 'SSH',
    testable: true,
    fields: [
      { name: 'host', displayName: 'Servidor', secret: false, required: true, placeholder: '10.0.0.5' },
      { name: 'port', displayName: 'Porta', secret: false, required: false, default: '22' },
      { name: 'user', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha', secret: true, required: false, hint: 'Senha, chave privada ou as duas.' },
      { name: 'privateKey', displayName: 'Chave privada (PEM ou OpenSSH)', secret: true, required: false, multiline: true, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' },
      { name: 'passphrase', displayName: 'Senha da chave', secret: true, required: false },
    ],
  },
  {
    type: 'gitPassword',
    displayName: 'Git (usuário e senha ou token)',
    fields: [
      { name: 'username', displayName: 'Usuário', secret: false, required: true },
      { name: 'password', displayName: 'Senha ou token', secret: true, required: true, hint: 'No GitHub e no GitLab, use um token de acesso pessoal.' },
    ],
  },
  {
    type: 'info8nApi',
    displayName: 'API do Info8n',
    fields: [
      {
        name: 'apiKey',
        displayName: 'Token da API',
        secret: true,
        required: true,
        hint: 'Crie em Minha conta > Tokens de API. O nó faz só o que o dono do token pode fazer.',
      },
      { name: 'baseUrl', displayName: 'Endereço do Info8n (opcional)', secret: false, required: false, placeholder: 'http://info8n:3000', hint: 'Vazio: este Info8n (PUBLIC_URL).' },
    ],
  },
  {
    type: 'totp',
    displayName: 'TOTP (código de dois fatores)',
    fields: [
      {
        name: 'secret',
        displayName: 'Chave secreta',
        secret: true,
        required: true,
        placeholder: 'BVDRSBXQB2ZEL5HE',
        hint: 'A chave em base32 mostrada pelo site ao ativar a autenticação em dois fatores (a que acompanha o QR code).',
      },
      { name: 'label', displayName: 'Identificação', secret: false, required: false, placeholder: 'GitHub:usuario@empresa.com' },
    ],
  },
  {
    type: 'cryptoPrivateKey',
    displayName: 'Chave privada (assinatura)',
    fields: [
      {
        name: 'privateKey',
        displayName: 'Chave privada (PEM)',
        secret: true,
        required: true,
        multiline: true,
        placeholder: '-----BEGIN PRIVATE KEY-----',
        hint: 'Usada pelo nó Crypto na operação Assinar.',
      },
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
  if (type.oauth) out[OAUTH_ACCOUNT] = data[OAUTH_REFRESH_TOKEN] ? (data[OAUTH_ACCOUNT] ?? '') : '';
  return out;
}

/** Valor de um campo como texto; número e sim/não vindos pela API viram texto, o resto fica vazio. */
export function fieldText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

/**
 * Junta os dados enviados pela tela com os já salvos. Um campo secreto vazio
 * mantém o valor anterior, para o usuário não precisar redigitar senhas.
 */
export function mergeData(type: ConnectionTypeDescription, incoming: Record<string, unknown>, existing: JsonObject = {}): JsonObject {
  const out: JsonObject = {};
  for (const field of type.fields) {
    const raw = incoming[field.name];
    const value = fieldText(raw);
    out[field.name] = field.secret && value === '' ? (existing[field.name] ?? '') : value;
  }
  // O acesso dado pelo Google vale para o app (client ID) que pediu; trocar o app exige conectar de novo.
  if (type.oauth && existing[OAUTH_REFRESH_TOKEN] && out.clientId === existing.clientId) {
    out[OAUTH_REFRESH_TOKEN] = existing[OAUTH_REFRESH_TOKEN];
    out[OAUTH_ACCOUNT] = existing[OAUTH_ACCOUNT] ?? '';
  }
  return out;
}

export function missingFields(type: ConnectionTypeDescription, data: JsonObject): string[] {
  const missing = type.fields.filter((f) => f.required && !data[f.name]).map((f) => f.displayName);
  if (type.type === 'oracle' && !data.connectString && !(data.host && data.serviceName)) missing.push('Servidor e service name, ou a connect string');
  if (type.type === 'metabase' && !data.apiKey && !(data.username && data.password)) missing.push('API key, ou usuário e senha');
  if ((type.type === 'ssh' || type.type === 'sftp') && !data.password && !data.privateKey) missing.push('Senha ou chave privada');
  return missing;
}
