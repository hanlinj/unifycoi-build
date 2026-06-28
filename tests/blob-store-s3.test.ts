import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
import { createS3Adapter } from '@/lib/blob/s3-adapter';
import { documentKey } from '@/lib/blob/types';
import { encryptForStorage, decryptFromStorage } from '@/lib/crypto/envelope';

// B2 round-trips can take a few seconds each; default 5 s is too tight
jest.setTimeout(15000);

// Load .env so B2 credentials are available when running locally without dotenv-cli
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const rawKey = process.env['S3_ACCESS_KEY_ID'] ?? '';
const skip = !rawKey || rawKey.startsWith('<');
const describeMaybe = skip ? describe.skip : describe;

// Unique tenant prefix per run so parallel runs don't collide
const testTenantId = `test-${crypto.randomBytes(4).toString('hex')}`;

// All object keys created during this run — deleted in afterAll even if tests fail
const createdKeys = new Set<string>();

function makeStore() {
  return createS3Adapter({
    endpoint: process.env['S3_ENDPOINT']!,
    region: process.env['S3_REGION']!,
    bucket: process.env['S3_BUCKET']!,
    accessKeyId: process.env['S3_ACCESS_KEY_ID']!,
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY']!,
  });
}

afterAll(async () => {
  if (skip || createdKeys.size === 0) return;
  const store = makeStore();
  await Promise.allSettled([...createdKeys].map((k) => store.delete(k)));
});

describeMaybe('S3 BlobStore adapter (live B2)', () => {
  const store = makeStore();
  const key = documentKey(testTenantId, 'vendor-1', 'doc-abc');
  const payload = Buffer.from('Hello, COI document bytes!');

  test('put stores data', async () => {
    createdKeys.add(key);
    await store.put(key, payload);
    const result = await store.get(key);
    expect(result).toEqual(payload);
  });

  test('get retrieves the stored data', async () => {
    createdKeys.add(key);
    await store.put(key, payload);
    const result = await store.get(key);
    expect(result).toEqual(payload);
  });

  test('delete removes the key', async () => {
    createdKeys.add(key);
    await store.put(key, payload);
    await store.delete(key);
    createdKeys.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  });

  test('get throws for a missing key', async () => {
    await expect(
      store.get(documentKey(testTenantId, 'x', 'nonexistent'))
    ).rejects.toThrow();
  });

  test('delete is a no-op for a missing key', async () => {
    await expect(
      store.delete(documentKey(testTenantId, 'x', 'nonexistent'))
    ).resolves.not.toThrow();
  });
});

describe.skip('documentKey format — already covered in blob-store.test.ts', () => {});

describeMaybe('Envelope encryption round-trip through S3 BlobStore', () => {
  const store = makeStore();
  const key = documentKey(testTenantId, 'vendor-2', 'doc-encrypted');
  const plaintext = Buffer.from('Sensitive COI PDF bytes go here.');

  test('stored blob is ciphertext (not plaintext)', async () => {
    const { ciphertext, meta: _meta } = encryptForStorage(plaintext);
    createdKeys.add(key);
    await store.put(key, ciphertext);
    const stored = await store.get(key);
    expect(stored).not.toEqual(plaintext);
    expect(stored.toString()).not.toContain('Sensitive COI');
  });

  test('decrypt(get(put(encrypt(x)))) === x', async () => {
    const { ciphertext, meta } = encryptForStorage(plaintext);
    createdKeys.add(key);
    await store.put(key, ciphertext);
    const stored = await store.get(key);
    const decrypted = decryptFromStorage(stored, meta);
    expect(decrypted).toEqual(plaintext);
    await store.delete(key);
    createdKeys.delete(key);
  });
});
