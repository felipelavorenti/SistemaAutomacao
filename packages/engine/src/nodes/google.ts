import { createHash } from 'node:crypto';
import type { ConnectionData } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import { callApi } from './api.js';
import { isPlainObject } from './paths.js';

/**
 * Login com Google (OAuth 2.0) das conexões do Gmail.
 *
 * A conexão guarda o client ID e o secret do app criado no Google Cloud. Ao clicar em
 * "Conectar com Google", a pessoa autoriza o app e o servidor troca o código por um
 * refresh token, que fica criptografado na conexão. A cada execução o nó troca esse
 * refresh token por um access token, que vale uma hora.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Ler, enviar, criar rascunhos, marcar e mover para a lixeira. Não permite apagar de vez. */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

export const GMAIL_CONNECTION_TYPES = ['gmailOAuth2'];

/** Endereço do Google onde a pessoa autoriza o app. */
export function googleAuthUrl(options: { clientId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: (options.scopes ?? GMAIL_SCOPES).join(' '),
    access_type: 'offline',
    // Sem "consent" o Google só devolve o refresh token na primeira autorização.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: options.state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/** Troca o código da autorização pelo refresh token e descobre o e-mail da conta. */
export async function exchangeGoogleCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ refreshToken: string; account: string }> {
  const tokens = await callApi({
    service: 'Google',
    method: 'POST',
    url: GOOGLE_TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!isPlainObject(tokens) || typeof tokens.refresh_token !== 'string' || typeof tokens.access_token !== 'string') {
    throw new NodeOperationError('O Google não devolveu o refresh token; tente conectar de novo');
  }
  const profile = await callApi({
    service: 'Gmail',
    method: 'GET',
    url: `${GMAIL_API}/profile`,
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const account = isPlainObject(profile) && typeof profile.emailAddress === 'string' ? profile.emailAddress : '';
  return { refreshToken: tokens.refresh_token, account };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Access token da conexão, renovado pelo refresh token. Fica em memória até
 * 5 minutos antes de vencer, para as execuções seguidas não renovarem toda vez.
 */
export async function googleAccessToken(connection: ConnectionData, signal?: AbortSignal): Promise<string> {
  if (!GMAIL_CONNECTION_TYPES.includes(connection.type)) {
    throw new NodeOperationError(`A conexão é do tipo ${connection.type}, não do Gmail`);
  }
  const clientId = String(connection.data.clientId ?? '');
  const clientSecret = String(connection.data.clientSecret ?? '');
  const refreshToken = String(connection.data.oauthRefreshToken ?? '');
  if (!clientId || !clientSecret) throw new NodeOperationError('A conexão do Gmail está sem o client ID ou o client secret');
  if (!refreshToken) throw new NodeOperationError('A conexão do Gmail ainda não foi conectada: abra a conexão e clique em Conectar com Google');

  const key = createHash('sha256').update(`${connection.id}\n${clientId}\n${refreshToken}`).digest('hex');
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  let result;
  try {
    result = await callApi({
      service: 'Google',
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
      signal,
    });
  } catch (err) {
    const body = err instanceof NodeOperationError && isPlainObject(err.details) && isPlainObject(err.details.body) ? err.details.body : null;
    if (body?.error === 'invalid_grant') {
      throw new NodeOperationError(
        'O Google recusou o acesso salvo na conexão do Gmail (revogado, senha trocada ou app em modo de teste por mais de 7 dias). Abra a conexão e clique em Conectar com Google de novo',
        err instanceof NodeOperationError ? err.details : undefined,
      );
    }
    throw err;
  }
  if (!isPlainObject(result) || typeof result.access_token !== 'string') throw new NodeOperationError('O Google não devolveu o access token');
  const expiresIn = typeof result.expires_in === 'number' ? result.expires_in : 3600;
  tokenCache.set(key, { token: result.access_token, expiresAt: Date.now() + (expiresIn - 300) * 1000 });
  return result.access_token;
}

/** Testa a conexão buscando o perfil da conta. */
export async function testGmailConnection(connection: ConnectionData): Promise<void> {
  const token = await googleAccessToken(connection);
  await callApi({ service: 'Gmail', method: 'GET', url: `${GMAIL_API}/profile`, headers: { authorization: `Bearer ${token}` } });
}
