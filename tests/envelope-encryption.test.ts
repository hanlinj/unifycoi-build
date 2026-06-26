import { encryptForStorage, decryptFromStorage } from '@/lib/crypto/envelope';

describe('Envelope encryption', () => {
  const plaintext = Buffer.from('This is a test vendor COI document payload.');

  test('ciphertext differs from plaintext', () => {
    const { ciphertext } = encryptForStorage(plaintext);
    expect(ciphertext).not.toEqual(plaintext);
    expect(ciphertext.toString()).not.toContain('test vendor COI');
  });

  test('round-trip: decrypt(encrypt(x)) === x', () => {
    const { ciphertext, meta } = encryptForStorage(plaintext);
    const decrypted = decryptFromStorage(ciphertext, meta);
    expect(decrypted).toEqual(plaintext);
  });

  test('meta has the required shape', () => {
    const { meta } = encryptForStorage(plaintext);
    expect(meta).toHaveProperty('algo', 'aes-256-gcm');
    expect(meta).toHaveProperty('iv');
    expect(meta).toHaveProperty('tag');
    expect(meta).toHaveProperty('wrapped_data_key');
    expect(typeof meta.iv).toBe('string');
    expect(typeof meta.wrapped_data_key).toBe('string');
  });

  test('each encrypt call produces a different ciphertext (fresh IV/key)', () => {
    const { ciphertext: c1 } = encryptForStorage(plaintext);
    const { ciphertext: c2 } = encryptForStorage(plaintext);
    expect(c1).not.toEqual(c2);
  });

  test('tampered ciphertext fails decryption (GCM auth)', () => {
    const { ciphertext, meta } = encryptForStorage(plaintext);
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;
    expect(() => decryptFromStorage(tampered, meta)).toThrow();
  });

  test('meta can be serialised to / from JSON', () => {
    const { ciphertext, meta } = encryptForStorage(plaintext);
    const serialised = JSON.stringify(meta);
    const parsed = JSON.parse(serialised);
    const decrypted = decryptFromStorage(ciphertext, parsed);
    expect(decrypted).toEqual(plaintext);
  });
});
