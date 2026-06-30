// Self-contained envelope-encrypted blob format.
//
// Documents store their EncryptionMeta in documents.encryption_json; reports and audit exports
// have no such column, so we pack the meta INTO the blob: a 4-byte big-endian length prefix,
// the meta JSON, then the ciphertext. The blob is decryptable from BlobStore alone — exactly
// what the export round-trip needs.

import { encryptForStorage, decryptFromStorage, type EncryptionMeta } from './envelope';

/** Envelope-encrypt `plaintext` into a single self-describing buffer. */
export function packEncrypted(plaintext: Buffer): Buffer {
  const { ciphertext, meta } = encryptForStorage(plaintext);
  const metaJson = Buffer.from(JSON.stringify(meta), 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(metaJson.length, 0);
  return Buffer.concat([len, metaJson, ciphertext]);
}

/** Decrypt a buffer produced by packEncrypted back to plaintext. */
export function unpackEncrypted(blob: Buffer): Buffer {
  if (blob.length < 4) throw new Error('Invalid encrypted blob: too short');
  const metaLen = blob.readUInt32BE(0);
  const metaJson = blob.subarray(4, 4 + metaLen).toString('utf-8');
  const meta = JSON.parse(metaJson) as EncryptionMeta;
  const ciphertext = blob.subarray(4 + metaLen);
  return decryptFromStorage(ciphertext, meta);
}
