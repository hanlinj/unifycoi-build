import { setupTestDb, seedPlatformUser, seedTenant, seedTenantUser } from './helpers';
import { loginWithEmail, getMeInfo } from '@/lib/services/auth';
import { verifyToken } from '@/lib/auth/jwt';
import { hashPassword, verifyPassword } from '@/lib/auth/password';

describe('Password hashing', () => {
  test('hashPassword produces a different string', () => {
    const hash = hashPassword('mysecret');
    expect(hash).not.toBe('mysecret');
    expect(hash).toContain(':');
  });

  test('verifyPassword returns true for correct password', () => {
    const hash = hashPassword('correct');
    expect(verifyPassword('correct', hash)).toBe(true);
  });

  test('verifyPassword returns false for wrong password', () => {
    const hash = hashPassword('correct');
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  test('two hashes of the same password differ (salt randomness)', () => {
    const h1 = hashPassword('same');
    const h2 = hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});

describe('loginWithEmail — platform users', () => {
  let db: ReturnType<typeof setupTestDb>;
  let platform: ReturnType<typeof seedPlatformUser>;

  beforeEach(() => {
    db = setupTestDb();
    platform = seedPlatformUser(db);
  });
  afterEach(() => db.close());

  test('returns token + user for valid credentials', () => {
    const result = loginWithEmail(db, platform.email, platform.password);
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.user.type).toBe('platform');
    expect(result!.user.email).toBe(platform.email);
  });

  test('returns null for wrong password', () => {
    expect(loginWithEmail(db, platform.email, 'wrongpassword')).toBeNull();
  });

  test('returns null for unknown email', () => {
    expect(loginWithEmail(db, 'nobody@example.com', 'anything')).toBeNull();
  });

  test('issued token is valid and encodes correct claims', () => {
    const result = loginWithEmail(db, platform.email, platform.password)!;
    const payload = verifyToken(result.token);
    expect(payload.type).toBe('platform');
    expect(payload.sub).toBe(platform.id);
    expect(payload.tenantId).toBeNull();
  });
});

describe('loginWithEmail — tenant users', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let tenantUser: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db, { lifecycle_state: 'active' });
    tenantUser = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('returns token for valid tenant user credentials', () => {
    const result = loginWithEmail(db, tenantUser.email, 'securepassword123', tenant.id);
    expect(result).not.toBeNull();
    expect(result!.user.type).toBe('tenant');
    expect(result!.user.tenantId).toBe(tenant.id);
  });

  test('token encodes correct tenant claims', () => {
    const result = loginWithEmail(db, tenantUser.email, 'securepassword123', tenant.id)!;
    const payload = verifyToken(result.token);
    expect(payload.type).toBe('tenant');
    expect(payload.tenantId).toBe(tenant.id);
    expect(payload.role).toBe('admin');
  });

  test('returns null for wrong password', () => {
    expect(loginWithEmail(db, tenantUser.email, 'wrong', tenant.id)).toBeNull();
  });

  test('returns null for unknown tenant', () => {
    expect(loginWithEmail(db, tenantUser.email, 'securepassword123', 'nonexistent-tenant')).toBeNull();
  });

  test('returns null when tenant is suspended', () => {
    const suspended = seedTenant(db, { lifecycle_state: 'suspended' });
    const u = seedTenantUser(db, suspended.id);
    expect(loginWithEmail(db, u.email, 'securepassword123', suspended.id)).toBeNull();
  });

  test('returns null when tenant is offboarded', () => {
    const off = seedTenant(db, { lifecycle_state: 'offboarded' });
    const u = seedTenantUser(db, off.id);
    expect(loginWithEmail(db, u.email, 'securepassword123', off.id)).toBeNull();
  });

  test('returns null for disabled user', () => {
    const disabled = seedTenantUser(db, tenant.id, { status: 'disabled' });
    expect(loginWithEmail(db, disabled.email, 'securepassword123', tenant.id)).toBeNull();
  });

  test('returns null for invited user with no password', () => {
    const invited = { ...seedTenantUser(db, tenant.id, { status: 'invited' }) };
    // clear the password_hash
    db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(invited.id);
    expect(loginWithEmail(db, invited.email, 'securepassword123', tenant.id)).toBeNull();
  });
});

describe('getMeInfo', () => {
  let db: ReturnType<typeof setupTestDb>;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(() => db.close());

  test('returns platform user info', () => {
    const pUser = seedPlatformUser(db);
    const result = loginWithEmail(db, pUser.email, pUser.password)!;
    const payload = verifyToken(result.token);
    const info = getMeInfo(db, payload);
    expect(info).not.toBeNull();
    expect((info as Record<string, unknown>).email).toBe(pUser.email);
    expect((info as Record<string, unknown>).type).toBe('platform');
  });

  test('returns tenant user info', () => {
    const tenant = seedTenant(db);
    const u = seedTenantUser(db, tenant.id);
    const result = loginWithEmail(db, u.email, 'securepassword123', tenant.id)!;
    const payload = verifyToken(result.token);
    const info = getMeInfo(db, payload);
    expect(info).not.toBeNull();
    expect((info as Record<string, unknown>).tenantId).toBe(tenant.id);
  });
});
