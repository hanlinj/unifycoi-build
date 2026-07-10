// Slice 6 — tenant cockpit resend controls. Both reuse existing token issuers verbatim
// (issueInviteToken / issueBillingSetupToken) — no new issuer. Proves the purpose-boundary
// rejection holds for tokens minted from THIS path too (not just the original 5a/5a.1 paths).

import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { resendFirstAdminInvite, resendBillingSetupLink } from '@/lib/services/provisioning';
import { confirmPasswordReset, resolveBillingSetupToken } from '@/lib/services/password-reset';
import { NoOpBillingProvider, type BillingProvider } from '@/lib/billing/provider';

describe('BillingProvider.listRecentInvoices', () => {
  test('NoOp (dev/test/CI, no real Stripe customer) returns an empty list, not an error', async () => {
    const provider: BillingProvider = new NoOpBillingProvider();
    const invoices = await provider.listRecentInvoices({ customerId: 'cus_noop_x' });
    expect(invoices).toEqual([]);
  });
});

describe('BillingProvider.getSubscriptionStatus', () => {
  test('NoOp returns a deterministic status, not an error', async () => {
    const provider: BillingProvider = new NoOpBillingProvider();
    const result = await provider.getSubscriptionStatus({ subscriptionId: 'sub_noop_x' });
    expect(result).toEqual({ status: 'active' });
  });
});

describe('resendFirstAdminInvite', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
  });
  afterEach(() => db.close());

  test('resends a working invite link for a dormant first Admin', () => {
    const admin = seedTenantUser(db, tenant.id, { role: 'admin', status: 'invited' });
    const result = resendFirstAdminInvite(db, tenant.id, 'plat-1');
    expect(result.inviteUrl).toContain('/reset-password?token=');

    const rawToken = result.inviteUrl.split('token=')[1];
    expect(confirmPasswordReset(db, { rawToken, newPassword: 'admin-new-pass-1' }).ok).toBe(true);

    const after = db.prepare('SELECT invite_sent_at FROM users WHERE id = ?').get(admin.id) as { invite_sent_at: string | null };
    expect(after.invite_sent_at).toBeTruthy();
  });

  test('logs admin.invite_resent attributed to the platform actor, not actorType user', () => {
    seedTenantUser(db, tenant.id, { role: 'admin', status: 'invited' });
    resendFirstAdminInvite(db, tenant.id, 'plat-1');
    const event = db.prepare("SELECT actor_type, actor_id FROM audit_events WHERE tenant_id = ? AND event_type = 'admin.invite_resent'").get(tenant.id) as { actor_type: string; actor_id: string };
    expect(event).toMatchObject({ actor_type: 'platform', actor_id: 'plat-1' });
  });

  test('rejects (409) once the first Admin has already accepted — nothing to resend', () => {
    seedTenantUser(db, tenant.id, { role: 'admin', status: 'active', password: 'already-set-1' });
    expect(() => resendFirstAdminInvite(db, tenant.id, 'plat-1')).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('unknown tenant is a 404', () => {
    expect(() => resendFirstAdminInvite(db, 'no-such-tenant', 'plat-1')).toThrow(expect.objectContaining({ status: 404 }));
  });

  test('a token minted here cannot be used as a billing-setup token (purpose boundary)', () => {
    seedTenantUser(db, tenant.id, { role: 'admin', status: 'invited' });
    const result = resendFirstAdminInvite(db, tenant.id, 'plat-1');
    const rawToken = result.inviteUrl.split('token=')[1];
    expect(resolveBillingSetupToken(db, rawToken)).toEqual({ status: 'invalid' });
  });
});

describe('resendBillingSetupLink', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
  });
  afterEach(() => db.close());

  function attachBillingLocally() {
    db.prepare('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?').run('cus_test123', tenant.id);
  }

  test('resends a working billing-setup link once billing is attached', () => {
    seedTenantUser(db, tenant.id, { role: 'admin' });
    attachBillingLocally();
    const result = resendBillingSetupLink(db, tenant.id, 'plat-1');
    expect(result.inviteUrl).toContain('/billing/setup?token=');

    const rawToken = result.inviteUrl.split('token=')[1];
    expect(resolveBillingSetupToken(db, rawToken)).toMatchObject({ status: 'valid', tenantId: tenant.id });
  });

  test('logs billing.setup_link_resent attributed to the platform actor', () => {
    seedTenantUser(db, tenant.id, { role: 'admin' });
    attachBillingLocally();
    resendBillingSetupLink(db, tenant.id, 'plat-1');
    const event = db.prepare("SELECT actor_type, actor_id FROM audit_events WHERE tenant_id = ? AND event_type = 'billing.setup_link_resent'").get(tenant.id) as { actor_type: string; actor_id: string };
    expect(event).toMatchObject({ actor_type: 'platform', actor_id: 'plat-1' });
  });

  test('rejects (409) before billing has ever been attached', () => {
    seedTenantUser(db, tenant.id, { role: 'admin' });
    expect(() => resendBillingSetupLink(db, tenant.id, 'plat-1')).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('is NOT gated on the admin having already accepted their own invite (unlike the admin-invite resend)', () => {
    seedTenantUser(db, tenant.id, { role: 'admin', status: 'active', password: 'already-active-1' });
    attachBillingLocally();
    expect(() => resendBillingSetupLink(db, tenant.id, 'plat-1')).not.toThrow();
  });

  test('a token minted here cannot be used to set a password (purpose boundary)', () => {
    seedTenantUser(db, tenant.id, { role: 'admin' });
    attachBillingLocally();
    const result = resendBillingSetupLink(db, tenant.id, 'plat-1');
    const rawToken = result.inviteUrl.split('token=')[1];
    expect(confirmPasswordReset(db, { rawToken, newPassword: 'should-not-work-1' })).toEqual({ ok: false, reason: 'invalid_token' });
  });
});
