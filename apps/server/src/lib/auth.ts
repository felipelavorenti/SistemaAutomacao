import bcrypt from 'bcryptjs';
import { many, one, type Db } from '../db/db.js';
import { randomToken, sha256 } from './crypto.js';
import type { CurrentUser, Role } from './permissions.js';

export const SESSION_COOKIE = 'sa_session';
/**
 * Bloqueio da conta inteira (no banco), de qualquer computador. Fica alto para que errar a senha de
 * propósito não tranque o dono da conta; o bloqueio do dia a dia é o do LoginThrottle, por computador.
 */
const MAX_FAILED_LOGINS = 50;
const LOCK_MINUTES = 15;

/**
 * Tentativas erradas de login guardadas na memória da API, por computador (IP): 5 erros para o mesmo
 * usuário bloqueiam esse usuário só naquele computador, e 20 erros de um computador (para qualquer
 * usuário) bloqueiam o computador. Tudo por 15 minutos.
 */
export class LoginThrottle {
  static readonly WINDOW_MS = LOCK_MINUTES * 60_000;
  static readonly MAX_PER_USER = 5;
  static readonly MAX_PER_IP = 20;
  private failures = new Map<string, number[]>();

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < LoginThrottle.WINDOW_MS);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Motivo da recusa, ou null se pode tentar. */
  blocked(ip: string, email: string, now = Date.now()): string | null {
    if (this.recent(`ip:${ip}`, now).length >= LoginThrottle.MAX_PER_IP) {
      return 'Muitas tentativas erradas deste computador. Tente de novo em 15 minutos.';
    }
    if (this.recent(`user:${email.toLowerCase()}|${ip}`, now).length >= LoginThrottle.MAX_PER_USER) {
      return 'Usuário bloqueado temporariamente neste computador por tentativas erradas. Tente de novo mais tarde.';
    }
    return null;
  }

  fail(ip: string, email: string, now = Date.now()): void {
    for (const key of [`ip:${ip}`, `user:${email.toLowerCase()}|${ip}`]) this.failures.set(key, [...this.recent(key, now), now]);
  }

  /** Login certo: zera os erros desse usuário naquele computador. */
  succeed(ip: string, email: string): void {
    this.failures.delete(`user:${email.toLowerCase()}|${ip}`);
  }

  /** Desbloqueio pelo administrador: zera os erros do usuário em todos os computadores. */
  clearUser(email: string): void {
    const prefix = `user:${email.toLowerCase()}|`;
    for (const key of [...this.failures.keys()]) if (key.startsWith(prefix)) this.failures.delete(key);
  }
}

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= bcrypt.hash('senha-inexistente', 12));

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function checkPasswordStrength(password: string): string | null {
  if (password.length < 10) return 'A senha precisa ter pelo menos 10 caracteres';
  return null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  password_hash: string;
  failed_logins: number;
  locked_until: Date | null;
  must_change_password: boolean;
}

export type LoginResult = { ok: true; userId: string; token: string } | { ok: false; reason: string; userId?: string; wrongPassword?: boolean };

export async function login(db: Db, email: string, password: string, ttlHours: number): Promise<LoginResult> {
  const user = await one<UserRow>(db, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  if (!user || !user.active) {
    // Compara mesmo assim, para o tempo de resposta não revelar se o e-mail existe.
    await bcrypt.compare(password, await dummyHash());
    return { ok: false, reason: 'E-mail ou senha incorretos', wrongPassword: true };
  }
  if (user.locked_until && user.locked_until > new Date()) {
    return { ok: false, reason: 'Usuário bloqueado temporariamente por tentativas erradas. Tente de novo mais tarde.', userId: user.id };
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await db.query(
      `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock, LOCK_MINUTES],
    );
    return { ok: false, reason: 'E-mail ou senha incorretos', userId: user.id, wrongPassword: true };
  }

  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const token = randomToken();
  // Sessão vencida não vale mais para nada: sai da tabela a cada login novo.
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [
    sha256(token),
    user.id,
    ttlHours,
  ]);
  return { ok: true, userId: user.id, token };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Resolve o usuário a partir do cookie de sessão ou de um token de API. */
export async function authenticate(db: Db, sessionToken?: string, apiToken?: string): Promise<CurrentUser | null> {
  let userId: string | undefined;
  if (sessionToken) {
    const row = await one<{ user_id: string }>(db, 'SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(sessionToken)]);
    userId = row?.user_id;
  } else if (apiToken) {
    // O último uso só é regravado quando passou mais de um minuto da gravação anterior: um sistema que chama a API
    // várias vezes por segundo não faz uma gravação no banco por chamada.
    const row = await one<{ user_id: string }>(
      db,
      `WITH t AS (SELECT user_id, last_used_at FROM api_tokens WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())),
            touched AS (
              UPDATE api_tokens SET last_used_at = now()
              WHERE token_hash = $1 AND EXISTS (SELECT 1 FROM t WHERE last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
            )
       SELECT user_id FROM t`,
      [sha256(apiToken)],
    );
    userId = row?.user_id;
  }
  if (!userId) return null;
  return loadUser(db, userId);
}

export async function loadUser(db: Db, userId: string): Promise<CurrentUser | null> {
  const user = await one<UserRow>(db, 'SELECT * FROM users WHERE id = $1 AND active', [userId]);
  if (!user) return null;
  const isAdmin = user.role === 'admin';
  const folders = isAdmin ? null : (await many<{ folder_id: string }>(db, 'SELECT folder_id FROM user_folders WHERE user_id = $1', [userId])).map((r) => r.folder_id);
  const clients = isAdmin ? null : (await many<{ client_id: string }>(db, 'SELECT client_id FROM user_clients WHERE user_id = $1', [userId])).map((r) => r.client_id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.must_change_password,
    folderIds: folders,
    clientIds: clients,
  };
}

/** Cria o primeiro administrador quando o banco ainda não tem usuários. */
export async function ensureAdmin(db: Db, admin?: { email: string; password: string; name: string }): Promise<boolean> {
  if (!admin) return false;
  const count = await one<{ n: string }>(db, 'SELECT count(*) AS n FROM users');
  if (Number(count?.n) > 0) return false;
  await db.query(`INSERT INTO users (email, name, password_hash, role, must_change_password) VALUES ($1, $2, $3, 'admin', true)`, [
    admin.email,
    admin.name,
    await hashPassword(admin.password),
  ]);
  return true;
}
