// Phase 12 · Slice 3 — provisioning backend + billing-attach. Node project.
// Proves the audited DB transaction (tenant + first Admin + locations + template + timezone),
// the DB-commit / Stripe-call boundary (partial-failure = recoverable, no orphan), atomic
// rollback, timezone required+stored (OPS-7 input), and the Stripe idempotency key.

import { setupTestDb, seedPlatformUser, seedTemplate } from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { provisionTenant, type ProvisionInput } from '@/lib/services/provisioning';
import { listTenants, getTenantById } from '@/lib/services/tenants';
import { loginResolvingTenant } from '@/lib/services/auth';
import * as locationsSvc from '@/lib/services/locations';
import type { BillingProvider } from '@/lib/billing/provider';

class FakeBilling implements BillingProvider {
  calls: { tenantId: string; idempotencyKey: string }[] = [];
  failCreate = false;
  async createCustomer(input: { tenantId: string; idempotencyKey: string }) {
    this.calls.push(input);
    if (this.failCreate) throw new Error('stripe unavailable');
    return { customerId: `cus_${input.tenantId}` };
  }
  async createSetupIntent(input: { customerId: string }) {
    return { setupIntentId: `seti_${input.customerId}`, clientSecret: `seti_${input.customerId}_secret` };
  }
}

function baseInput(templateId: string, over: Partial<ProvisionInput> = {}): ProvisionInput {
  return {
    name: 'Storage Star',
    timezone: 'America/Los_Angeles',
    firstAdmin: { email: 'admin@storagestar.test', name: 'Avery Admin', password: 'correct-horse-1' },
    locations: [{ name: 'Main St' }, { name: 'Oak Ave', address: '2 Oak' }],
    templateId,
    ...over,
  };
}

function setup() {
  const db = setupTestDb();
  const platform = seedPlatformUser(db);
  const tpl = seedTemplate(db, { name: 'Standard' });
  return { db, platform, tplId: tpl.id };
}

afterEach(() => jest.restoreAllMocks());

describe('provisionTenant · happy path', () => {
  test('creates tenant (provisioning + timezone) + first Admin + locations + template, all audited; billing attached', async () => {
    const { db, platform, tplId } = setup();
    const billing = new FakeBilling();
    const res = await provisionTenant(db, baseInput(tplId), platform.id, billing);

    // Tenant: provisioning state, timezone stored (OPS-7 input wired)
    const t = getTenantById(db, res.tenant.id)!;
    expect(t.lifecycle_state).toBe('provisioning');
    const tzRow = db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(res.tenant.id) as { timezone: string };
    expect(tzRow.timezone).toBe('America/Los_Angeles');

    // First Admin: active + can log in (created WITH a password)
    expect(res.adminUserId).toBeTruthy();
    expect(loginResolvingTenant(db, 'admin@storagestar.test', 'correct-horse-1')).not.toBeNull();

    // Locations + template applied
    expect(res.locationIds).toHaveLength(2);
    const tdb = new TenantDB(db, res.tenant.id);
    expect(tdb.all(`SELECT id FROM locations WHERE tenant_id = ?`)).toHaveLength(2);
    expect((tdb.all(`SELECT id FROM requirement_rules WHERE tenant_id = ?`)).length).toBeGreaterThan(0);

    // Billing attached (NoOp/fake success) — customer id stored + setup-intent secret returned
    expect(res.billing).toMatchObject({ attached: true, customerId: `cus_${res.tenant.id}` });
    expect(res.billing.setupIntentClientSecret).toBeTruthy();
    expect((db.prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?').get(res.tenant.id) as { stripe_customer_id: string }).stripe_customer_id).toBe(`cus_${res.tenant.id}`);

    // Audit: platform-attributed provisioning + billing-attach
    const events = (tdb.all(`SELECT event_type FROM audit_events WHERE tenant_id = ?`) as { event_type: string }[]).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['tenant.created', 'user.created', 'location.created', 'tenant.provisioned', 'billing.customer_attached']));
  });

  test('passes the Stripe idempotency key provision:<tenantId> (retry reuses the customer)', async () => {
    const { db, platform, tplId } = setup();
    const billing = new FakeBilling();
    const res = await provisionTenant(db, baseInput(tplId), platform.id, billing);
    expect(billing.calls[0].idempotencyKey).toBe(`provision:${res.tenant.id}`);
  });
});

describe('provisionTenant · DB-commit / Stripe boundary (load-bearing)', () => {
  test('Stripe failure AFTER commit → tenant + admin + locations + template survive; no customer; recoverable, no orphan', async () => {
    const { db, platform, tplId } = setup();
    const billing = new FakeBilling();
    billing.failCreate = true; // Stripe down at the attach step

    const res = await provisionTenant(db, baseInput(tplId), platform.id, billing);

    // The core committed — the tenant is NOT orphaned/rolled back
    const t = getTenantById(db, res.tenant.id)!;
    expect(t.lifecycle_state).toBe('provisioning');
    expect(res.adminUserId).toBeTruthy();
    expect(res.locationIds).toHaveLength(2);

    // But billing did NOT attach: no customer id, flagged — recoverable + non-billable
    expect(res.billing).toMatchObject({ attached: false, customerId: null });
    expect(res.billing.error).toContain('stripe');
    expect((db.prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?').get(res.tenant.id) as { stripe_customer_id: string | null }).stripe_customer_id).toBeNull();
    // The Stripe customer was only attempted AFTER the tenant existed → no customer-without-tenant.
    expect(billing.calls[0].tenantId).toBe(res.tenant.id);
  });
});

describe('provisionTenant · atomic rollback', () => {
  test('a failure mid-transaction rolls back the WHOLE core (no partial tenant)', async () => {
    const { db, platform, tplId } = setup();
    // Make the second location insert throw, mid-transaction, after the tenant + admin + first location.
    let n = 0;
    jest.spyOn(locationsSvc, 'createLocation').mockImplementation(() => { if (++n === 2) throw new Error('boom'); return { id: `loc${n}` } as never; });

    await expect(provisionTenant(db, baseInput(tplId), platform.id, new FakeBilling())).rejects.toThrow('boom');

    // Everything rolled back — no tenant, no user committed.
    expect(listTenants(db)).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(0);
  });
});

describe('provisionTenant · validation (OPS-7 input + guards)', () => {
  test('an invalid timezone is rejected before any write', async () => {
    const { db, platform, tplId } = setup();
    await expect(provisionTenant(db, baseInput(tplId, { timezone: 'Not/AZone' }), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 400 });
    expect(listTenants(db)).toHaveLength(0);
  });
  test('a missing timezone is rejected (timezone is REQUIRED at provisioning)', async () => {
    const { db, platform, tplId } = setup();
    await expect(provisionTenant(db, baseInput(tplId, { timezone: '' }), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 400 });
  });
  test('an unknown template is rejected', async () => {
    const { db, platform } = setup();
    await expect(provisionTenant(db, baseInput('nope-template'), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 400 });
  });
  test('a weak first-admin password is rejected', async () => {
    const { db, platform, tplId } = setup();
    await expect(provisionTenant(db, baseInput(tplId, { firstAdmin: { email: 'a@b.test', name: 'A', password: 'short' } }), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 400 });
  });
});
