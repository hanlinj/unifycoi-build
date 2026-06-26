// Envelope encryption for document files stored in BlobStore.
//
// Each document gets a random 32-byte data key.
// The data key is wrapped (encrypted) by MASTER_KEK.
// Both use AES-256-GCM.
//
// Stored shape in documents.encryption_json:
//   { algo, iv, tag, wrapped_data_key }
//   where wrapped_data_key = base64(kek_iv + ':' + kek_tag + ':' + encrypted_data_key)

import crypto from 'crypto';
import { env } from '@/lib/env';

export interface EncryptionMeta {
  algo: string;         // 'aes-256-gcm'
  iv: string;           // base64 — nonce used to encrypt the document bytes
  tag: string;          // base64 — GCM auth tag for the document ciphertext
  wrapped_data_key: string; // base64 — KEK-encrypted data key (contains its own iv+tag)
}

const ALGO = 'aes-256-gcm' as const;

function masterKek(): Buffer {
  return Buffer.from(env.crypto.masterKek, 'hex');
}

function wrapKey(dataKey: Buffer): string {
  const kek = masterKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, kek, iv);
  const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Encode as base64(iv):base64(tag):base64(ciphertext)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function unwrapKey(wrapped: string): Buffer {
  const kek = masterKek();
  const parts = wrapped.split(':');
  if (parts.length !== 3) throw new Error('Invalid wrapped_data_key format');
  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function encryptForStorage(plaintext: Buffer): { ciphertext: Buffer; meta: EncryptionMeta } {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const meta: EncryptionMeta = {
    algo: ALGO,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    wrapped_data_key: wrapKey(dataKey),
  };
  return { ciphertext, meta };
}

export function decryptFromStorage(ciphertext: Buffer, meta: EncryptionMeta): Buffer {
  const dataKey = unwrapKey(meta.wrapped_data_key);
  const iv = Buffer.from(meta.iv, 'base64');
  const tag = Buffer.from(meta.tag, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, dataKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
