// Phase 12 · Slice 5a.1 — the Stripe card-entry page (Node project).
// Covers: purpose-tagged token gating (billing_setup is mutually exclusive with reset/invite —
// a billing link must never touch a password, and vice versa), issueBillingSetupToken /
// resolveBillingSetupToken directly, and the /billing/setup page's dead-end branches (rendered
// by awaiting the async server component then handing the resulting element to
// react-dom/server — the happy "renders CardEntryForm" path is checked structurally, without
// executing CardEntryForm's internals, since that component calls the real Stripe.js loader
// which needs a browser environment this Node test project doesn't have).

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { renderToStaticMarkup } from 'react-dom/server';
import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import {
  issueBillingSetupToken,
  resolveBillingSetupToken,
  issueInviteToken,
  confirmPasswordReset,
  peekResetToken,
} from '@/lib/services/password-reset';
import { getRawDb, closeDb } from '@/lib/db/client';
import BillingSetupPage from '@/app/billing/setup/page';
import { CardEntryForm } from '@/app/billing/setup/CardEntryForm';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
  }
}

const NOW = new Date('2026-08-01T12:00:00.000Z');

// ── issueBillingSetupToken / resolveBillingSetupToken ────────────────────────────

describe('issueBillingSetupToken / resolveBillingSetupToken', () => {
  test('issues a purpose=billing_setup row; resolves to the tenant while valid', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const { rawToken } = issueBillingSetupToken(db, { tenantId: t.id, userId: admin.id }, NOW);

    const row = db.prepare('SELECT purpose, user_id FROM password_reset_tokens WHERE tenant_id = ?').get(t.id) as { purpose: string; user_id: string };
    expect(row.purpose).toBe('billing_setup');
    expect(row.user_id).toBe(admin.id);

    expect(resolveBillingSetupToken(db, rawToken, NOW)).toEqual({ status: 'valid', tenantId: t.id });
  });

  test('expired → status=expired', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const { rawToken } = issueBillingSetupToken(db, { tenantId: t.id, userId: admin.id }, NOW);
    const later = new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000); // past the ~90d TTL
    expect(resolveBillingSetupToken(db, rawToken, later)).toEqual({ status: 'expired' });
  });

  test('unknown/malformed token → invalid', () => {
    const db = setupTestDb();
    expect(resolveBillingSetupToken(db, 'not-a-real-token', NOW)).toEqual({ status: 'invalid' });
  });

  test('is revisitable — never marks consumed_at, so resolving it twice both succeed', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const { rawToken } = issueBillingSetupToken(db, { tenantId: t.id, userId: admin.id }, NOW);

    expect(resolveBillingSetupToken(db, rawToken, NOW).status).toBe('valid');
    expect(resolveBillingSetupToken(db, rawToken, NOW).status).toBe('valid'); // still valid — not single-use
    const row = db.prepare('SELECT consumed_at FROM password_reset_tokens WHERE tenant_id = ?').get(t.id) as { consumed_at: string | null };
    expect(row.consumed_at).toBeNull();
  });
});

// ── mutual exclusion: billing_setup vs reset/invite ──────────────────────────────

describe('token purpose is mutually exclusive — a billing link can never touch a password, and vice versa', () => {
  test('confirmPasswordReset rejects a billing_setup token outright', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    // status:'invited' is the override under test; the helper still seeds SOME password hash
    // regardless (it has no "truly credential-less" mode) — what matters is that a rejected
    // billing_setup attempt leaves that hash exactly as it was, not what its initial value is.
    const admin = seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    const before = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id) as { password_hash: string };
    const { rawToken } = issueBillingSetupToken(db, { tenantId: t.id, userId: admin.id }, NOW);

    const result = confirmPasswordReset(db, { rawToken, newPassword: 'a-new-password-1' }, NOW);
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    // The admin's credential state is untouched.
    const row = db.prepare('SELECT status, password_hash FROM users WHERE id = ?').get(admin.id) as { status: string; password_hash: string };
    expect(row.status).toBe('invited');
    expect(row.password_hash).toBe(before.password_hash);
  });

  test('peekResetToken (the /reset-password landing page) also rejects a billing_setup token', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const { rawToken } = issueBillingSetupToken(db, { tenantId: t.id, userId: admin.id }, NOW);
    expect(peekResetToken(db, rawToken, NOW)).toEqual({ status: 'invalid' });
  });

  test('resolveBillingSetupToken (the /billing/setup page) rejects an invite token', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    const { rawToken } = issueInviteToken(db, { tenantId: t.id, userId: admin.id }, NOW);
    expect(resolveBillingSetupToken(db, rawToken, NOW)).toEqual({ status: 'invalid' });
  });

  test('confirming a real reset/invite token does not disturb an outstanding billing_setup token for the same user', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    const { rawToken: billingToken } = issueBillingSetupToken(db, { tenantId: t.id, userId: admin.id }, NOW);
    const { rawToken: inviteToken } = issueInviteToken(db, { tenantId: t.id, userId: admin.id }, NOW);

    expect(confirmPasswordReset(db, { rawToken: inviteToken, newPassword: 'a-new-password-1' }, NOW).ok).toBe(true);

    // The bulk-invalidate that runs on confirm excludes purpose='billing_setup' by design.
    expect(resolveBillingSetupToken(db, billingToken, NOW).status).toBe('valid');
  });
});

// ── /billing/setup page ──────────────────────────────────────────────────────────
// BillingSetupPage is an async server component; await it directly to get the returned React
// element, then hand that (now-synchronous) element to react-dom/server. This avoids needing
// the RSC streaming renderer AND avoids invoking CardEntryForm's real Stripe.js loader (which
// only the "valid, not-yet-active" branch would reach) — that branch is checked structurally
// (element.type/props) instead of rendered, for the same reason.
//
// The page always uses the real defaultBillingProvider (NoOp under Jest, since no
// STRIPE_SECRET_KEY is set) — it doesn't accept an injected provider, same as the webhook
// route — so these tests seed the shared getRawDb() singleton directly rather than an isolated
// setupTestDb() instance.

describe('BillingSetupPage', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = getRawDb();
    migrate(db);
  });
  afterAll(() => closeDb());

  function seedProvisioningTenant(overrides: { lifecycleState?: string; adminStatus?: string } = {}) {
    const tenantId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, stripe_customer_id, stripe_setup_intent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tenantId, 'Structural Check Co', overrides.lifecycleState ?? 'provisioning', 9000, `cus_${tenantId}`, `seti_${tenantId}`, now);
    const adminId = randomUUID();
    db.prepare(
      'INSERT INTO users (id, tenant_id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(adminId, tenantId, `admin-${adminId}@structcheck.test`, 'Admin', 'admin', overrides.adminStatus ?? 'invited', now);
    const { rawToken } = issueBillingSetupToken(db, { tenantId, userId: adminId });
    return { tenantId, adminId, rawToken };
  }

  test('no token → generic invalid dead end', async () => {
    const element = await BillingSetupPage({ searchParams: {} });
    const html = renderToStaticMarkup(element);
    expect(html).toMatch(/isn.t valid/);
  });

  test('unknown token → generic invalid dead end', async () => {
    const element = await BillingSetupPage({ searchParams: { token: 'garbage' } });
    const html = renderToStaticMarkup(element);
    expect(html).toMatch(/isn.t valid/);
  });

  test('a valid token for a still-provisioning tenant returns a CardEntryForm element with the right props', async () => {
    const { rawToken } = seedProvisioningTenant();
    const element = await BillingSetupPage({ searchParams: { token: rawToken } });
    expect(element.type).toBe(CardEntryForm);
    expect(element.props).toMatchObject({ token: rawToken, tenantName: 'Structural Check Co' });
    expect(element.props.clientSecret).toBeTruthy();
  });

  test('an already-active tenant shows the "already set up" dead end, not the form', async () => {
    const { rawToken } = seedProvisioningTenant({ lifecycleState: 'active', adminStatus: 'active' });
    const element = await BillingSetupPage({ searchParams: { token: rawToken } });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('already set up');
    expect(element.type).not.toBe(CardEntryForm);
  });
});
