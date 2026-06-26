import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createFsAdapter } from '@/lib/blob/fs-adapter';
import { documentKey } from '@/lib/blob/types';
import { encryptForStorage, decryptFromStorage } from '@/lib/crypto/envelope';

const testDir = path.join(os.tmpdir(), `unifycoi-blob-test-${crypto.randomBytes(4).toString('hex')}`);

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('Filesystem BlobStore adapter', () => {
  const store = createFsAdapter(testDir);
  const key = documentKey('tenant-1', 'vendor-1', 'doc-abc');
  const payload = Buffer.from('Hello, COI document bytes!');

  test('put stores data', async () => {
    await store.put(key, payload);
    const fullPath = path.join(testDir, key);
    expect(fs.existsSync(fullPath)).toBe(true);
  });

  test('get retrieves the stored data', async () => {
    await store.put(key, payload);
    const result = await store.get(key);
    expect(result).toEqual(payload);
  });

  test('delete removes the key', async () => {
    await store.put(key, payload);
    await store.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  });

  test('get throws for a missing key', async () => {
    await expect(store.get('tenants/x/vendors/y/nonexistent')).rejects.toThrow();
  });

  test('delete is a no-op for a missing key', async () => {
    await expect(store.delete('tenants/x/vendors/y/nonexistent')).resolves.not.toThrow();
  });
});

describe('documentKey format', () => {
  test('produces the correct tenant-prefixed key', () => {
    expect(documentKey('t1', 'v1', 'd1')).toBe('tenants/t1/vendors/v1/d1');
  });
});

describe('Envelope encryption round-trip through BlobStore', () => {
  const store = createFsAdapter(testDir);
  const key = documentKey('tenant-2', 'vendor-2', 'doc-encrypted');
  const plaintext = Buffer.from('Sensitive COI PDF bytes go here.');

  test('stored blob is ciphertext (not plaintext)', async () => {
    const { ciphertext, meta: _meta } = encryptForStorage(plaintext);
    await store.put(key, ciphertext);
    const stored = await store.get(key);
    expect(stored).not.toEqual(plaintext);
    expect(stored.toString()).not.toContain('Sensitive COI');
  });

  test('decrypt(get(put(encrypt(x)))) === x', async () => {
    const { ciphertext, meta } = encryptForStorage(plaintext);
    await store.put(key, ciphertext);
    const stored = await store.get(key);
    const decrypted = decryptFromStorage(stored, meta);
    expect(decrypted).toEqual(plaintext);
    await store.delete(key);
  });
});
