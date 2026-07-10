// Slice 6, Phase B — tenant cockpit rate + setup-fee edits. The load-bearing property: local
// monthly_rate_cents and Stripe's live subscription must never diverge. A Stripe failure leaves
// the local rate COMPLETELY untouched (proven explicitly below) — never a local rate Stripe
// isn't actually charging.

import { setupTestDb, seedTenant } from './helpers';
import { updateTenantRate, updateTenantSetupFee } from '@/lib/services/provisioning';
import { getTenantById } from '@/lib/services/tenants';
import type { BillingProvider } from '@/lib/billing/provider';

class RecordingBilling implements BillingProvider {
  priceUpdateCalls: { subscriptionId: string; unitAmountCents: number; idempotencyKey: string }[] = [];
  failPriceUpdate = false;

  async createCustomer() { return { customerId: 'cus_x' }; }
  async createSetupIntent() { return { setupIntentId: 'seti_x', clientSecret: 'secret_x' }; }
  async createSubscription() { return { subscriptionId: 'sub_x' }; }
  async updateSubscriptionQuantity() { /* not under test here */ }
  async retrieveSetupIntent() { return { clientSecret: 'secret', status: 'requires_payment_method', paymentMethodId: null }; }
  async finalizeCardSetup() { return { paid: true }; }
  async listRecentInvoices() { return []; }
  async getSubscriptionStatus() { return { status: 'active' }; }
  async updateSubscriptionPrice(input: { subscriptionId: string; unitAmountCents: number; idempotencyKey: string }) {
    this.priceUpdateCalls.push(input);
    if (this.failPriceUpdate) throw new Error('stripe rejected the price swap');
  }
}

function attachSubscriptionLocally(db: ReturnType<typeof setupTestDb>, tenantId: string, subscriptionId = 'sub_existing') {
  db.prepare('UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?').run('cus_existing', subscriptionId, tenantId);
}

describe('updateTenantRate — pre-activation (no live subscription)', () => {
  test('updates the local rate only — nothing to push to yet', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const billing = new RecordingBilling();

    const result = await updateTenantRate(db, tenant.id, 12000, billing, 'plat-1');
    expect(result).toEqual({ monthlyRateCents: 12000, pushedToStripe: false });
    expect(billing.priceUpdateCalls).toHaveLength(0);
    expect(getTenantById(db, tenant.id)!.monthly_rate_cents).toBe(12000);
  });
});

describe('updateTenantRate — post-activation (live subscription exists)', () => {
  test('pushes to Stripe FIRST, then updates the local rate to match', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    attachSubscriptionLocally(db, tenant.id);
    const billing = new RecordingBilling();

    const result = await updateTenantRate(db, tenant.id, 15000, billing, 'plat-1');
    expect(result).toEqual({ monthlyRateCents: 15000, pushedToStripe: true });
    expect(billing.priceUpdateCalls).toHaveLength(1);
    expect(billing.priceUpdateCalls[0]).toMatchObject({ subscriptionId: 'sub_existing', unitAmountCents: 15000 });
    expect(getTenantById(db, tenant.id)!.monthly_rate_cents).toBe(15000);
  });

  test('logs a distinct billing.rate_synced_to_stripe audit event (in addition to tenant.settings_changed)', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    attachSubscriptionLocally(db, tenant.id);
    const billing = new RecordingBilling();

    await updateTenantRate(db, tenant.id, 15000, billing, 'plat-1');
    const synced = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'billing.rate_synced_to_stripe'").get(tenant.id);
    const settings = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'tenant.settings_changed'").get(tenant.id);
    expect(synced).toBeTruthy();
    expect(settings).toBeTruthy();
  });

  test('the Stripe call does NOT specify quantity — preserves whatever quantity-sync last set (partial-update semantics)', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    attachSubscriptionLocally(db, tenant.id);
    const billing = new RecordingBilling();

    await updateTenantRate(db, tenant.id, 15000, billing, 'plat-1');
    expect(billing.priceUpdateCalls[0]).not.toHaveProperty('quantity');
  });

  test('NO DIVERGENCE: a Stripe failure leaves the local rate COMPLETELY UNCHANGED, and reports the error', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db); // default monthly_rate_cents is 9000
    attachSubscriptionLocally(db, tenant.id);
    const billing = new RecordingBilling();
    billing.failPriceUpdate = true;

    const result = await updateTenantRate(db, tenant.id, 20000, billing, 'plat-1');
    expect(result.pushedToStripe).toBe(false);
    expect(result.error).toContain('stripe rejected');
    expect(result.monthlyRateCents).toBe(9000); // unchanged — reported back, not silently kept stale
    expect(getTenantById(db, tenant.id)!.monthly_rate_cents).toBe(9000); // DB genuinely untouched
  });

  test('logs no tenant.settings_changed audit event when the Stripe push fails (nothing actually changed)', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    attachSubscriptionLocally(db, tenant.id);
    const billing = new RecordingBilling();
    billing.failPriceUpdate = true;

    await updateTenantRate(db, tenant.id, 20000, billing, 'plat-1');
    const event = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'tenant.settings_changed'").get(tenant.id);
    expect(event).toBeUndefined();
  });
});

describe('updateTenantRate — validation', () => {
  test('rejects a negative rate (400), before any write', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    await expect(updateTenantRate(db, tenant.id, -100, new RecordingBilling(), 'plat-1')).rejects.toMatchObject({ status: 400 });
  });
  test('rejects a non-integer rate (400)', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    await expect(updateTenantRate(db, tenant.id, 90.5, new RecordingBilling(), 'plat-1')).rejects.toMatchObject({ status: 400 });
  });
  test('unknown tenant is a 404', async () => {
    const db = setupTestDb();
    await expect(updateTenantRate(db, 'no-such-tenant', 9000, new RecordingBilling(), 'plat-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateTenantSetupFee — pre-activation (no live subscription)', () => {
  test('is editable: updates the local column', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const result = updateTenantSetupFee(db, tenant.id, 50000, 'plat-1');
    expect(result).toEqual({ setupFeeCents: 50000, updated: true });
    expect(getTenantById(db, tenant.id)!.setup_fee_cents).toBe(50000);
  });

  test('null clears the fee', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    updateTenantSetupFee(db, tenant.id, 50000, 'plat-1');
    const result = updateTenantSetupFee(db, tenant.id, null, 'plat-1');
    expect(result).toEqual({ setupFeeCents: null, updated: true });
  });

  test('rejects a negative fee (400)', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    expect(() => updateTenantSetupFee(db, tenant.id, -100, 'plat-1')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('updateTenantSetupFee — post-activation (subscription already exists)', () => {
  test('is BLOCKED, not silently no-op\'d: the fee was already invoiced at attach — local column stays put, a reason is surfaced', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    db.prepare('UPDATE tenants SET setup_fee_cents = ? WHERE id = ?').run(25000, tenant.id);
    attachSubscriptionLocally(db, tenant.id);

    const result = updateTenantSetupFee(db, tenant.id, 99999, 'plat-1');
    expect(result.updated).toBe(false);
    expect(result.setupFeeCents).toBe(25000); // unchanged
    expect(result.blockedReason).toMatch(/already invoiced/i);
    expect(getTenantById(db, tenant.id)!.setup_fee_cents).toBe(25000); // DB genuinely untouched
  });

  test('blocked even if the subscription exists but the tenant has not yet paid/activated (fee is queued in Stripe regardless)', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db, { lifecycle_state: 'provisioning' });
    db.prepare('UPDATE tenants SET setup_fee_cents = ? WHERE id = ?').run(25000, tenant.id);
    attachSubscriptionLocally(db, tenant.id); // subscription exists, but lifecycle_state is still 'provisioning'

    const result = updateTenantSetupFee(db, tenant.id, 1, 'plat-1');
    expect(result.updated).toBe(false);
  });
});
