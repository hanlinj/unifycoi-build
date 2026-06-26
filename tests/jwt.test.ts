import { issueToken, verifyToken, extractBearerToken, type TokenPayload } from '@/lib/auth/jwt';

const tenantPayload: TokenPayload = {
  sub: 'user-123',
  tenantId: 'tenant-abc',
  role: 'admin',
  type: 'tenant',
};

const platformPayload: TokenPayload = {
  sub: 'platform-user-1',
  tenantId: null,
  role: 'owner',
  type: 'platform',
};

describe('JWT issue and verify', () => {
  test('issues a non-empty string token', () => {
    const token = issueToken(tenantPayload);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.sig
  });

  test('verifies a valid tenant token', () => {
    const token = issueToken(tenantPayload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user-123');
    expect(decoded.tenantId).toBe('tenant-abc');
    expect(decoded.role).toBe('admin');
    expect(decoded.type).toBe('tenant');
  });

  test('verifies a valid platform token (tenantId null)', () => {
    const token = issueToken(platformPayload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('platform-user-1');
    expect(decoded.tenantId).toBeNull();
    expect(decoded.type).toBe('platform');
  });

  test('rejects an invalid / tampered token', () => {
    const token = issueToken(tenantPayload);
    const tampered = token.slice(0, -4) + 'XXXX';
    expect(() => verifyToken(tampered)).toThrow('Invalid token');
  });

  test('rejects a token signed with a different secret', () => {
    // Build a raw jwt with a different secret
    const jwt = require('jsonwebtoken');
    const badToken = jwt.sign(tenantPayload, 'wrong-secret', { algorithm: 'HS256' });
    expect(() => verifyToken(badToken)).toThrow('Invalid token');
  });

  test('rejects an expired token', () => {
    const jwt = require('jsonwebtoken');
    const expiredToken = jwt.sign(
      { ...tenantPayload, exp: Math.floor(Date.now() / 1000) - 10 },
      process.env['JWT_SECRET']!,
      { algorithm: 'HS256' }
    );
    expect(() => verifyToken(expiredToken)).toThrow('Token expired');
  });
});

describe('extractBearerToken', () => {
  test('extracts token from valid Authorization header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  test('returns null for missing header', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  test('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });
});
