// Phase 11 · Slice 3 — Password reset (SEC-8). Hashed single-use token, enumeration-safe
// request that rides the real notification worker, confirm that rotates the password and
// invalidates outstanding tokens.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { generateResetToken, hashResetToken } from '@/lib/auth/reset-token';
import { requestPasswordReset, confirmPasswordReset } from '@/lib/services/password-reset';
import { NoOpMailer } from '@/lib/notifications/mailer';
import { processDueNotifications } from '@/lib/notifications/worker';
import { loginResolvingTenant } from '@/lib/services/auth';
import { getRawDb, closeDb } from '@/lib/db/client';

const NOW = new Date('2026-07-03T12:00:00.000Z');

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

function tokenRow(db: Database.Database, userId: string) {
  return db.prepare('SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at').all(userId) as {
    token_hash: string; consumed_at: string | null; expires_at: string;
  }[];
}

function rawTokenFromEmail(body: string): string {
  const m = body.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('no token in email body: ' + body);
  return m[1];
}

// ── token module ────────────────────────────────────────────────────────────────

describe('reset-token', () => {
  test('hash of the raw token matches the stored hash; hashing is deterministic hex', () => {
    const { rawToken, tokenHash } = generateResetToken();
    expect(hashResetToken(rawToken)).toBe(tokenHash);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(rawToken); // raw is never the stored value
  });
});

// ── request ───────────────────────────────────────────────────────────────────

describe('requestPasswordReset', () => {
  test('known email → stores a HASH (not the raw) + queues a password_reset notification', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { email: 'admin@acme.test', password: 'old-password-1' });
    requestPasswordReset(db, { email: 'admin@acme.test' }, NOW);

    const rows = tokenRow(db, u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].consumed_at).toBeNull();
    expect(new Date(rows[0].expires_at).getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);

    const notif = db.prepare(`SELECT payload_json FROM notifications WHERE recipient_ref = ?`).get(u.id) as { payload_json: string };
    const payload = JSON.parse(notif.payload_json);
    expect(payload.type).toBe('password_reset');
    // The raw token is in the link; its hash (not the raw) is what's stored for verification.
    expect(hashResetToken(rawTokenFromEmail(payload.reset_path))).toBe(rows[0].token_hash);
  });

  test('unknown email → no token, no notification (enumeration-safe no-op)', () => {
    const db = setupTestDb();
    seedTenant(db);
    requestPasswordReset(db, { email: 'nobody@nowhere.test' }, NOW);
    expect((db.prepare('SELECT COUNT(*) c FROM password_reset_tokens').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM notifications').get() as { c: number }).c).toBe(0);
  });

  test('disabled user → no token (mirrors login rejecting disabled accounts)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { email: 'gone@acme.test', password: 'x', status: 'disabled' });
    requestPasswordReset(db, { email: 'gone@acme.test' }, NOW);
    expect((db.prepare('SELECT COUNT(*) c FROM password_reset_tokens').get() as { c: number }).c).toBe(0);
  });
});

// ── round-trip through the REAL worker ──────────────────────────────────────────

describe('reset round-trip via the notification worker', () => {
  test('request → worker sends (internal From) → confirm → login with the new password', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    seedTenantUser(db, t.id, { email: 'admin@acme.test', password: 'old-password-1', role: 'admin' });

    requestPasswordReset(db, { email: 'admin@acme.test' }, NOW);

    // The reset email goes out through the Slice 1 worker path — not a bespoke send.
    const mailer = new NoOpMailer();
    const tick = await processDueNotifications(mailer, db, NOW);
    expect(tick.sent).toBe(1);
    const email = mailer.sent.find((m) => m.subject === 'Reset your password')!;
    expect(email.fromName).toBe('UnifyCOI'); // internal audience branding
    expect(email.to).toBe('admin@acme.test');

    const raw = rawTokenFromEmail(email.body);
    const res = confirmPasswordReset(db, { rawToken: raw, newPassword: 'brand-new-pass' }, NOW);
    expect(res.ok).toBe(true);

    expect(loginResolvingTenant(db, 'admin@acme.test', 'brand-new-pass')).not.toBeNull();
    expect(loginResolvingTenant(db, 'admin@acme.test', 'old-password-1')).toBeNull();
  });
});

// ── confirm guards ──────────────────────────────────────────────────────────────

describe('confirmPasswordReset guards', () => {
  function seedTokenFor(db: Database.Database) {
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { email: 'u@acme.test', password: 'old-password-1' });
    return { t, u };
  }

  test('a consumed token cannot be reused', () => {
    const db = setupTestDb();
    seedTokenFor(db);
    requestPasswordReset(db, { email: 'u@acme.test' }, NOW);
    const raw = rawTokenFromEmail(JSON.parse((db.prepare('SELECT payload_json FROM notifications').get() as { payload_json: string }).payload_json).reset_path);

    expect(confirmPasswordReset(db, { rawToken: raw, newPassword: 'new-password-1' }, NOW).ok).toBe(true);
    const second = confirmPasswordReset(db, { rawToken: raw, newPassword: 'another-pass-1' }, NOW);
    expect(second).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('an expired token is rejected', () => {
    const db = setupTestDb();
    seedTokenFor(db);
    requestPasswordReset(db, { email: 'u@acme.test' }, NOW);
    const raw = rawTokenFromEmail(JSON.parse((db.prepare('SELECT payload_json FROM notifications').get() as { payload_json: string }).payload_json).reset_path);
    const later = new Date(NOW.getTime() + 61 * 60 * 1000); // past the 1h TTL
    expect(confirmPasswordReset(db, { rawToken: raw, newPassword: 'new-password-1' }, later)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('confirming one token invalidates the user\'s other outstanding tokens', () => {
    const db = setupTestDb();
    const { u } = seedTokenFor(db);
    requestPasswordReset(db, { email: 'u@acme.test' }, NOW); // token A
    requestPasswordReset(db, { email: 'u@acme.test' }, NOW); // token B
    const notifs = db.prepare('SELECT payload_json FROM notifications ORDER BY created_at').all() as { payload_json: string }[];
    const rawA = rawTokenFromEmail(JSON.parse(notifs[0].payload_json).reset_path);
    const rawB = rawTokenFromEmail(JSON.parse(notifs[1].payload_json).reset_path);

    expect(confirmPasswordReset(db, { rawToken: rawA, newPassword: 'new-password-1' }, NOW).ok).toBe(true);
    // B was outstanding for the same user → now invalidated.
    expect(confirmPasswordReset(db, { rawToken: rawB, newPassword: 'yet-another-1' }, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(tokenRow(db, u.id).every((r) => r.consumed_at !== null)).toBe(true);
  });

  test('an unknown token is rejected; a too-short password is rejected before any lookup', () => {
    const db = setupTestDb();
    expect(confirmPasswordReset(db, { rawToken: 'not-a-real-token', newPassword: 'long-enough-1' }, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(confirmPasswordReset(db, { rawToken: 'whatever', newPassword: 'short' }, NOW)).toEqual({ ok: false, reason: 'weak_password' });
  });
});

// ── routes: enumeration parity + throttle + confirm ─────────────────────────────

describe('password-reset routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let requestPOST: (req: Request) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let confirmPOST: (req: Request) => Promise<any>;
  let db: Database.Database;

  beforeAll(() => {
    db = getRawDb();
    migrate(db);
    const t = seedTenant(db, { name: 'Route Co' });
    seedTenantUser(db, t.id, { email: 'known@route.test', password: 'old-password-1', role: 'admin' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    requestPOST = require('@/app/api/auth/password-reset/request/route').POST;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    confirmPOST = require('@/app/api/auth/password-reset/confirm/route').POST;
  });
  afterAll(() => closeDb());
  beforeEach(() => db.exec('DELETE FROM login_attempts'));

  function reqReset(email: string, ip: string): Promise<Response> {
    return requestPOST(new Request('http://t/api/auth/password-reset/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email }),
    }));
  }

  test('response is identical for a known vs unknown email (no enumeration)', async () => {
    const known = await reqReset('known@route.test', '100.65.0.1');
    const unknown = await reqReset('ghost@route.test', '100.65.0.2');
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  test('request shares the login throttle (6th request from one key → generic 429)', async () => {
    const ip = '100.65.0.3';
    for (let i = 0; i < 5; i++) expect((await reqReset('known@route.test', ip)).status).toBe(200);
    const blocked = await reqReset('known@route.test', ip);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe('Too many attempts. Please try again later.');
  });

  test('confirm route: 200 on a valid token, 400 on an invalid one, 422 on a short password', async () => {
    // Issue a real token via the request path, then read it from the queued notification.
    await reqReset('known@route.test', '100.65.0.4');
    const notif = db.prepare(`SELECT payload_json FROM notifications ORDER BY created_at DESC LIMIT 1`).get() as { payload_json: string };
    const raw = rawTokenFromEmail(JSON.parse(notif.payload_json).reset_path);

    const bad = await confirmPOST(new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'nope', password: 'long-enough-1' }) }));
    expect(bad.status).toBe(400);
    const short = await confirmPOST(new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw, password: 'short' }) }));
    expect(short.status).toBe(422);
    const good = await confirmPOST(new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw, password: 'brand-new-pass' }) }));
    expect(good.status).toBe(200);
  });
});
