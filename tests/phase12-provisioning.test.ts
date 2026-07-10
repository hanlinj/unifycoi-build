// Phase 12 · Slice 3/4 — provisioning backend + billing-attach + wizard credential model.
// Proves the audited DB transaction (tenant + first Admin + locations + template + timezone),
// the DB-commit / Stripe-call boundary (partial-failure = recoverable, no orphan), atomic
// rollback, timezone required+stored (OPS-7 input), slug required+unique (Slice 4), the
// invite/deferred-credential admin (Slice 4), and the Stripe idempotency key.

import { setupTestDb, seedPlatformUser, seedTemplate } from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { provisionTenant, type ProvisionInput } from '@/lib/services/provisioning';
import { listTenants, getTenantById } from '@/lib/services/tenants';
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
    slug: 'storage-star',
    timezone: 'America/Los_Angeles',
    firstAdmin: { email: 'admin@storagestar.test', name: 'Avery Admin' },
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
  test('creates tenant (provisioning + timezone + slug) + invited first Admin + locations + template, all audited; billing attached', async () => {
    const { db, platform, tplId } = setup();
    const billing = new FakeBilling();
    const res = await provisionTenant(db, baseInput(tplId), platform.id, billing);

    // Tenant: provisioning state, timezone + slug stored (OPS-7 input + Slice 4 wired)
    const t = getTenantById(db, res.tenant.id)!;
    expect(t.lifecycle_state).toBe('provisioning');
    expect(t.slug).toBe('storage-star');
    const tzRow = db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(res.tenant.id) as { timezone: string };
    expect(tzRow.timezone).toBe('America/Los_Angeles');

    // First Admin: created INVITED, no password — the wizard never handles a password. An
    // invite token is minted immediately at provision time (Slice 4) and verifies.
    expect(res.adminUserId).toBeTruthy();
    const adminRow = db.prepare('SELECT status, password_hash FROM users WHERE id = ?').get(res.adminUserId) as {
      status: string;
      password_hash: string | null;
    };
    expect(adminRow.status).toBe('invited');
    expect(adminRow.password_hash).toBeNull();
    expect(res.invite.rawToken).toBeTruthy();
    expect(res.invite.inviteUrl).toContain(res.invite.rawToken);

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

describe('provisionTenant · validation (OPS-7 input + slug + billing guards)', () => {
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
  test('a malformed slug (uppercase/spaces) is rejected before any write', async () => {
    const { db, platform, tplId } = setup();
    await expect(provisionTenant(db, baseInput(tplId, { slug: 'Not A Slug' }), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 400 });
    expect(listTenants(db)).toHaveLength(0);
  });
  test('a missing slug is rejected', async () => {
    const { db, platform, tplId } = setup();
    await expect(provisionTenant(db, baseInput(tplId, { slug: '' }), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 400 });
  });
  test('a duplicate slug is rejected with 409, fails loud before any write (no half-written tenant)', async () => {
    const { db, platform, tplId } = setup();
    await provisionTenant(db, baseInput(tplId), platform.id, new FakeBilling());
    await expect(provisionTenant(db, baseInput(tplId, { name: 'Storage Star Two' }), platform.id, new FakeBilling())).rejects.toMatchObject({ status: 409 });
    expect(listTenants(db)).toHaveLength(1);
  });
});
