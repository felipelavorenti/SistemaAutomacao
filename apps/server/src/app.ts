import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { API_REFERENCE } from './api-reference.js';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { ExecutionEvents } from './executions/events.js';
import { createRedis, type ExecutionQueue } from './executions/queue.js';
import { TriggerManager } from './triggers/manager.js';
import { authenticate, SESSION_COOKIE } from './lib/auth.js';
import { HttpError, type CurrentUser } from './lib/permissions.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { dbCommandRoutes } from './routes/db-commands.js';
import { connectionRoutes } from './routes/connections.js';
import { executionRoutes } from './routes/executions.js';
import { fileRoutes } from './routes/files.js';
import { OAUTH_CALLBACK_PATH, oauthRoutes } from './routes/oauth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { workflowRoutes } from './routes/workflows.js';
import { dataTableRoutes } from './routes/data-tables.js';
import { NodeOperationError } from '@sa/engine';

export interface AppDeps {
  db: Db;
  config: Config;
  queue: ExecutionQueue;
  /** Webhooks, formulários e gatilhos que escutam; sem ele, a API cria um (sem subir os gatilhos ativos). */
  triggers?: TriggerManager;
}

/** Dependências já completas, como as rotas recebem. */
export type RouteDeps = AppDeps & { triggers: TriggerManager };

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser | null;
  }
  interface FastifyInstance {
    /** Rotas registradas, para o teste conferir se todas estão na referência da API. */
    registeredRoutes: { method: string; url: string }[];
  }
}

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health', OAUTH_CALLBACK_PATH]);
const ALLOWED_WITH_PASSWORD_CHANGE = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']);

export function currentUser(request: FastifyRequest): CurrentUser {
  if (!request.user) throw new HttpError(401, 'Faça login para continuar');
  return request.user;
}

export async function buildApp(appDeps: AppDeps): Promise<FastifyInstance> {
  const deps: RouteDeps = { ...appDeps, triggers: appDeps.triggers ?? new TriggerManager(appDeps) };
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  const routes: { method: string; url: string }[] = [];
  app.decorate('registeredRoutes', routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });

  await app.register(cookie);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;

    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    request.user = await authenticate(deps.db, request.cookies[SESSION_COOKIE], bearer);
    if (!request.user) throw new HttpError(401, 'Faça login para continuar');
    if (request.user.mustChangePassword && !ALLOWED_WITH_PASSWORD_CHANGE.has(path)) {
      throw new HttpError(403, 'Troque sua senha para continuar', { code: 'must_change_password' });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message, details: error.details });
    }
    // Regras do motor (ex.: tabelas de dados): coluna que não existe, valor do tipo errado.
    if (error instanceof NodeOperationError) {
      return reply.status(400).send({ error: error.message });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Dados inválidos', details: error.issues });
    }
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) return reply.status(statusCode).send({ error: message });
    request.log.error(error);
    return reply.status(500).send({ error: 'Erro interno no servidor' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/docs', async () => API_REFERENCE);

  await app.register(authRoutes(deps), { prefix: '/api' });
  await app.register(adminRoutes(deps), { prefix: '/api' });
  await app.register(connectionRoutes(deps), { prefix: '/api' });
  await app.register(workflowRoutes(deps), { prefix: '/api' });
  await app.register(executionRoutes(deps), { prefix: '/api' });
  await app.register(catalogRoutes(deps), { prefix: '/api' });
  await app.register(dbCommandRoutes(deps), { prefix: '/api' });
  await app.register(oauthRoutes(deps), { prefix: '/api' });
  await app.register(fileRoutes(deps), { prefix: '/api' });
  await app.register(dataTableRoutes(deps), { prefix: '/api' });

  // Avisos das execuções para os webhooks e formulários: conexão Redis criada no primeiro uso.
  let events: ExecutionEvents | null = null;
  let subscriber: ReturnType<typeof createRedis> | null = null;
  await app.register(
    webhookRoutes({
      ...deps,
      events: () => {
        if (!events) {
          subscriber = createRedis(deps.config.redisUrl);
          events = new ExecutionEvents(subscriber);
        }
        return events;
      },
    }),
  );
  app.addHook('onClose', async () => {
    subscriber?.disconnect();
    if (!appDeps.triggers) await deps.triggers.close();
  });

  if (deps.config.webDistDir) {
    await app.register(fastifyStatic, { root: deps.config.webDistDir });
    // Rotas do React: qualquer caminho fora da API devolve o index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'Rota não encontrada' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
