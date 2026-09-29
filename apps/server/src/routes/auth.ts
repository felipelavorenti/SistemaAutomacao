import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentUser, type AppDeps } from '../app.js';
import { many, one } from '../db/db.js';
import { audit } from '../lib/audit.js';
import { checkPasswordStrength, hashPassword, login, logout, SESSION_COOKIE } from '../lib/auth.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { can, HttpError, notFound } from '../lib/permissions.js';

export const authRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.post('/auth/login', async (request, reply) => {
      const body = z.object({ email: z.string().trim().min(1), password: z.string().min(1) }).parse(request.body);
      const result = await login(db, body.email, body.password, config.sessionTtlHours);
      if (!result.ok) {
        await audit(db, { userId: result.userId ?? null, action: 'login_failed', entityType: 'session', entityName: body.email, ip: request.ip });
        throw new HttpError(401, result.reason);
      }
      await audit(db, { userId: result.userId, action: 'login', entityType: 'session', ip: request.ip });
      reply.setCookie(SESSION_COOKIE, result.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
        maxAge: config.sessionTtlHours * 3600,
      });
      return { ok: true };
    });

    app.post('/auth/logout', async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await logout(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/auth/me', async (request) => {
      const user = currentUser(request);
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        permissions: {
          editWorkflows: can(user, 'workflow:edit'),
          executeWorkflows: can(user, 'workflow:execute'),
          editConnections: can(user, 'connection:edit'),
          admin: can(user, 'admin'),
        },
      };
    });

    app.post('/auth/change-password', async (request) => {
      const user = currentUser(request);
      const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(request.body);
      const row = await one<{ password_hash: string }>(db, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
      if (!row || !(await bcrypt.compare(body.currentPassword, row.password_hash))) throw new HttpError(400, 'Senha atual incorreta');
      const weak = checkPasswordStrength(body.newPassword);
      if (weak) throw new HttpError(400, weak);
      await db.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
        user.id,
        await hashPassword(body.newPassword),
      ]);
      await audit(db, { userId: user.id, action: 'change_password', entityType: 'user', entityId: user.id, entityName: user.email, ip: request.ip });
      return { ok: true };
    });

    // Tokens de API pessoais, para sistemas internos dispararem fluxos.
    app.get('/auth/tokens', async (request) => {
      const user = currentUser(request);
      return many(db, 'SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
    });

    app.post('/auth/tokens', async (request) => {
      const user = currentUser(request);
      const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
      const token = `sa_${randomToken()}`;
      const row = await one<{ id: string }>(db, 'INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id', [
        user.id,
        body.name,
        sha256(token),
      ]);
      await audit(db, { userId: user.id, action: 'create', entityType: 'api_token', entityId: row!.id, entityName: body.name, ip: request.ip });
      // O token só aparece nesta resposta.
      return { id: row!.id, name: body.name, token };
    });

    app.delete('/auth/tokens/:id', async (request) => {
      const user = currentUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const row = await one<{ name: string }>(db, 'DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING name', [id, user.id]);
      if (!row) throw notFound('Token');
      await audit(db, { userId: user.id, action: 'delete', entityType: 'api_token', entityId: id, entityName: row.name, ip: request.ip });
      return { ok: true };
    });
  };
