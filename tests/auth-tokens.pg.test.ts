// tests/auth-tokens.pg.test.ts — Phase 13 migration, Stage 3: verifies auth.ts, rate-limit.ts,
// password-reset.ts (+ their hard dependency queue.ts) against real Postgres, in isolation
// from downstream callers that haven't converted yet (same rationale as db-core.pg.test.ts /
// audit-scope.pg.test.ts). Specifically exercises the COLLATE NOCASE → lower() rewrite's
// case-insensitivity on both the login and password-reset paths — a real behavior that could
// have silently changed during the port.
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { hashPassword } from '@/lib/auth/password';
import { loginWithEmail, loginResolvingTenant, getMeInfo } from '@/lib/services/auth';
import { checkLoginRate, recordLoginFailure, clearLoginFailuresForEmail } from '@/lib/auth/rate-limit';
import {
  requestPasswordReset,
  issueInviteToken,
  issueBillingSetupToken,
  resolveBillingSetupToken,
  peekResetToken,
  confirmPasswordReset,
} from '@/lib/services/password-reset';
import type { Db } from '@/lib/db/client';

describe('db-core (Stage 3): auth.ts — login + getMeInfo', () => {
  let db: Db;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const platformUserId = randomUUID();

  beforeEach(async () => {
    db = await setupTestDb();
    await db.insertInto('tenants').values({ id: tenantId, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
    await db.insertInto('users').values({
      id: userId, tenant_id: tenantId, email: 'Admin@Example.com', name: 'Admin', role: 'admin',
      password_hash: hashPassword('correct-horse-battery'), status: 'active', created_at: new Date(),
    }).execute();
    await db.insertInto('platform_users').values({
      id: platformUserId, email: 'Owner@Platform.com', name: 'Owner', role: 'owner',
      password_hash: hashPassword('platform-pass'), created_at: new Date(),
    }).execute();
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('tenant login succeeds with correct credentials', async () => {
    const result = await loginWithEmail(db, 'admin@example.com', 'correct-horse-battery', tenantId);
    expect(result?.user.id).toBe(userId);
    expect(result?.token).toBeTruthy();
  });

  test('CASE-INSENSITIVE: tenant login matches regardless of email casing on either side (stored mixed-case, lookup any case)', async () => {
    const asLower = await loginWithEmail(db, 'admin@example.com', 'correct-horse-battery', tenantId);
    const asUpper = await loginWithEmail(db, 'ADMIN@EXAMPLE.COM', 'correct-horse-battery', tenantId);
    const asStored = await loginWithEmail(db, 'Admin@Example.com', 'correct-horse-battery', tenantId);
    expect(asLower?.user.id).toBe(userId);
    expect(asUpper?.user.id).toBe(userId);
    expect(asStored?.user.id).toBe(userId);
  });

  test('CASE-INSENSITIVE: platform login also matches regardless of casing', async () => {
    const result = await loginWithEmail(db, 'owner@platform.com', 'platform-pass');
    expect(result?.user.id).toBe(platformUserId);
  });

  test('wrong password fails', async () => {
    const result = await loginWithEmail(db, 'admin@example.com', 'wrong-password', tenantId);
    expect(result).toBeNull();
  });

  test('disabled user cannot log in', async () => {
    const disabledId = randomUUID();
    await db.insertInto('users').values({
      id: disabledId, tenant_id: tenantId, email: 'disabled@example.com', name: 'D', role: 'admin',
      password_hash: hashPassword('pw'), status: 'disabled', created_at: new Date(),
    }).execute();
    const result = await loginWithEmail(db, 'disabled@example.com', 'pw', tenantId);
    expect(result).toBeNull();
  });

  test('suspended/offboarded tenant blocks login even with correct credentials', async () => {
    await db.updateTable('tenants').set({ lifecycle_state: 'suspended' }).where('id', '=', tenantId).execute();
    const result = await loginWithEmail(db, 'admin@example.com', 'correct-horse-battery', tenantId);
    expect(result).toBeNull();
  });

  test('loginResolvingTenant finds the right tenant without an explicit tenantId (case-insensitive too)', async () => {
    const result = await loginResolvingTenant(db, 'ADMIN@EXAMPLE.COM', 'correct-horse-battery');
    expect(result?.user.id).toBe(userId);
    expect(result?.user.tenantId).toBe(tenantId);
  });

  test('getMeInfo returns tenant user info with tenant_name', async () => {
    const info = await getMeInfo(db, { sub: userId, tenantId, role: 'admin', type: 'tenant' });
    expect(info?.['id']).toBe(userId);
    expect(info?.['tenant_name']).toBe('Test Tenant');
  });

  test('getMeInfo returns platform user info', async () => {
    const info = await getMeInfo(db, { sub: platformUserId, tenantId: null, role: 'owner', type: 'platform' });
    expect(info?.['id']).toBe(platformUserId);
    expect(info?.['type']).toBe('platform');
  });
});

describe('db-core (Stage 3): rate-limit.ts', () => {
  let db: Db;

  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('allows attempts under the configured max, blocks at/over it', async () => {
    const key = { email: 'probe@example.com', ip: '10.0.0.1' };
    const cfg = { maxPerEmail: 3, maxPerIp: 30, windowSeconds: 900 };
    for (let i = 0; i < 3; i++) {
      const decision = await checkLoginRate(db, key, new Date(), cfg);
      expect(decision.allowed).toBe(true);
      await recordLoginFailure(db, key);
    }
    const blocked = await checkLoginRate(db, key, new Date(), cfg);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('clearLoginFailuresForEmail lifts the email-scope block but the IP scope survives', async () => {
    const key = { email: 'probe2@example.com', ip: '10.0.0.2' };
    const cfg = { maxPerEmail: 1, maxPerIp: 1, windowSeconds: 900 };
    await recordLoginFailure(db, key);
    expect((await checkLoginRate(db, key, new Date(), cfg)).allowed).toBe(false);

    await clearLoginFailuresForEmail(db, key.email);
    // Email scope cleared, but IP scope (shared key) still has the one failure recorded against it.
    const afterClear = await checkLoginRate(db, key, new Date(), cfg);
    expect(afterClear.allowed).toBe(false); // still blocked — via the IP scope, not email
  });

  test('window math uses real timestamp comparison — an old failure outside the window does not block', async () => {
    const key = { email: 'probe3@example.com', ip: '10.0.0.3' };
    const longAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await recordLoginFailure(db, key, longAgo);
    const decision = await checkLoginRate(db, key, new Date(), { maxPerEmail: 1, maxPerIp: 1, windowSeconds: 900 });
    expect(decision.allowed).toBe(true);
  });
});

describe('db-core (Stage 3): password-reset.ts', () => {
  let db: Db;
  const tenantId = randomUUID();
  const userId = randomUUID();

  beforeEach(async () => {
    db = await setupTestDb();
    await db.insertInto('tenants').values({ id: tenantId, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
    await db.insertInto('users').values({
      id: userId, tenant_id: tenantId, email: 'Reset@Example.com', name: 'User', role: 'admin',
      password_hash: hashPassword('old-password'), status: 'active', created_at: new Date(),
    }).execute();
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('CASE-INSENSITIVE: requestPasswordReset resolves the user regardless of email casing, queues a notification, and logs the audit event', async () => {
    await requestPasswordReset(db, { email: 'RESET@EXAMPLE.COM' });
    const notif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
    expect(notif).toBeDefined();
    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'password_reset.requested').executeTakeFirst();
    expect(audit?.target_id).toBe(userId);
    expect(audit?.payload_json).toBeNull(); // never carries the token
  });

  test('enumeration-safe: an unknown email writes nothing (no row anywhere to attribute it to)', async () => {
    await requestPasswordReset(db, { email: 'nobody@nowhere.test' });
    const anyTokens = await db.selectFrom('password_reset_tokens').selectAll().execute();
    const anyAudit = await db.selectFrom('audit_events').selectAll().execute();
    expect(anyTokens).toHaveLength(0);
    expect(anyAudit).toHaveLength(0);
  });

  test('full reset flow: request → peek (valid) → confirm → old password no longer works, new one does', async () => {
    await requestPasswordReset(db, { email: 'reset@example.com' });
    const notif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    const rawToken = new URL('http://x' + (notif.payload_json as { reset_path: string }).reset_path).searchParams.get('token')!;

    const peek = await peekResetToken(db, rawToken);
    expect(peek.status).toBe('valid');
    expect(peek.userId).toBe(userId);

    const confirmResult = await confirmPasswordReset(db, { rawToken, newPassword: 'brand-new-password-123' });
    expect(confirmResult).toEqual({ ok: true, userId, tenantId });

    expect(await loginWithEmail(db, 'reset@example.com', 'old-password', tenantId)).toBeNull();
    expect((await loginWithEmail(db, 'reset@example.com', 'brand-new-password-123', tenantId))?.user.id).toBe(userId);

    // Single-use: the same token cannot be used again.
    const secondPeek = await peekResetToken(db, rawToken);
    expect(secondPeek.status).toBe('consumed');
    const secondConfirm = await confirmPasswordReset(db, { rawToken, newPassword: 'another-password-456' });
    expect(secondConfirm).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('confirmPasswordReset rejects a weak password without touching the token', async () => {
    await requestPasswordReset(db, { email: 'reset@example.com' });
    const notif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    const rawToken = new URL('http://x' + (notif.payload_json as { reset_path: string }).reset_path).searchParams.get('token')!;

    const result = await confirmPasswordReset(db, { rawToken, newPassword: 'x' });
    expect(result).toEqual({ ok: false, reason: 'weak_password' });
    expect((await peekResetToken(db, rawToken)).status).toBe('valid'); // untouched — still usable
  });

  test('invite-accept: issueInviteToken + confirmPasswordReset flips an invited user to active in one step', async () => {
    const invitedId = randomUUID();
    await db.insertInto('users').values({
      id: invitedId, tenant_id: tenantId, email: 'invited@example.com', name: 'Invitee', role: 'admin',
      password_hash: null, status: 'invited', created_at: new Date(),
    }).execute();
    const { rawToken } = await issueInviteToken(db, { tenantId, userId: invitedId });

    const peek = await peekResetToken(db, rawToken);
    expect(peek.status).toBe('valid');
    expect(peek.userStatus).toBe('invited');

    const result = await confirmPasswordReset(db, { rawToken, newPassword: 'first-real-password' });
    expect(result).toEqual({ ok: true, userId: invitedId, tenantId });

    const nowActive = await db.selectFrom('users').select('status').where('id', '=', invitedId).executeTakeFirstOrThrow();
    expect(nowActive.status).toBe('active');
  });

  test('billing-setup tokens are invisible to peekResetToken/confirmPasswordReset and survive a password reset for the same user', async () => {
    const { rawToken: billingToken } = await issueBillingSetupToken(db, { tenantId, userId });
    expect((await peekResetToken(db, billingToken)).status).toBe('invalid');
    expect((await confirmPasswordReset(db, { rawToken: billingToken, newPassword: 'whatever-123' }))).toEqual({ ok: false, reason: 'invalid_token' });

    // A real reset for the SAME user must not consume/invalidate the billing-setup token.
    await requestPasswordReset(db, { email: 'reset@example.com' });
    const notif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    const resetToken = new URL('http://x' + (notif.payload_json as { reset_path: string }).reset_path).searchParams.get('token')!;
    await confirmPasswordReset(db, { rawToken: resetToken, newPassword: 'yet-another-password' });

    const billingPeek = await resolveBillingSetupToken(db, billingToken);
    expect(billingPeek.status).toBe('valid'); // still valid — untouched by the unrelated password change
  });

  test('resolveBillingSetupToken reports expired once past its TTL', async () => {
    const { rawToken } = await issueBillingSetupToken(db, { tenantId, userId }, new Date(Date.now() - 91 * 24 * 3600 * 1000));
    const peek = await resolveBillingSetupToken(db, rawToken);
    expect(peek.status).toBe('expired');
  });
});
