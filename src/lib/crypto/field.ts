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

/** Field key for a given key version. Hook for rotation — only v1 exists today. */
function fieldKeyForVersion(version: number): Buffer {
  if (version === 1) return fieldKey();
  throw new Error(`No field key for key_version ${version} (rotation not configured)`);
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
  // SEC-13 key-version hook. Unversioned 3-part ciphertext (iv:tag:ct) IS key version 1 —
  // its format is unchanged, so encryptField still emits 3-part. A future rotation emits a
  // `v<N>:iv:tag:ct` 4-part form, which this path already understands and routes to the
  // matching key. Legacy/missing version → v1.
  const parts = ciphertext.split(':');
  let version = 1;
  let ivB64: string, tagB64: string, encB64: string;
  if (parts.length === 4 && /^v(\d+)$/.test(parts[0])) {
    version = Number(parts[0].slice(1));
    [, ivB64, tagB64, encB64] = parts;
  } else if (parts.length === 3) {
    [ivB64, tagB64, encB64] = parts; // unversioned == v1
  } else {
    throw new Error('Invalid field ciphertext format');
  }
  const key = fieldKeyForVersion(version);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}
