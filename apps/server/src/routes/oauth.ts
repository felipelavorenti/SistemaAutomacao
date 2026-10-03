import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exchangeGoogleCode, googleAuthUrl, type JsonObject } from '@sa/engine';
import { currentUser, type AppDeps } from '../app.js';
import { one } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { loadUser } from '../lib/auth.js';
import { getConnectionType, OAUTH_ACCOUNT, OAUTH_REFRESH_TOKEN } from '../lib/connection-types.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { canSeeClient, HttpError, notFound, requireCap, type CurrentUser } from '../lib/permissions.js';

/**
 * Login com Google das conexões do Gmail.
 *
 * 1. A tela chama POST /connections/{id}/oauth/google/start e abre o endereço do Google.
 * 2. Depois de autorizar, o Google manda o navegador para GET /oauth/google/callback com o
 *    código e o "state". O state é assinado com a ENCRYPTION_KEY e diz qual conexão e qual
 *    usuário pediram, por isso essa rota não precisa da sessão.
 * 3. Quando o Info8n é aberto por IP, o Google não aceita voltar para ele; o retorno vai para
 *    localhost e a pessoa cola o endereço da página em POST /connections/{id}/oauth/google/complete.
 */

export const OAUTH_CALLBACK_PATH = '/api/oauth/google/callback';
const STATE_TTL_MS = 15 * 60 * 1000;

interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  client_id: string | null;
  data_encrypted: Buffer;
}

interface OAuthState {
  /** Conexão. */
  c: string;
  /** Usuário que clicou em Conectar. */
  u: string;
  /** Endereço de retorno enviado ao Google; a troca do código precisa do mesmo. */
  r: string;
  /** Validade (ms desde 1970). */
  e: number;
}

/** Endereço de retorno que vai para o Google e precisa estar cadastrado no app do Google Cloud. */
export function googleRedirectUri(request: FastifyRequest, publicUrl?: string): string {
  if (publicUrl) return `${publicUrl}${OAUTH_CALLBACK_PATH}`;
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? 'localhost:3000').split(',')[0]!.trim();
  const url = new URL(`${request.protocol}://${host}`);
  // O Google só aceita retorno para localhost ou para um domínio; endereço por IP vira localhost.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) url.hostname = 'localhost';
  if (url.hostname === '127.0.0.1') url.hostname = 'localhost';
  return `${url.origin}${OAUTH_CALLBACK_PATH}`;
}

export const oauthRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const sign = (payload: string) => createHmac('sha256', config.encryptionKey).update(`oauth-state:${payload}`).digest('base64url');

    const makeState = (state: OAuthState) => {
      const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
      return `${payload}.${sign(payload)}`;
    };

    const readState = (raw: string): OAuthState => {
      const [payload = '', signature = ''] = raw.split('.');
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (!payload || expected.length !== given.length || !timingSafeEqual(expected, given)) {
        throw new HttpError(400, 'Retorno do Google inválido; clique em Conectar com Google de novo');
      }
      const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
      if (state.e < Date.now()) throw new HttpError(400, 'O pedido de conexão venceu; clique em Conectar com Google de novo');
      return state;
    };

    const loadConnection = async (user: CurrentUser, id: string) => {
      const row = await one<ConnectionRow>(db, 'SELECT id, name, type, client_id, data_encrypted FROM connections WHERE id = $1', [id]);
      if (!row || !canSeeClient(user, row.client_id)) throw notFound('Conexão');
      const type = getConnectionType(row.type);
      if (type?.oauth !== 'google') throw new HttpError(400, 'Esta conexão não usa login com Google');
      return { row, data: decryptJson<JsonObject>(config.encryptionKey, row.data_encrypted) };
    };

    /** Troca o código pelo refresh token e grava na conexão. */
    const complete = async (user: CurrentUser, params: { code?: string; state?: string; error?: string }, ip: string, connectionId?: string) => {
      if (params.error) {
        throw new HttpError(400, params.error === 'access_denied' ? 'A autorização foi cancelada no Google' : `O Google recusou a autorização: ${params.error}`);
      }
      if (!params.code || !params.state) throw new HttpError(400, 'O endereço não tem o código do Google (code e state)');
      const state = readState(params.state);
      if (state.u !== user.id) throw new HttpError(403, 'Este retorno do Google foi pedido por outro usuário');
      if (connectionId && state.c !== connectionId) throw new HttpError(400, 'Este retorno do Google é de outra conexão');
      const { row, data } = await loadConnection(user, state.c);
      let result;
      try {
        result = await exchangeGoogleCode({
          clientId: String(data.clientId ?? ''),
          clientSecret: String(data.clientSecret ?? ''),
          redirectUri: state.r,
          code: params.code,
        });
      } catch (err) {
        const details = err && typeof err === 'object' && 'details' in err ? (err as { details?: unknown }).details : undefined;
        const body = details && typeof details === 'object' && 'body' in details ? (details as { body?: unknown }).body : undefined;
        const reason = body && typeof body === 'object' && 'error_description' in body ? String((body as { error_description: unknown }).error_description) : '';
        throw new HttpError(400, `O Google não aceitou o código${reason ? `: ${reason}` : ''}`, body ?? undefined);
      }
      const next = { ...data, [OAUTH_REFRESH_TOKEN]: result.refreshToken, [OAUTH_ACCOUNT]: result.account };
      await db.query('UPDATE connections SET data_encrypted = $2, updated_by = $3, updated_at = now() WHERE id = $1', [
        row.id,
        encryptJson(config.encryptionKey, next),
        user.id,
      ]);
      await audit(db, {
        userId: user.id,
        action: 'connect',
        entityType: 'connection',
        entityId: row.id,
        entityName: row.name,
        before: { account: data[OAUTH_REFRESH_TOKEN] ? (data[OAUTH_ACCOUNT] ?? '') : null },
        after: { account: result.account },
        ip,
      });
      return { id: row.id, name: row.name, account: result.account };
    };

    app.get('/oauth/google/redirect-uri', async (request) => {
      currentUser(request);
      return { redirectUri: googleRedirectUri(request, config.publicUrl) };
    });

    app.post('/connections/:id/oauth/google/start', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { data } = await loadConnection(user, id);
      if (!data.clientId || !data.clientSecret) throw new HttpError(400, 'Preencha e salve o client ID e o client secret antes de conectar');
      const redirectUri = googleRedirectUri(request, config.publicUrl);
      const state = makeState({ c: id, u: user.id, r: redirectUri, e: Date.now() + STATE_TTL_MS });
      return { url: googleAuthUrl({ clientId: String(data.clientId), redirectUri, state }), redirectUri };
    });

    app.post('/connections/:id/oauth/google/complete', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'connection:edit');
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { url } = z.object({ url: z.string().trim().min(1) }).parse(request.body);
      let params: URLSearchParams;
      try {
        params = new URL(url).searchParams;
      } catch {
        throw new HttpError(400, 'Cole o endereço completo da página para onde o Google mandou (começa com http)');
      }
      return complete(user, { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined, error: params.get('error') ?? undefined }, request.ip, id);
    });

    // Rota pública: quem chega é o navegador vindo do Google; a identidade vem do state assinado.
    app.get('/oauth/google/callback', async (request, reply) => {
      const query = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(request.query);
      const back = (params: Record<string, string>) => reply.redirect(`/conexoes?${new URLSearchParams(params)}`);
      try {
        const state = query.state ? readState(query.state) : null;
        const owner = state ? await loadUser(db, state.u) : null;
        if (!owner) throw new HttpError(400, 'Retorno do Google inválido; clique em Conectar com Google de novo');
        requireCap(owner, 'connection:edit');
        const result = await complete(owner, query, request.ip);
        return back({ google: 'ok', conexao: result.id, conta: result.account });
      } catch (err) {
        return back({ google: 'erro', mensagem: err instanceof Error ? err.message : String(err) });
      }
    });
  };
