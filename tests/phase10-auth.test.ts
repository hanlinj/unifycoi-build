// Phase 10, Slice A-prime — authentication & session.
//
// Proves: login resolves the tenant from email (form has no tenant id), sets an HttpOnly
// session cookie; getAuth reads that cookie (not just the Bearer header); logout clears it;
// landingPathFor routes per role.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { setupTestDb, seedTenant, seedTenantUser, seedPlatformUser } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { getAuth, SESSION_COOKIE } from '@/lib/api';
import { landingPathFor } from '@/lib/auth/landing';
import { loginResolvingTenant } from '@/lib/services/auth';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

// ── landingPathFor (pure) ────────────────────────────────────────────────────────────

describe('landingPathFor', () => {
  test('Admin + District → /command-center (oversight-first)', () => {
    expect(landingPathFor({ type: 'tenant', role: 'admin' })).toBe('/command-center');
    expect(landingPathFor({ type: 'tenant', role: 'district_manager' })).toBe('/command-center');
  });
  test('Store Manager → /dashboard', () => {
    expect(landingPathFor({ type: 'tenant', role: 'store_manager' })).toBe('/dashboard');
  });
  test('Platform → /platform', () => {
    expect(landingPathFor({ type: 'platform', role: 'owner' })).toBe('/platform');
  });
});

// ── email → tenant resolution ────────────────────────────────────────────────────────

describe('loginResolvingTenant', () => {
  test('resolves a tenant user by email with no tenantId supplied', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { email: 'admin@acme.test', password: 'correct-horse', role: 'admin' });
    const ok = loginResolvingTenant(db, 'admin@acme.test', 'correct-horse');
    expect(ok).not.toBeNull();
    expect(ok!.user.tenantId).toBe(t.id);
    expect(ok!.user.role).toBe('admin');
    expect(loginResolvingTenant(db, 'admin@acme.test', 'wrong')).toBeNull();
    db.close();
  });

  test('platform user resolves with no tenantId', () => {
    const db = setupTestDb();
    seedPlatformUser(db, { email: 'ops@unifycoi.com', password: 'platform-pass' });
    const ok = loginResolvingTenant(db, 'ops@unifycoi.com', 'platform-pass');
    expect(ok!.user.type).toBe('platform');
    db.close();
  });
});

// ── route: cookie set on login, read by getAuth, cleared on logout ────────────────────

describe('session cookie round-trip', () => {
  afterEach(() => closeDb());

  test('login sets an HttpOnly session cookie; getAuth authenticates from the cookie', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { email: 'u@acme.test', password: 'pw-123456', role: 'admin' });

    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(new Request('http://t/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u@acme.test', password: 'pw-123456' }) }));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');

    // Extract the cookie value and prove getAuth authenticates a request carrying ONLY the cookie.
    const token = /uc_session=([^;]+)/.exec(setCookie)![1];
    const authed = getAuth(new Request('http://t/api/anything', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    expect(authed).not.toBeNull();
    expect(authed!.role).toBe('admin');
    expect(authed!.tenantId).toBe(t.id);
  });

  test('bad credentials → 401, no session cookie', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { email: 'u@acme.test', password: 'pw-123456', role: 'admin' });
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(new Request('http://t/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u@acme.test', password: 'nope' }) }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=ey`); // no JWT issued
  });

  test('logout clears the cookie (Max-Age=0)', async () => {
    const { POST } = await import('@/app/api/auth/logout/route');
    const res = await POST();
    const sc = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(sc).toContain(`${SESSION_COOKIE}=`.toLowerCase());
    expect(sc).toContain('max-age=0');
  });

  test('getAuth prefers the Bearer header when both are present', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { role: 'admin' });
    const { issueToken } = await import('@/lib/auth/jwt');
    const bearer = issueToken({ sub: u.id, tenantId: t.id, role: 'admin', type: 'tenant' });
    const authed = getAuth(new Request('http://t/x', { headers: { Authorization: `Bearer ${bearer}`, cookie: `${SESSION_COOKIE}=garbage` } }));
    expect(authed!.role).toBe('admin'); // Bearer used, cookie ignored
    db.close();
  });
});
