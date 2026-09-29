import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Criptografa um objeto com AES-256-GCM. Formato: iv (12) + tag (16) + dados. */
export function encryptJson(key: Buffer, value: unknown): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

export function decryptJson<T>(key: Buffer, payload: Buffer): T {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(text) as T;
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
