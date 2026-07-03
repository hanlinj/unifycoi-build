// Phase 11 · Slice 4 — CSRF + route-guard middleware (SEC-12). Drives the edge middleware
// against real request shapes: cross-site rejected, same-origin/Bearer/cookie-less passed,
// login enforced, Origin fallback, and the /api/* GET pass-through (no redirect).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';
import { seedTenant, seedTenantUser, seedVendor, seedInvite } from './helpers';

function req(
  url: string,
  opts: { method?: string; cookie?: boolean; sfs?: string; origin?: string; bearer?: boolean } = {}
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers['cookie'] = 'uc_session=abc';
  if (opts.sfs) headers['sec-fetch-site'] = opts.sfs;
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.bearer) headers['authorization'] = 'Bearer token.jwt.here';
  return new NextRequest(url, { method: opts.method ?? 'GET', headers });
}

const isForbidden = (res: { status: number }) => res.status === 403;
const isRedirect = (res: { status: number; headers: Headers }) => res.status === 307 && !!res.headers.get('location');
const isPassThrough = (res: { status: number; headers: Headers }) => res.status !== 403 && !res.headers.get('location');

// ── CSRF enforcement on cookie-authed mutations ──────────────────────────────────

describe('CSRF · cookie-authed mutations', () => {
  const path = 'http://t/api/vendors/invite';

  test('cross-site POST is rejected (403)', () => {
    expect(isForbidden(middleware(req(path, { method: 'POST', cookie: true, sfs: 'cross-site' })))).toBe(true);
  });

  test('same-origin POST passes', () => {
    expect(isPassThrough(middleware(req(path, { method: 'POST', cookie: true, sfs: 'same-origin' })))).toBe(true);
  });

  test('same-site and none pass (only cross-site is rejected per SEC-12)', () => {
    expect(isPassThrough(middleware(req(path, { method: 'POST', cookie: true, sfs: 'same-site' })))).toBe(true);
    expect(isPassThrough(middleware(req(path, { method: 'POST', cookie: true, sfs: 'none' })))).toBe(true);
  });

  test('all mutating verbs are covered', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isForbidden(middleware(req(path, { method: m, cookie: true, sfs: 'cross-site' })))).toBe(true);
    }
  });
});

// ── Origin fallback (no Sec-Fetch-Site) ───────────────────────────────────────────

describe('CSRF · Origin fallback when Sec-Fetch-Site is absent', () => {
  const path = 'http://t/api/vendors/invite';
  const OLD = process.env['ALLOWED_ORIGINS'];
  beforeAll(() => { process.env['ALLOWED_ORIGINS'] = 'http://localhost:3000,https://app.example.com'; });
  afterAll(() => { if (OLD === undefined) delete process.env['ALLOWED_ORIGINS']; else process.env['ALLOWED_ORIGINS'] = OLD; });

  test('an allowed Origin passes', () => {
    expect(isPassThrough(middleware(req(path, { method: 'POST', cookie: true, origin: 'https://app.example.com' })))).toBe(true);
  });
  test('a disallowed Origin is rejected', () => {
    expect(isForbidden(middleware(req(path, { method: 'POST', cookie: true, origin: 'https://evil.example' })))).toBe(true);
  });
  test('BOTH signals absent on a cookie-authed mutation → rejected', () => {
    expect(isForbidden(middleware(req(path, { method: 'POST', cookie: true })))).toBe(true);
  });
});

// ── Exemptions (each one) ─────────────────────────────────────────────────────────

describe('CSRF · exemptions', () => {
  test('Bearer-authed mutation is unaffected even when cross-site', () => {
    expect(isPassThrough(middleware(req('http://t/api/vendors/invite', { method: 'POST', bearer: true, sfs: 'cross-site' })))).toBe(true);
  });

  test('cookie-less /api/webhooks/* is exempt (signature-verified, no cookie)', () => {
    expect(isPassThrough(middleware(req('http://t/api/webhooks/resend', { method: 'POST', sfs: 'cross-site' })))).toBe(true);
  });

  test('cookie-less vendor submit/upload (/api/v/[token]) is exempt (token in URL path)', () => {
    expect(isPassThrough(middleware(req('http://t/api/v/rawtoken/submit', { method: 'POST', sfs: 'cross-site' })))).toBe(true);
    expect(isPassThrough(middleware(req('http://t/api/v/rawtoken/documents', { method: 'POST', sfs: 'cross-site' })))).toBe(true);
  });

  test('cookie-less password-reset request/confirm are exempt (not cookie-authed, not login)', () => {
    expect(isPassThrough(middleware(req('http://t/api/auth/password-reset/request', { method: 'POST', sfs: 'cross-site' })))).toBe(true);
    expect(isPassThrough(middleware(req('http://t/api/auth/password-reset/confirm', { method: 'POST', sfs: 'cross-site' })))).toBe(true);
  });
});

// ── Login is NOT exempt (cookie-SETTING) ──────────────────────────────────────────

describe('CSRF · login is enforced even without a prior cookie', () => {
  const path = 'http://t/api/auth/login';
  test('cross-site login (no cookie yet) is rejected', () => {
    expect(isForbidden(middleware(req(path, { method: 'POST', sfs: 'cross-site' })))).toBe(true);
  });
  test('same-origin login passes', () => {
    expect(isPassThrough(middleware(req(path, { method: 'POST', sfs: 'same-origin' })))).toBe(true);
  });
});

// ── /api/* GET pass-through: no redirect, handler owns its own 401/403 (kickoff proof #1) ─

describe('route guard · /api/* is pass-through, never redirected', () => {
  test('unauthenticated GET /api/* passes through (NOT a redirect to /login)', () => {
    const res = middleware(req('http://t/api/search', { method: 'GET' })); // no cookie
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('location')).toBeNull();
    expect(isPassThrough(res)).toBe(true);
  });

  test('GET /api/* mutation-less is never CSRF-checked even when cross-site + cookie-authed', () => {
    expect(isPassThrough(middleware(req('http://t/api/search', { method: 'GET', cookie: true, sfs: 'cross-site' })))).toBe(true);
  });

  test('page route without a cookie still redirects to /login (guard unchanged)', () => {
    expect(isRedirect(middleware(req('http://t/dashboard', { method: 'GET' })))).toBe(true);
  });
});

// ── End-to-end: middleware passes → the REAL handler runs (kickoff proof #2) ──────
// Not just an exemption-table assertion: a cross-site request is run through the middleware
// (pass-through), then the real route handler is invoked against a seeded getRawDb singleton.

function migrateInto(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function svixSign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

describe('end-to-end: middleware passes, real handler runs (vendor submit + Resend webhook)', () => {
  const SECRET = 'whsec_' + Buffer.from('csrf-e2e-secret').toString('base64');
  let db: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let submitPOST: (req: Request, ctx: { params: { token: string } }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let webhookPOST: (req: Request) => Promise<any>;
  let rawToken: string;

  beforeAll(() => {
    process.env['RESEND_WEBHOOK_SECRET'] = SECRET;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRawDb } = require('@/lib/db/client');
    db = getRawDb();
    migrateInto(db);

    const t = seedTenant(db, { name: 'E2E Co' });
    const inviter = seedTenantUser(db, t.id, { email: 'admin@e2e.test', role: 'admin' });
    const v = seedVendor(db, t.id, { contact_email: 'vendor@e2e.test' });
    rawToken = seedInvite(db, t.id, { vendorId: v.id, inviterUserId: inviter.id, purpose: 'onboarding' }).rawToken;
    // A sent notification for the webhook to bounce.
    db.prepare(
      `INSERT INTO notifications (id, tenant_id, recipient_type, recipient_ref, channel, kind, status, scheduled_for, sent_at, payload_json, document_id, claimed_at, created_at, provider_message_id)
       VALUES (?, ?, 'vendor', ?, 'email', 'exception', 'sent', NULL, ?, ?, NULL, NULL, ?, ?)`
    ).run(crypto.randomUUID(), t.id, 'vendor@e2e.test', '2026-07-03T00:00:00Z', JSON.stringify({ type: 'vendor_invite' }), '2026-07-03T00:00:00Z', 'pm_e2e');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    submitPOST = require('@/app/api/v/[token]/submit/route').POST;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    webhookPOST = require('@/app/api/webhooks/resend/route').POST;
  });
  afterAll(() => {
    delete process.env['RESEND_WEBHOOK_SECRET'];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('@/lib/db/client').closeDb();
  });

  test('cross-site vendor submit: middleware passes, real handler applies its OWN logic (422 missing docs)', async () => {
    // Middleware sees a cookie-less cross-site vendor POST → pass-through (token in URL path).
    expect(isPassThrough(middleware(req(`http://t/api/v/${rawToken}/submit`, { method: 'POST', sfs: 'cross-site' })))).toBe(true);
    // The real handler runs — 422 (docs missing), its own logic, NOT a middleware block.
    const res = await submitPOST(new Request(`http://t/api/v/${rawToken}/submit`, { method: 'POST' }), { params: { token: rawToken } });
    expect(res.status).toBe(422);
    expect((await res.json()).missing).toEqual(expect.arrayContaining(['coi', 'w9', 'ach']));
  });

  test('cross-site Resend webhook: middleware passes, real handler verifies signature + applies the bounce', async () => {
    expect(isPassThrough(middleware(req('http://t/api/webhooks/resend', { method: 'POST', sfs: 'cross-site' })))).toBe(true);
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'pm_e2e' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await webhookPOST(new Request('http://t/api/webhooks/resend', { method: 'POST', headers: { 'svix-id': 'e2e', 'svix-timestamp': ts, 'svix-signature': svixSign(SECRET, 'e2e', ts, body) }, body }));
    expect(res.status).toBe(200);
    expect((db.prepare(`SELECT status FROM notifications WHERE provider_message_id = 'pm_e2e'`).get() as { status: string }).status).toBe('bounced');
  });
});
