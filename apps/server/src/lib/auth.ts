import bcrypt from 'bcryptjs';
import { many, one, type Db } from '../db/db.js';
import { randomToken, sha256 } from './crypto.js';
import type { CurrentUser, Role } from './permissions.js';

export const SESSION_COOKIE = 'sa_session';
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

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

export type LoginResult = { ok: true; userId: string; token: string } | { ok: false; reason: string; userId?: string };

export async function login(db: Db, email: string, password: string, ttlHours: number): Promise<LoginResult> {
  const user = await one<UserRow>(db, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  if (!user || !user.active) {
    // Compara mesmo assim, para o tempo de resposta não revelar se o e-mail existe.
    await bcrypt.compare(password, await dummyHash());
    return { ok: false, reason: 'E-mail ou senha incorretos' };
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
    return { ok: false, reason: 'E-mail ou senha incorretos', userId: user.id };
  }

  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const token = randomToken();
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
    const row = await one<{ user_id: string }>(
      db,
      'UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1 RETURNING user_id',
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
