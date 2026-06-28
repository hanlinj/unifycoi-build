// Field-level encryption for Sensitive DB columns (full TIN, ACH account/routing).
// AES-256-GCM with FIELD_ENCRYPTION_KEY.
// Ciphertext stored as: base64(iv):base64(tag):base64(ciphertext)

import crypto from 'crypto';
import { env } from '@/lib/env';

const ALGO = 'aes-256-gcm' as const;

function decodeKey(value: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
}

function fieldKey(): Buffer {
  return decodeKey(env.crypto.fieldEncryptionKey);
}

export function encryptField(plaintext: string): string {
  const key = fieldKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptField(ciphertext: string): string {
  const key = fieldKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid field ciphertext format');
  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}
