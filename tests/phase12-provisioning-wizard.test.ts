// Phase 12 · Slice 4 — provisioning wizard backend units + routes (Node project).
// Covers what phase12-provisioning.test.ts's end-to-end path doesn't isolate: issueInviteToken
// on its own, confirmPasswordReset's invited→active flip (vs. the pre-existing active→active
// no-op), the slug helpers, and the two new platform routes (check-slug, retry-billing)
// including auth-gating. (Templates are read by the provisioning page server-side via
// listTemplates directly — same no-self-fetch convention as the fleet page — so there is no
// templates route to test here.)

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { setupTestDb, seedPlatformUser, seedTenant, seedTenantUser } from './helpers';
import { issueInviteToken, confirmPasswordReset } from '@/lib/services/password-reset';
import { isValidSlug, isSlugTaken, createTenant } from '@/lib/services/tenants';
import { loginResolvingTenant } from '@/lib/services/auth';
import { issueToken } from '@/lib/auth/jwt';
import { getRawDb, closeDb } from '@/lib/db/client';

const NOW = new Date('2026-07-09T12:00:00.000Z');

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

// ── issueInviteToken ──────────────────────────────────────────────────────────

describe('issueInviteToken', () => {
  test('stores a hash (not the raw) with a ~7-day expiry; the raw token verifies via confirmPasswordReset', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const { rawToken, expiresAt } = issueInviteToken(db, { tenantId: t.id, userId: u.id }, NOW);

    const row = db.prepare('SELECT token_hash, expires_at, consumed_at FROM password_reset_tokens WHERE user_id = ?').get(u.id) as {
      token_hash: string;
      expires_at: string;
      consumed_at: string | null;
    };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(rawToken);
    expect(row.consumed_at).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBe(row.expires_at);

    expect(confirmPasswordReset(db, { rawToken, newPassword: 'a-fresh-password-1' }, NOW).ok).toBe(true);
  });

  test('does NOT queue a notification (the wizard surfaces the link directly; no auto-email)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    issueInviteToken(db, { tenantId: t.id, userId: u.id }, NOW);
    expect((db.prepare('SELECT COUNT(*) c FROM notifications').get() as { c: number }).c).toBe(0);
  });
});

// ── confirmPasswordReset — invited→active flip (Slice 4 addition) ─────────────

describe('confirmPasswordReset · status transition', () => {
  test('an invited user (no password yet) is flipped to active on first credential set', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const { rawToken } = issueInviteToken(db, { tenantId: t.id, userId: u.id }, NOW);

    const before = db.prepare('SELECT status FROM users WHERE id = ?').get(u.id) as { status: string };
    expect(before.status).toBe('invited');

    expect(confirmPasswordReset(db, { rawToken, newPassword: 'first-login-pass-1' }, NOW).ok).toBe(true);

    const after = db.prepare('SELECT status FROM users WHERE id = ?').get(u.id) as { status: string };
    expect(after.status).toBe('active');
    expect(loginResolvingTenant(db, u.email, 'first-login-pass-1')).not.toBeNull();
  });

  test('an already-active user resetting their password stays active (no regression)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { status: 'active', password: 'old-password-1' });
    const { rawToken } = issueInviteToken(db, { tenantId: t.id, userId: u.id }, NOW); // reuse as a generic token for the test

    confirmPasswordReset(db, { rawToken, newPassword: 'new-password-1' }, NOW);
    const after = db.prepare('SELECT status FROM users WHERE id = ?').get(u.id) as { status: string };
    expect(after.status).toBe('active');
  });
});

// ── slug helpers ────────────────────────────────────────────────────────────────

describe('slug helpers', () => {
  test.each([
    ['acme-storage', true],
    ['acme123', true],
    ['a', true],
    ['Acme-Storage', false], // uppercase
    ['acme storage', false], // space
    ['acme--storage', false], // double hyphen
    ['-acme', false], // leading hyphen
    ['acme-', false], // trailing hyphen
    ['', false],
  ])('isValidSlug(%s) → %s', (slug, expected) => {
    expect(isValidSlug(slug)).toBe(expected);
  });

  test('isSlugTaken reflects existing tenants', () => {
    const db = setupTestDb();
    const actor = seedPlatformUser(db);
    expect(isSlugTaken(db, 'acme-storage')).toBe(false);
    createTenant(db, { name: 'Acme', slug: 'acme-storage' }, actor.id);
    expect(isSlugTaken(db, 'acme-storage')).toBe(true);
    expect(isSlugTaken(db, 'someone-else')).toBe(false);
  });
});

// ── routes: check-slug, templates, retry-billing (auth-gating + happy path) ────

describe('platform provisioning-wizard routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let checkSlugGET: (req: Request) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let retryBillingPOST: (req: Request, ctx: { params: { tenantId: string } }) => Promise<any>;
  let db: Database.Database;
  let platformToken: string;
  let tenantToken: string;

  beforeAll(() => {
    db = getRawDb();
    migrate(db);
    seedPlatformUser(db, { id: 'plat-1' });

    platformToken = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });
    tenantToken = issueToken({ sub: 'user-1', tenantId: 'tenant-1', role: 'admin', type: 'tenant' });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    checkSlugGET = require('@/app/api/platform/tenants/check-slug/route').GET;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    retryBillingPOST = require('@/app/api/platform/tenants/[tenantId]/retry-billing/route').POST;
  });
  afterAll(() => closeDb());

  function withAuth(url: string, token?: string): Request {
    return new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }

  test('check-slug: 401 with no auth, 403 for a tenant-type token', async () => {
    expect((await checkSlugGET(withAuth('http://t/api/platform/tenants/check-slug?slug=acme'))).status).toBe(401);
    expect((await checkSlugGET(withAuth('http://t/api/platform/tenants/check-slug?slug=acme', tenantToken))).status).toBe(403);
  });

  test('check-slug: available=true for an unused slug, false once taken', async () => {
    const free = await checkSlugGET(withAuth('http://t/api/platform/tenants/check-slug?slug=brand-new-co', platformToken));
    expect(free.status).toBe(200);
    expect((await free.json()).data).toEqual({ slug: 'brand-new-co', available: true });

    createTenant(db, { name: 'Taken Co', slug: 'brand-new-co' }, 'plat-1');
    const taken = await checkSlugGET(withAuth('http://t/api/platform/tenants/check-slug?slug=brand-new-co', platformToken));
    expect((await taken.json()).data.available).toBe(false);
  });

  test('check-slug: malformed slug → 400', async () => {
    const res = await checkSlugGET(withAuth('http://t/api/platform/tenants/check-slug?slug=Not Valid!', platformToken));
    expect(res.status).toBe(400);
  });

  test('retry-billing: 404 for an unknown tenant', async () => {
    const res = await retryBillingPOST(withAuth('http://t/x', platformToken) as unknown as Request, { params: { tenantId: 'no-such-tenant' } });
    expect(res.status).toBe(404);
  });

  test('retry-billing: attaches via the NoOp provider (dev/test — no STRIPE_SECRET_KEY) for a tenant with an admin', async () => {
    const tenant = createTenant(db, { name: 'Retry Co', slug: 'retry-co' }, 'plat-1');
    seedTenantUser(db, tenant.id, { role: 'admin', email: 'admin@retryco.test' });

    const res = await retryBillingPOST(withAuth('http://t/x', platformToken) as unknown as Request, { params: { tenantId: tenant.id } });
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.attached).toBe(true);
    expect(body.customerId).toBe(`cus_noop_provision_${tenant.id.replace(/[^a-zA-Z0-9]/g, '_')}`);
  });
});
