import { encryptField, decryptField } from '@/lib/crypto/field';

describe('Field-level encryption', () => {
  const tin = '12-3456789';
  const accountNumber = '000123456789';

  test('encrypted value differs from plaintext', () => {
    const encrypted = encryptField(tin);
    expect(encrypted).not.toBe(tin);
    expect(encrypted).not.toContain(tin);
  });

  test('round-trip: decrypt(encrypt(x)) === x for TIN', () => {
    const encrypted = encryptField(tin);
    expect(decryptField(encrypted)).toBe(tin);
  });

  test('round-trip: decrypt(encrypt(x)) === x for account number', () => {
    const encrypted = encryptField(accountNumber);
    expect(decryptField(encrypted)).toBe(accountNumber);
  });

  test('each call produces different ciphertext (fresh IV)', () => {
    const e1 = encryptField(tin);
    const e2 = encryptField(tin);
    expect(e1).not.toBe(e2);
  });

  test('output format is base64:base64:base64', () => {
    const encrypted = encryptField(tin);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0], 'base64').length).toBe(12); // 12-byte IV
    expect(Buffer.from(parts[1], 'base64').length).toBe(16); // 16-byte GCM tag
  });

  test('tampered ciphertext fails decryption', () => {
    const encrypted = encryptField(tin);
    const parts = encrypted.split(':');
    // Corrupt the ciphertext part
    const corruptedData = Buffer.from(parts[2], 'base64');
    corruptedData[0] ^= 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${corruptedData.toString('base64')}`;
    expect(() => decryptField(tampered)).toThrow();
  });

  test('handles empty string', () => {
    const encrypted = encryptField('');
    expect(decryptField(encrypted)).toBe('');
  });

  test('handles unicode', () => {
    const value = 'Acmé & Söhne GmbH — TIN: 12-3456789';
    const encrypted = encryptField(value);
    expect(decryptField(encrypted)).toBe(value);
  });
});
