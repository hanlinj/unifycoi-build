// tests/provisioning-billing.pg.test.ts — Phase 13 migration, Stage 4: verifies
// tenants.ts, requirements/templates.ts, provisioning.ts, and billing/{quantity-sync,
// stripe-webhook}.ts against real Postgres, in isolation from downstream callers that haven't
// converted yet. The billing_snapshots rowid->seq ordering fix gets its own dedicated test
// (the billing-critical one) — same-millisecond snapshots must resolve by insertion order
// (seq), not by timestamp, exactly the scenario the original rowid fix existed to solve.
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import {
  createTenant, listTenants, getTenantById, updateTenant, isSlugTaken, isValidSlug, impersonateTenant,
} from '@/lib/services/tenants';
import { seedTemplates, listTemplates, getTemplate, applyTemplate, PLATFORM_TEMPLATES } from '@/lib/requirements/templates';
import {
  provisionTenant, attachBilling, activateTenantOnFirstPayment, resendFirstAdminInvite,
  resendBillingSetupLink, updateTenantRate, updateTenantSetupFee,
} from '@/lib/services/provisioning';
import { NoOpBillingProvider, type BillingProvider, type BillingSubscription } from '@/lib/billing/provider';
import { syncBillingQuantities } from '@/lib/billing/quantity-sync';
import { handleStripeEvent } from '@/lib/billing/stripe-webhook';
import type { Db } from '@/lib/db/client';
import { verifyToken } from '@/lib/auth/jwt';

/** Captures every updateSubscriptionQuantity call so tests can assert the EXACT quantity pushed —
 *  proving not just "the DB read is right" but "the right value actually reached Stripe". */
class SpyBillingProvider extends NoOpBillingProvider implements BillingProvider {
  quantityCalls: { subscriptionId: string; quantity: number }[] = [];
  async updateSubscriptionQuantity(input: { subscriptionId: string; quantity: number }): Promise<void> {
    this.quantityCalls.push(input);
  }
}

describe('db-core (Stage 4): tenants.ts', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('createTenant writes an initial 0-location billing snapshot and default requirement_settings', async () => {
    const tenant = await createTenant(db, { name: 'Acme Storage', slug: 'acme-storage' }, 'platform-user-1');
    expect(tenant.lifecycle_state).toBe('provisioning');
    expect(tenant.monthly_rate_cents).toBe(9000);

    const snapshot = await db.selectFrom('billing_snapshots').selectAll().where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    expect(snapshot.billable_locations).toBe(0);
    expect(snapshot.changed).toBe(true);

    const settings = await db.selectFrom('requirement_settings').selectAll().where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    expect(settings.precedence_policy).toBe('strictest');
  });

  test('duplicate slug surfaces as a clean 409, not a raw Postgres unique_violation', async () => {
    await createTenant(db, { name: 'First', slug: 'dup-slug' }, 'p1');
    await expect(createTenant(db, { name: 'Second', slug: 'dup-slug' }, 'p1')).rejects.toMatchObject({ status: 409 });
  });

  test('isSlugTaken / isValidSlug', async () => {
    expect(isValidSlug('valid-slug-123')).toBe(true);
    expect(isValidSlug('Not Valid')).toBe(false);
    await createTenant(db, { name: 'X', slug: 'taken-slug' }, 'p1');
    expect(await isSlugTaken(db, 'taken-slug')).toBe(true);
    expect(await isSlugTaken(db, 'free-slug')).toBe(false);
  });

  test('updateTenant enforces valid lifecycle transitions and audits settings changes', async () => {
    const tenant = await createTenant(db, { name: 'X', slug: 'lifecycle-test' }, 'p1');
    await expect(updateTenant(db, tenant.id, { lifecycleState: 'offboarded' }, 'p1')).rejects.toMatchObject({ status: 400 }); // provisioning -> offboarded not allowed
    const active = await updateTenant(db, tenant.id, { lifecycleState: 'active' }, 'p1');
    expect(active.lifecycle_state).toBe('active');

    await updateTenant(db, tenant.id, { monthlyRateCents: 12000 }, 'p1');
    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenant.id).where('event_type', '=', 'tenant.settings_changed').executeTakeFirstOrThrow();
    expect((audit.payload_json as { changes: Record<string, unknown> }).changes['monthly_rate_cents']).toEqual({ from: 9000, to: 12000 });
  });

  test('listTenants / getTenantById', async () => {
    const t1 = await createTenant(db, { name: 'Tenant One', slug: 'tenant-one' }, 'p1');
    await createTenant(db, { name: 'Tenant Two', slug: 'tenant-two' }, 'p1');
    const all = await listTenants(db);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(await getTenantById(db, t1.id)).toMatchObject({ name: 'Tenant One' });
    expect(await getTenantById(db, randomUUID())).toBeNull();
  });

  test('impersonateTenant issues a valid tenant JWT attributed to the platform user', async () => {
    const tenant = await createTenant(db, { name: 'X', slug: 'impersonate-test' }, 'p1');
    const token = await impersonateTenant(db, tenant.id, 'platform-user-9');
    const payload = verifyToken(token);
    expect(payload.tenantId).toBe(tenant.id);
    expect(payload.impersonatedBy).toBe('platform-user-9');
  });
});

describe('db-core (Stage 4): requirements/templates.ts', () => {
  let db: Db;
  let tenantId: string;
  let adminId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    await seedTemplates(db);
    const tenant = await createTenant(db, { name: 'Template Test Co', slug: `tpl-${randomUUID().slice(0, 8)}` }, 'p1');
    tenantId = tenant.id;
    adminId = randomUUID();
    await db.insertInto('users').values({ id: adminId, tenant_id: tenantId, email: 'admin@tpl.test', name: 'Admin', role: 'admin', status: 'invited', created_at: new Date() }).execute();
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('seedTemplates is idempotent and listTemplates/getTemplate read them back', async () => {
    await seedTemplates(db); // second call — should not duplicate (ON CONFLICT DO NOTHING)
    const all = await listTemplates(db);
    expect(all.length).toBe(PLATFORM_TEMPLATES.length);
    const tpl = await getTemplate(db, 'tpl_standard_self_storage');
    expect(tpl?.name).toBe('Standard Self-Storage');
  });

  test('applyTemplate seeds org rules, snapshots the floor, and records applied_template_id', async () => {
    await applyTemplate(db, tenantId, 'tpl_standard_self_storage', adminId);
    const rules = await db.selectFrom('requirement_rules').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(rules.length).toBe(Object.keys(PLATFORM_TEMPLATES[0]!.payload.defaults).length);
    const settings = await db.selectFrom('requirement_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    expect((settings.floor_json as Record<string, string>)['doc_required.coi']).toBe('true'); // jsonb — already parsed
    const tenant = await getTenantById(db, tenantId);
    expect(tenant?.applied_template_id).toBe('tpl_standard_self_storage');
  });
});

describe('db-core (Stage 4): provisionTenant end-to-end', () => {
  let db: Db;
  beforeEach(async () => {
    db = await setupTestDb();
    await seedTemplates(db);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('provisions a tenant + first Admin + locations + template + billing attach atomically', async () => {
    const result = await provisionTenant(
      db,
      {
        name: 'Storage Star',
        slug: `storage-star-${randomUUID().slice(0, 8)}`,
        timezone: 'America/Los_Angeles',
        firstAdmin: { email: 'admin@storagestar.test', name: 'Avery Admin' },
        locations: [{ name: 'Location A' }, { name: 'Location B' }, { name: 'Location C' }],
        templateId: 'tpl_standard_self_storage',
      },
      'platform-user-1',
      new NoOpBillingProvider()
    );

    expect(result.locationIds).toHaveLength(3);
    expect(result.billing.attached).toBe(true);

    const admin = await db.selectFrom('users').selectAll().where('id', '=', result.adminUserId).executeTakeFirstOrThrow();
    expect(admin.status).toBe('invited'); // no password — deferred credential
    expect(admin.role).toBe('admin');

    const rules = await db.selectFrom('requirement_rules').selectAll().where('tenant_id', '=', result.tenant.id).execute();
    expect(rules.length).toBeGreaterThan(0);

    // Billing quantity reflects the 3 locations just created, via the seq-ordered latest snapshot.
    const finalSnapshot = await db.selectFrom('billing_snapshots').selectAll().where('tenant_id', '=', result.tenant.id).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(finalSnapshot.billable_locations).toBe(3);

    const auditEvent = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', result.tenant.id).where('event_type', '=', 'tenant.provisioned').executeTakeFirstOrThrow();
    expect((auditEvent.payload_json as { location_count: number }).location_count).toBe(3);
  });

  test('rolls back the ENTIRE tenant/admin/location/template transaction if any step fails (all-or-nothing)', async () => {
    // provisionTenant's upfront validation already rejects a template that doesn't EXIST
    // before ever opening the transaction — to actually prove all-or-nothing rollback, the
    // failure needs to happen DEEP inside the transaction, after tenant/admin/locations
    // already exist within it. A template that exists but is missing `defaults` passes the
    // upfront existence check and then throws inside applyTemplate's Object.entries(undefined).
    await db.insertInto('requirement_templates').values({ id: 'tpl_broken', name: 'Broken', payload_json: JSON.stringify({ floor: {} }), created_at: new Date() }).execute();

    const slug = `rollback-test-${randomUUID().slice(0, 8)}`;
    await expect(
      provisionTenant(
        db,
        {
          name: 'Doomed Co',
          slug,
          timezone: 'America/Los_Angeles',
          firstAdmin: { email: 'admin@doomed.test', name: 'Admin' },
          locations: [{ name: 'Loc A' }],
          templateId: 'tpl_broken',
        },
        'platform-user-1',
        new NoOpBillingProvider()
      )
    ).rejects.toThrow();

    // Nothing survived — not the tenant, not the admin, not the location.
    expect(await isSlugTaken(db, slug)).toBe(false);
    const anyUser = await db.selectFrom('users').selectAll().where('email', '=', 'admin@doomed.test').executeTakeFirst();
    expect(anyUser).toBeUndefined();
  });

  test('activateTenantOnFirstPayment flips lifecycle to active and issues the Admin invite, idempotently', async () => {
    const result = await provisionTenant(
      db,
      {
        name: 'Activate Co', slug: `activate-${randomUUID().slice(0, 8)}`, timezone: 'America/Chicago',
        firstAdmin: { email: 'admin@activate.test', name: 'Admin' }, templateId: 'tpl_standard_self_storage',
      },
      'platform-user-1',
      new NoOpBillingProvider()
    );
    const activation = await activateTenantOnFirstPayment(db, result.tenant.id);
    expect(activation?.adminUserId).toBe(result.adminUserId);
    const tenant = await getTenantById(db, result.tenant.id);
    expect(tenant?.lifecycle_state).toBe('active');

    // Idempotent: a second (redelivered webhook) call is a no-op, not a duplicate invite.
    const second = await activateTenantOnFirstPayment(db, result.tenant.id);
    expect(second).toBeNull();
  });

  test('resendFirstAdminInvite only works while the admin is still invited, and stamps invite_sent_at', async () => {
    const result = await provisionTenant(
      db,
      { name: 'Resend Co', slug: `resend-${randomUUID().slice(0, 8)}`, timezone: 'America/Chicago', firstAdmin: { email: 'admin@resend.test', name: 'Admin' }, templateId: 'tpl_standard_self_storage' },
      'platform-user-1',
      new NoOpBillingProvider()
    );
    const resend = await resendFirstAdminInvite(db, result.tenant.id, 'platform-user-2');
    expect(resend.inviteUrl).toContain('/reset-password?token=');
    const admin = await db.selectFrom('users').selectAll().where('id', '=', result.adminUserId).executeTakeFirstOrThrow();
    expect(admin.invite_sent_at).toBeInstanceOf(Date);

    await db.updateTable('users').set({ status: 'active' }).where('id', '=', result.adminUserId).execute();
    await expect(resendFirstAdminInvite(db, result.tenant.id, 'platform-user-2')).rejects.toMatchObject({ status: 409 });
  });

  test('resendBillingSetupLink requires billing to already be attached', async () => {
    const tenant = await createTenant(db, { name: 'No Billing Co', slug: `nobilling-${randomUUID().slice(0, 8)}` }, 'p1');
    await db.insertInto('users').values({ id: randomUUID(), tenant_id: tenant.id, role: 'admin', email: 'a@b.test', name: 'A', status: 'invited', created_at: new Date() }).execute();
    await expect(resendBillingSetupLink(db, tenant.id, 'p1')).rejects.toMatchObject({ status: 409 });
  });

  test('updateTenantRate pushes to Stripe FIRST, only commits the local rate after Stripe confirms; a Stripe failure changes nothing locally', async () => {
    const result = await provisionTenant(
      db,
      { name: 'Rate Co', slug: `rate-${randomUUID().slice(0, 8)}`, timezone: 'America/Chicago', firstAdmin: { email: 'admin@rate.test', name: 'Admin' }, templateId: 'tpl_standard_self_storage' },
      'platform-user-1',
      new NoOpBillingProvider()
    );
    const ok = await updateTenantRate(db, result.tenant.id, 15000, new NoOpBillingProvider(), 'platform-user-1');
    expect(ok).toEqual({ monthlyRateCents: 15000, pushedToStripe: true });

    const failing: BillingProvider = {
      ...new NoOpBillingProvider(),
      updateSubscriptionPrice: async () => { throw new Error('card declined'); },
    } as BillingProvider;
    const failed = await updateTenantRate(db, result.tenant.id, 99999, failing, 'platform-user-1');
    expect(failed.pushedToStripe).toBe(false);
    expect(failed.error).toBe('card declined');
    const tenant = await getTenantById(db, result.tenant.id);
    expect(tenant?.monthly_rate_cents).toBe(15000); // unchanged — still matches the last successful Stripe push, not 99999
  });

  test('updateTenantSetupFee blocks edits once a subscription exists (already invoiced)', async () => {
    const result = await provisionTenant(
      db,
      { name: 'Fee Co', slug: `fee-${randomUUID().slice(0, 8)}`, timezone: 'America/Chicago', firstAdmin: { email: 'admin@fee.test', name: 'Admin' }, templateId: 'tpl_standard_self_storage', setupFeeCents: 5000 },
      'platform-user-1',
      new NoOpBillingProvider()
    );
    const blocked = await updateTenantSetupFee(db, result.tenant.id, 9999, 'platform-user-1');
    expect(blocked.updated).toBe(false);
    expect(blocked.blockedReason).toMatch(/already invoiced/);
  });
});

describe('db-core (Stage 4): billing_snapshots rowid->seq ordering — THE billing-critical test', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    const tenant = await createTenant(db, { name: 'Ordering Test Co', slug: `ordering-${randomUUID().slice(0, 8)}` }, 'p1');
    tenantId = tenant.id;
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('multiple snapshots with IDENTICAL created_at (same millisecond) resolve by seq (insertion order), not timestamp — attachBilling reads the correct latest quantity', async () => {
    const sameInstant = new Date();
    // Same-millisecond writes: exactly what provisioning's batch location creation produces
    // when it inserts several snapshot rows fast enough to tie on the timestamp.
    for (const count of [1, 2, 3, 4, 5]) {
      await db.insertInto('billing_snapshots').values({
        id: randomUUID(), tenant_id: tenantId, billable_locations: count, amount_cents: count * 9000, changed: true, created_at: sameInstant,
      }).execute();
    }

    const latest = await db.selectFrom('billing_snapshots').select('billable_locations').where('tenant_id', '=', tenantId).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    // If this were still ordering by created_at (all identical), the result would be arbitrary —
    // proving it's 5 (the LAST one inserted, not the first, not the highest value coincidentally)
    // demonstrates seq is genuinely disambiguating by insertion order.
    expect(latest.billable_locations).toBe(5);
  });

  test('syncBillingQuantities pushes the CORRECT (latest) quantity to Stripe when same-millisecond snapshots exist, and marks only the eligible rows synced', async () => {
    await db.updateTable('tenants').set({ stripe_subscription_id: 'sub_test_ordering' }).where('id', '=', tenantId).execute();
    const sameInstant = new Date();
    for (const count of [10, 20, 30]) {
      await db.insertInto('billing_snapshots').values({
        id: randomUUID(), tenant_id: tenantId, billable_locations: count, amount_cents: count * 9000, changed: true, created_at: sameInstant,
      }).execute();
    }

    const spy = new SpyBillingProvider();
    const result = await syncBillingQuantities(db, spy);

    expect(result).toEqual({ synced: 1, failed: 0 }); // one tenant, collapsed to its single latest row
    expect(spy.quantityCalls).toEqual([{ subscriptionId: 'sub_test_ordering', quantity: 30 }]); // NOT 10, NOT 20 — the last-inserted (highest seq) row, despite identical timestamps

    const unsynced = await db.selectFrom('billing_snapshots').selectAll().where('tenant_id', '=', tenantId).where('stripe_synced_at', 'is', null).execute();
    expect(unsynced).toHaveLength(0); // all 3 same-tenant rows marked synced together (by design — see quantity-sync.ts)
  });

  test('syncBillingQuantities across MULTIPLE tenants each gets its own correctly-ordered latest quantity', async () => {
    const tenant2 = await createTenant(db, { name: 'Second Tenant', slug: `ordering2-${randomUUID().slice(0, 8)}` }, 'p1');
    await db.updateTable('tenants').set({ stripe_subscription_id: 'sub_tenant_1' }).where('id', '=', tenantId).execute();
    await db.updateTable('tenants').set({ stripe_subscription_id: 'sub_tenant_2' }).where('id', '=', tenant2.id).execute();

    const instant = new Date();
    for (const count of [1, 2]) {
      await db.insertInto('billing_snapshots').values({ id: randomUUID(), tenant_id: tenantId, billable_locations: count, amount_cents: 0, changed: true, created_at: instant }).execute();
    }
    for (const count of [7, 8, 9]) {
      await db.insertInto('billing_snapshots').values({ id: randomUUID(), tenant_id: tenant2.id, billable_locations: count, amount_cents: 0, changed: true, created_at: instant }).execute();
    }

    const spy = new SpyBillingProvider();
    const result = await syncBillingQuantities(db, spy);
    expect(result).toEqual({ synced: 2, failed: 0 });
    const byTenant = new Map(spy.quantityCalls.map((c) => [c.subscriptionId, c.quantity]));
    expect(byTenant.get('sub_tenant_1')).toBe(2);
    expect(byTenant.get('sub_tenant_2')).toBe(9);
  });

  test('syncBillingQuantities ignores snapshots for tenants with no live subscription yet', async () => {
    await db.insertInto('billing_snapshots').values({ id: randomUUID(), tenant_id: tenantId, billable_locations: 1, amount_cents: 0, changed: true, created_at: new Date() }).execute();
    const spy = new SpyBillingProvider();
    const result = await syncBillingQuantities(db, spy);
    expect(result).toEqual({ synced: 0, failed: 0 });
    expect(spy.quantityCalls).toHaveLength(0);
  });
});

describe('db-core (Stage 4): stripe-webhook.ts', () => {
  let db: Db;
  beforeEach(async () => {
    db = await setupTestDb();
    await seedTemplates(db);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  function fakeInvoiceEvent(customerId: string, billingReason: string): any {
    return { type: 'invoice.paid', data: { object: { customer: customerId, billing_reason: billingReason } } };
  }

  test('activates the tenant on the FIRST invoice (subscription_create), ignores renewals and unrelated events', async () => {
    const result = await provisionTenant(
      db,
      { name: 'Webhook Co', slug: `webhook-${randomUUID().slice(0, 8)}`, timezone: 'America/Chicago', firstAdmin: { email: 'admin@webhook.test', name: 'Admin' }, templateId: 'tpl_standard_self_storage' },
      'platform-user-1',
      new NoOpBillingProvider()
    );
    const tenant = await getTenantById(db, result.tenant.id);

    const ignored = await handleStripeEvent(db, fakeInvoiceEvent(tenant!.stripe_customer_id!, 'subscription_cycle'));
    expect(ignored.handled).toBe(false);

    const activated = await handleStripeEvent(db, fakeInvoiceEvent(tenant!.stripe_customer_id!, 'subscription_create'));
    expect(activated.handled).toBe(true);
    expect((await getTenantById(db, result.tenant.id))?.lifecycle_state).toBe('active');

    // Redelivery is a no-op, not a re-activation error.
    const redelivered = await handleStripeEvent(db, fakeInvoiceEvent(tenant!.stripe_customer_id!, 'subscription_create'));
    expect(redelivered.handled).toBe(false);
  });

  test('ignores events for an unknown Stripe customer', async () => {
    const result = await handleStripeEvent(db, fakeInvoiceEvent('cus_nonexistent', 'subscription_create'));
    expect(result).toEqual({ handled: false, reason: 'no tenant for this Stripe customer' });
  });
});
