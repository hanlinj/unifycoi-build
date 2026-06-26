// Password hashing with Node.js built-in crypto.scrypt — no native deps.
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(password, salt, KEY_BYTES).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, 'hex');
  const newHash = scryptSync(password, salt, KEY_BYTES);
  return timingSafeEqual(hashBuf, newHash);
}
