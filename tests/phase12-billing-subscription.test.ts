// Phase 12 · Slice 5a — automatic per-location billing & activation (Node project).
// Covers: activateTenantOnFirstPayment (idempotent activation + invite issuance), the
// invoice.paid webhook's gating logic (billing_reason, customer resolution, idempotent
// redelivery), the quantity-sync worker driven off the REAL trigger (a billing_snapshots write
// from createLocation/updateLocation — no new hook added, see quantity-sync.ts), and the
// webhook route's signature verification.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import Stripe from 'stripe';
import { setupTestDb, seedTenant, seedTenantUser, seedLocation } from './helpers';
import { activateTenantOnFirstPayment } from '@/lib/services/provisioning';
import { handleStripeEvent } from '@/lib/billing/stripe-webhook';
import { syncBillingQuantities } from '@/lib/billing/quantity-sync';
import { createLocation, updateLocation } from '@/lib/services/locations';
import type { BillingProvider } from '@/lib/billing/provider';
import { getRawDb, closeDb } from '@/lib/db/client';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

function setStripeIds(db: Database.Database, tenantId: string, customerId: string | null, subscriptionId: string | null): void {
  db.prepare('UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?').run(customerId, subscriptionId, tenantId);
}

class RecordingBilling implements BillingProvider {
  quantityCalls: { subscriptionId: string; quantity: number }[] = [];
  async createCustomer() { return { customerId: 'cus_x' }; }
  async createSetupIntent() { return { setupIntentId: 'seti_x', clientSecret: 'secret_x' }; }
  async createSubscription() { return { subscriptionId: 'sub_x' }; }
  async updateSubscriptionQuantity(input: { subscriptionId: string; quantity: number }) {
    this.quantityCalls.push(input);
  }
  async retrieveSetupIntent(input: { setupIntentId: string }) {
    return { clientSecret: `${input.setupIntentId}_secret`, status: 'requires_payment_method', paymentMethodId: null };
  }
  async finalizeCardSetup() {
    return { paid: true };
  }
}

// ── activateTenantOnFirstPayment ─────────────────────────────────────────────────

describe('activateTenantOnFirstPayment', () => {
  test('activates a provisioning tenant, issues the invite, logs both audit events', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage', lifecycle_state: 'provisioning' });
    const admin = seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });

    const result = activateTenantOnFirstPayment(db, t.id, NOW);
    expect(result).not.toBeNull();
    expect(result!.adminUserId).toBe(admin.id);
    expect(result!.invite.rawToken).toBeTruthy();
    expect(result!.invite.inviteUrl).toContain(result!.invite.rawToken);

    const tenantRow = db.prepare('SELECT lifecycle_state FROM tenants WHERE id = ?').get(t.id) as { lifecycle_state: string };
    expect(tenantRow.lifecycle_state).toBe('active');

    const tokenRow = db.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?').get(admin.id) as { token_hash: string } | undefined;
    expect(tokenRow).toBeTruthy();
    expect(tokenRow!.token_hash).not.toBe(result!.invite.rawToken);

    const events = (db.prepare('SELECT event_type FROM audit_events WHERE tenant_id = ?').all(t.id) as { event_type: string }[]).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['tenant.lifecycle_changed', 'admin.invite_issued']));
  });

  test('idempotent: an already-active tenant is a no-op (no duplicate invite/activation)', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { lifecycle_state: 'provisioning' });
    const admin = seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });

    const first = activateTenantOnFirstPayment(db, t.id, NOW);
    expect(first).not.toBeNull();

    const second = activateTenantOnFirstPayment(db, t.id, NOW);
    expect(second).toBeNull();

    const tokenCount = (db.prepare('SELECT COUNT(*) c FROM password_reset_tokens WHERE user_id = ?').get(admin.id) as { c: number }).c;
    expect(tokenCount).toBe(1); // not 2
  });

  test('returns null for an unknown tenant', () => {
    const db = setupTestDb();
    expect(activateTenantOnFirstPayment(db, 'no-such-tenant', NOW)).toBeNull();
  });

  test('returns null (and does not throw) if the tenant somehow has no admin user', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { lifecycle_state: 'provisioning' });
    expect(activateTenantOnFirstPayment(db, t.id, NOW)).toBeNull();
  });
});

// ── handleStripeEvent (webhook gating logic) ─────────────────────────────────────

function invoicePaidEvent(customer: string, billingReason: string): Stripe.Event {
  return {
    type: 'invoice.paid',
    data: { object: { customer, billing_reason: billingReason } },
  } as unknown as Stripe.Event;
}

describe('handleStripeEvent', () => {
  test('invoice.paid + billing_reason=subscription_create + matching customer → activates the tenant', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { lifecycle_state: 'provisioning' });
    seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    setStripeIds(db, t.id, 'cus_123', 'sub_123');

    const result = handleStripeEvent(db, invoicePaidEvent('cus_123', 'subscription_create'));
    expect(result.handled).toBe(true);
    expect((db.prepare('SELECT lifecycle_state FROM tenants WHERE id = ?').get(t.id) as { lifecycle_state: string }).lifecycle_state).toBe('active');
  });

  test('a recurring renewal invoice (billing_reason=subscription_cycle) is ignored — no re-activation, no re-invite', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { lifecycle_state: 'active' }); // already active, as it would be by the time a renewal lands
    seedTenantUser(db, t.id, { role: 'admin', status: 'active' });
    setStripeIds(db, t.id, 'cus_456', 'sub_456');

    const result = handleStripeEvent(db, invoicePaidEvent('cus_456', 'subscription_cycle'));
    expect(result.handled).toBe(false);
    expect(result.reason).toContain('subscription_cycle');
  });

  test('an unrelated event type is ignored', () => {
    const db = setupTestDb();
    const result = handleStripeEvent(db, { type: 'customer.created', data: { object: {} } } as unknown as Stripe.Event);
    expect(result.handled).toBe(false);
  });

  test('an invoice for an unknown Stripe customer is ignored (no matching tenant)', () => {
    const db = setupTestDb();
    const result = handleStripeEvent(db, invoicePaidEvent('cus_nobody', 'subscription_create'));
    expect(result.handled).toBe(false);
    expect(result.reason).toContain('no tenant');
  });

  test('redelivery of the same invoice.paid event after activation is idempotent — no duplicate invite', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { lifecycle_state: 'provisioning' });
    const admin = seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    setStripeIds(db, t.id, 'cus_789', 'sub_789');

    const event = invoicePaidEvent('cus_789', 'subscription_create');
    expect(handleStripeEvent(db, event).handled).toBe(true);
    expect(handleStripeEvent(db, event).handled).toBe(false); // Stripe redelivers on anything but a 2xx

    const tokenCount = (db.prepare('SELECT COUNT(*) c FROM password_reset_tokens WHERE user_id = ?').get(admin.id) as { c: number }).c;
    expect(tokenCount).toBe(1);
  });
});

// ── syncBillingQuantities — driven off the REAL trigger (a billing_snapshots write) ──
//
// The trigger is the existing, unmodified recordBillingSnapshot() call inside
// createLocation/updateLocation — nothing new was added to those functions. These tests prove
// that write is actually sufficient: run the real location mutation, then run the worker.

describe('syncBillingQuantities', () => {
  function activatedTenant(db: Database.Database, subscriptionId = 'sub_abc') {
    const t = seedTenant(db);
    setStripeIds(db, t.id, 'cus_abc', subscriptionId);
    return t;
  }

  test('a real location ADD (createLocation) writes the triggering snapshot; the worker picks it up', async () => {
    const db = setupTestDb();
    const t = activatedTenant(db);
    const billing = new RecordingBilling();

    createLocation(db, t.id, { name: 'Main St' }, 'actor-1'); // the real trigger — no test-only hook

    const result = await syncBillingQuantities(db, billing, NOW);
    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(billing.quantityCalls).toEqual([{ subscriptionId: 'sub_abc', quantity: 1 }]);

    const unsyncedCount = (db.prepare('SELECT COUNT(*) c FROM billing_snapshots WHERE tenant_id = ? AND stripe_synced_at IS NULL').get(t.id) as { c: number }).c;
    expect(unsyncedCount).toBe(0);
  });

  test('a real location REMOVE (updateLocation → archived) decreases quantity via the same trigger', async () => {
    const db = setupTestDb();
    const t = activatedTenant(db);
    const billing = new RecordingBilling();
    const loc1 = createLocation(db, t.id, { name: 'Main St' }, 'actor-1');
    createLocation(db, t.id, { name: 'Oak Ave' }, 'actor-1');
    await syncBillingQuantities(db, billing, NOW); // settle the +2 first

    updateLocation(db, t.id, loc1.id, { status: 'archived' }, 'actor-1');
    const result = await syncBillingQuantities(db, billing, NOW);

    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(billing.quantityCalls[billing.quantityCalls.length - 1]).toEqual({ subscriptionId: 'sub_abc', quantity: 1 });
  });

  test('multiple location changes before a sync tick collapse into ONE call, using the latest quantity', async () => {
    const db = setupTestDb();
    const t = activatedTenant(db);
    const billing = new RecordingBilling();

    createLocation(db, t.id, { name: 'A' }, 'actor-1');
    createLocation(db, t.id, { name: 'B' }, 'actor-1');
    createLocation(db, t.id, { name: 'C' }, 'actor-1'); // 3 changed=1 rows queued, no sync yet

    const result = await syncBillingQuantities(db, billing, NOW);
    expect(result.synced).toBe(1); // one tenant, one call
    expect(billing.quantityCalls).toEqual([{ subscriptionId: 'sub_abc', quantity: 3 }]);
  });

  test('a tenant with no subscription yet (pre-activation) is never synced — no subscription to update', async () => {
    const db = setupTestDb();
    const t = seedTenant(db); // no stripe_subscription_id
    const billing = new RecordingBilling();
    createLocation(db, t.id, { name: 'Main St' }, 'actor-1');

    const result = await syncBillingQuantities(db, billing, NOW);
    expect(result).toEqual({ synced: 0, failed: 0 });
    expect(billing.quantityCalls).toHaveLength(0);
  });

  test('running the worker again with nothing new to sync makes zero calls', async () => {
    const db = setupTestDb();
    const t = activatedTenant(db);
    const billing = new RecordingBilling();
    createLocation(db, t.id, { name: 'Main St' }, 'actor-1');
    await syncBillingQuantities(db, billing, NOW);

    const second = await syncBillingQuantities(db, billing, NOW);
    expect(second).toEqual({ synced: 0, failed: 0 });
    expect(billing.quantityCalls).toHaveLength(1); // still just the one from the first tick
  });

  test('a provider failure is reported as failed, not thrown, and the row stays unsynced for the next tick', async () => {
    const db = setupTestDb();
    const t = activatedTenant(db);
    const billing = new RecordingBilling();
    billing.updateSubscriptionQuantity = async () => { throw new Error('stripe down'); };
    createLocation(db, t.id, { name: 'Main St' }, 'actor-1');

    const result = await syncBillingQuantities(db, billing, NOW);
    expect(result).toEqual({ synced: 0, failed: 1 });
    const unsyncedCount = (db.prepare('SELECT COUNT(*) c FROM billing_snapshots WHERE tenant_id = ? AND stripe_synced_at IS NULL').get(t.id) as { c: number }).c;
    expect(unsyncedCount).toBeGreaterThan(0); // still there for a retry on the next tick
  });
});

// ── webhook route: POST /api/webhooks/stripe ─────────────────────────────────────
// Fresh requires after configuring the secret, mirroring the Resend webhook route test's
// convention (tests/phase11-resend.test.ts) — env + the getRawDb singleton the route uses must
// be the ones seeded here.

describe('route /api/webhooks/stripe', () => {
  const SECRET = 'whsec_test_' + Buffer.from('route-secret').toString('hex');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let POST: (req: Request) => Promise<any>;
  let db: Database.Database;

  beforeAll(() => {
    process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRawDb: freshGetRawDb } = require('@/lib/db/client');
    db = freshGetRawDb();
    migrate(db);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    POST = require('@/app/api/webhooks/stripe/route').POST;
  });

  afterAll(() => {
    delete process.env['STRIPE_WEBHOOK_SECRET'];
    closeDb();
  });

  function sign(payload: string): string {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  }
  function req(body: string, headers: Record<string, string> = {}): Request {
    return new Request('http://t/api/webhooks/stripe', { method: 'POST', headers, body });
  }

  test('missing signature header → 400', async () => {
    const res = await POST(req(JSON.stringify({ type: 'ping' })));
    expect(res.status).toBe(400);
  });

  test('invalid signature → 400', async () => {
    const res = await POST(req(JSON.stringify({ type: 'ping' }), { 'stripe-signature': 't=1,v1=deadbeef' }));
    expect(res.status).toBe(400);
  });

  test('valid signature, an event this handler ignores → 200 handled:false', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'customer.created', data: { object: {} } });
    const res = await POST(req(payload, { 'stripe-signature': sign(payload) }));
    expect(res.status).toBe(200);
    expect((await res.json()).handled).toBe(false);
  });

  test('valid signature, invoice.paid/subscription_create for a real seeded tenant → 200 handled:true, tenant activated', async () => {
    const tenantId = 'route-tenant-1';
    db.prepare('INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, stripe_customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenantId, 'Route Webhook Co', 'provisioning', 9000, 'cus_route_1', new Date().toISOString());
    db.prepare('INSERT INTO users (id, tenant_id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('admin-route-1', tenantId, 'admin@routewebhook.test', 'Admin', 'admin', 'invited', new Date().toISOString());

    const payload = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { customer: 'cus_route_1', billing_reason: 'subscription_create' } } });
    const res = await POST(req(payload, { 'stripe-signature': sign(payload) }));
    expect(res.status).toBe(200);
    expect((await res.json()).handled).toBe(true);

    const tenantRow = db.prepare('SELECT lifecycle_state FROM tenants WHERE id = ?').get(tenantId) as { lifecycle_state: string };
    expect(tenantRow.lifecycle_state).toBe('active');
  });

  test('no STRIPE_WEBHOOK_SECRET configured → 503 (fails closed, never processes unverified payloads)', async () => {
    delete process.env['STRIPE_WEBHOOK_SECRET'];
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const unconfiguredPOST = require('@/app/api/webhooks/stripe/route').POST;
    const res = await unconfiguredPOST(req(JSON.stringify({ type: 'ping' })));
    expect(res.status).toBe(503);
    process.env['STRIPE_WEBHOOK_SECRET'] = SECRET; // restore for any later test in this describe
  });
});
