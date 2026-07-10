// Phase 12 · Slice 4a — credential-set landing page backend (Node project).
// Covers peekResetToken's four states + userStatus/tenantName correctness, the password-policy
// extraction, the peek route (auth-free, malformed/missing token), and the deliberate
// divergence from confirmPasswordReset's collapsed reason (peek is more granular by design).

import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type Database from 'better-sqlite3';
import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { generateResetToken } from '@/lib/auth/reset-token';
import { peekResetToken, issueInviteToken, confirmPasswordReset } from '@/lib/services/password-reset';
import { isPasswordValid, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy';
import { getRawDb, closeDb } from '@/lib/db/client';
import ResetPasswordPage from '@/app/reset-password/page';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

function insertToken(
  db: Database.Database,
  opts: { tenantId: string; userId: string; expiresAt: string; consumedAt?: string | null }
): string {
  const { rawToken, tokenHash } = generateResetToken();
  db.prepare(
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('tok-' + Math.random(), opts.tenantId, opts.userId, tokenHash, opts.expiresAt, opts.consumedAt ?? null, NOW.toISOString());
  return rawToken;
}

// ── password-policy ──────────────────────────────────────────────────────────

describe('password-policy', () => {
  test.each([
    ['', false],
    ['short', false],
    ['exactly8', true],
    ['a-much-longer-password', true],
  ])('isPasswordValid(%s) → %s', (pw, expected) => {
    expect(isPasswordValid(pw)).toBe(expected);
  });
  test('MIN_PASSWORD_LENGTH is 8 (matches the pre-existing Phase 11 rule)', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
});

// ── peekResetToken ────────────────────────────────────────────────────────────

describe('peekResetToken', () => {
  test('unknown/malformed token → invalid', () => {
    const db = setupTestDb();
    expect(peekResetToken(db, 'not-a-real-token', NOW)).toEqual({ status: 'invalid' });
  });

  test('valid + invited user → status=valid, userStatus=invited, tenantName present', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage' });
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const { rawToken } = issueInviteToken(db, { tenantId: t.id, userId: u.id }, NOW);

    expect(peekResetToken(db, rawToken, NOW)).toEqual({
      status: 'valid', userId: u.id, tenantId: t.id, userStatus: 'invited', tenantName: 'Acme Storage',
    });
  });

  test('valid + already-active user (ordinary reset) → status=valid, userStatus=active', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage' });
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const raw = insertToken(db, { tenantId: t.id, userId: u.id, expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() });

    expect(peekResetToken(db, raw, NOW)).toMatchObject({ status: 'valid', userStatus: 'active', tenantName: 'Acme Storage' });
  });

  test('expired + invited user → status=expired, userStatus preserved for copy branching', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage' });
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const raw = insertToken(db, { tenantId: t.id, userId: u.id, expiresAt: new Date(NOW.getTime() - 1000).toISOString() });

    expect(peekResetToken(db, raw, NOW)).toMatchObject({ status: 'expired', userStatus: 'invited', tenantName: 'Acme Storage' });
  });

  test('expired + active user → status=expired, userStatus=active', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage' });
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const raw = insertToken(db, { tenantId: t.id, userId: u.id, expiresAt: new Date(NOW.getTime() - 1000).toISOString() });

    expect(peekResetToken(db, raw, NOW)).toMatchObject({ status: 'expired', userStatus: 'active' });
  });

  test('consumed (already used) → status=consumed, regardless of expiry', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage' });
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const raw = insertToken(db, {
      tenantId: t.id, userId: u.id,
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), // not expired
      consumedAt: NOW.toISOString(),
    });

    expect(peekResetToken(db, raw, NOW)).toMatchObject({ status: 'consumed' });
  });

  test('consumed takes precedence over expired when both are true', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id);
    const raw = insertToken(db, {
      tenantId: t.id, userId: u.id,
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(), // expired
      consumedAt: NOW.toISOString(), // AND consumed
    });
    expect(peekResetToken(db, raw, NOW).status).toBe('consumed');
  });

  test('is a strictly finer-grained read than confirmPasswordReset, which collapses all three failure modes', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const expiredRaw = insertToken(db, { tenantId: t.id, userId: u.id, expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    const consumedRaw = insertToken(db, { tenantId: t.id, userId: u.id, expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), consumedAt: NOW.toISOString() });

    // peek distinguishes them...
    expect(peekResetToken(db, expiredRaw, NOW).status).toBe('expired');
    expect(peekResetToken(db, consumedRaw, NOW).status).toBe('consumed');
    // ...confirm does not — both collapse to the same generic reason (pre-existing, by design).
    expect(confirmPasswordReset(db, { rawToken: expiredRaw, newPassword: 'new-password-1' }, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(confirmPasswordReset(db, { rawToken: consumedRaw, newPassword: 'new-password-1' }, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
  });
});

// ── peek route ────────────────────────────────────────────────────────────────

describe('GET /api/auth/password-reset/peek', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let peekGET: (req: Request) => Promise<any>;
  let db: Database.Database;

  beforeAll(() => {
    db = getRawDb();
    migrate(db);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    peekGET = require('@/app/api/auth/password-reset/peek/route').GET;
  });
  afterAll(() => closeDb());

  test('missing token → 400', async () => {
    const res = await peekGET(new Request('http://t/api/auth/password-reset/peek'));
    expect(res.status).toBe(400);
  });

  test('unknown token → 200, {status: "invalid"} (no auth required — cookie-less, like confirm/request)', async () => {
    const res = await peekGET(new Request('http://t/api/auth/password-reset/peek?token=garbage'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: 'invalid' });
  });

  test('a real, live invite token peeks as valid+invited with the tenant name', async () => {
    const t = seedTenant(db, { name: 'Route Peek Co' });
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const { rawToken } = issueInviteToken(db, { tenantId: t.id, userId: u.id });

    const res = await peekGET(new Request(`http://t/api/auth/password-reset/peek?token=${rawToken}`));
    const body = (await res.json()).data;
    expect(body.status).toBe('valid');
    expect(body.userStatus).toBe('invited');
    expect(body.tenantName).toBe('Route Peek Co');
  });
});

// ── ResetPasswordPage branching (server component, rendered against a real DB) ──

describe('ResetPasswordPage · branch selection', () => {
  let db: Database.Database;
  beforeAll(() => { db = getRawDb(); migrate(db); });
  afterAll(() => closeDb());

  function render(token?: string): string {
    return renderToStaticMarkup(React.createElement(ResetPasswordPage, { searchParams: { token } }));
  }

  test('no token → the generic "isn\'t valid" dead end, no password field', () => {
    const html = render(undefined);
    expect(html).toContain('isn');
    expect(html).toContain('valid');
    expect(html).not.toContain('type="password"');
  });

  test('unknown token → generic invalid dead end', () => {
    const html = render('totally-made-up');
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/isn.t valid/);
  });

  test('invited + expired → "contact whoever sent your invite", no form, no request-link button', () => {
    const t = seedTenant(db, { name: 'Expired Invite Co' });
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const { rawToken, tokenHash } = generateResetToken();
    db.prepare(
      `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
       VALUES ('tok-inv-exp', ?, ?, ?, ?, NULL, ?)`
    ).run(t.id, u.id, tokenHash, new Date(Date.now() - 1000).toISOString(), new Date().toISOString());

    const html = render(rawToken);
    expect(html).toContain('has expired');
    expect(html).toContain('Contact whoever sent your invite');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('Email me a new link');
  });

  test('active + expired → request-new-link form is present', () => {
    const t = seedTenant(db, { name: 'Expired Reset Co' });
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const { rawToken, tokenHash } = generateResetToken();
    db.prepare(
      `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
       VALUES ('tok-act-exp', ?, ?, ?, ?, NULL, ?)`
    ).run(t.id, u.id, tokenHash, new Date(Date.now() - 1000).toISOString(), new Date().toISOString());

    const html = render(rawToken);
    expect(html).toContain('has expired');
    expect(html).toContain('Email me a new link');
    expect(html).not.toContain('type="password"');
  });

  test('consumed → "already been used", sign-in link, no form', () => {
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const { rawToken, tokenHash } = generateResetToken();
    db.prepare(
      `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
       VALUES ('tok-consumed', ?, ?, ?, ?, ?, ?)`
    ).run(t.id, u.id, tokenHash, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString(), new Date().toISOString());

    const html = render(rawToken);
    expect(html).toContain('already been used');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('type="password"');
  });

  test('valid + invited → renders the credential-set form, welcome copy with tenant name', () => {
    const t = seedTenant(db, { name: 'Fresh Invite Co' });
    const u = seedTenantUser(db, t.id, { status: 'invited' });
    const { rawToken } = issueInviteToken(db, { tenantId: t.id, userId: u.id });

    const html = render(rawToken);
    expect(html).toContain('type="password"');
    expect(html).toContain('Fresh Invite Co');
    expect(html).toContain('Activate account');
  });

  test('valid + active → renders the credential-set form, reset copy (no "Welcome")', () => {
    const t = seedTenant(db, { name: 'Fresh Reset Co' });
    const u = seedTenantUser(db, t.id, { status: 'active' });
    const { rawToken, tokenHash } = generateResetToken();
    db.prepare(
      `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
       VALUES ('tok-valid-active', ?, ?, ?, ?, NULL, ?)`
    ).run(t.id, u.id, tokenHash, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());

    const html = render(rawToken);
    expect(html).toContain('type="password"');
    expect(html).toContain('Set a new password');
    expect(html).not.toContain('Welcome');
    expect(html).toContain('Set password');
  });
});
