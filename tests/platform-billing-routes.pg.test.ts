// tests/platform-billing-routes.pg.test.ts — Phase 13 migration, Stage 8d: verifies the
// 16-file getRawDb gap the pre-8c reconciliation surfaced (the /platform UI + billing/webhook
// routes) against real Postgres, now that each is converted (getDb + await).
//
// These routes/pages call the getDb() SINGLETON internally rather than taking an injected `db`
// (unlike every service function tested in prior stages), so this file can't use the shared
// setupTestDb()/per-test-transaction harness — a route's own getDb() call would resolve to
// whatever DATABASE_URL was at CLIENT MODULE LOAD TIME, not this test's transaction handle, and
// an uncommitted transaction is invisible to a separate connection anyway (same reason Stage
// 8b's claim-race test couldn't use it either). Instead: point DATABASE_URL at a dedicated
// ephemeral database, jest.resetModules() so client.ts's singleton picks it up fresh, and
// require() (not import — needs to be cache-busted, same reason phase12-billing-subscription's
// webhook route test already does this for the SQLite era) every route AFTER that reset. All
// fixtures are seeded through that same fresh getDb() connection, so nothing needs a commit —
// it's the same pool the routes read from.
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import Stripe from 'stripe';
import { createEphemeralTestDatabase, dropEphemeralTestDatabase } from '@/lib/db/test-isolation';
import { issueToken } from '@/lib/auth/jwt';
import { issueBillingSetupToken } from '@/lib/services/password-reset';
import type { Db } from '@/lib/db/client';

let mockCookieToken: string | undefined;
jest.mock('next/headers', () => ({
  cookies: () => ({ get: (_n: string) => (mockCookieToken ? { value: mockCookieToken } : undefined) }),
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  usePathname: () => '/platform',
}));

const bearer = (jwt: string) => ({ headers: { Authorization: `Bearer ${jwt}` } });
const platformToken = (sub = 'platform-1') => issueToken({ sub, tenantId: null, role: 'owner', type: 'platform' });

describe('db-core (Stage 8d): /platform UI + billing/webhook routes', () => {
  let dbName: string;
  let db: Db;
  let getDb: () => Db;
  // The webhook describe block below calls jest.resetModules() twice more (needed to pick up
  // an env var change on a module that caches env at import time) — each reset gives
  // @/lib/db/client a brand-new singleton pool, disconnected from `db` above. All still point
  // at the same physical database (Postgres doesn't care which pool issues a query), so test
  // correctness is unaffected, but this second pool is never referenced by `db` and would
  // otherwise leak past this file's own afterAll — tracked here so it gets closed too.
  let extraCloseDb: (() => Promise<void>) | null = null;

  // route handlers, fresh-required after the DATABASE_URL swap
  let tenantsRoute: typeof import('@/app/api/platform/tenants/route');
  let checkSlugRoute: typeof import('@/app/api/platform/tenants/check-slug/route');
  let tenantByIdRoute: typeof import('@/app/api/platform/tenants/[tenantId]/route');
  let impersonateRoute: typeof import('@/app/api/platform/tenants/[tenantId]/impersonate/route');
  let rateRoute: typeof import('@/app/api/platform/tenants/[tenantId]/rate/route');
  let resendAdminRoute: typeof import('@/app/api/platform/tenants/[tenantId]/resend-admin-invite/route');
  let resendBillingRoute: typeof import('@/app/api/platform/tenants/[tenantId]/resend-billing-link/route');
  let retryBillingRoute: typeof import('@/app/api/platform/tenants/[tenantId]/retry-billing/route');
  let setupFeeRoute: typeof import('@/app/api/platform/tenants/[tenantId]/setup-fee/route');
  let provisionRoute: typeof import('@/app/api/platform/provision/route');
  let billingConfirmRoute: typeof import('@/app/api/billing/setup/confirm/route');
  let stripeWebhookRoute: typeof import('@/app/api/webhooks/stripe/route');
  let BillingSetupPage: typeof import('@/app/billing/setup/page').default;
  let PlatformLayout: typeof import('@/app/platform/layout').default;
  let PlatformFleetPage: typeof import('@/app/platform/page').default;
  let ProvisioningPage: typeof import('@/app/platform/provisioning/page').default;
  // component references, ALSO fresh-required post-reset — a static top-level `import` would
  // resolve to a module instance from BEFORE jest.resetModules(), which is referentially
  // distinct from what the fresh-required page components import internally, so `el.type ===
  // FleetRoster`-style structural checks would always fail despite being "the same" component.
  let CardEntryForm: typeof import('@/app/billing/setup/CardEntryForm').CardEntryForm;
  let PlatformShell: typeof import('@/components/platform/PlatformShell').PlatformShell;
  let FleetRoster: typeof import('@/components/platform/FleetRoster').FleetRoster;
  let ProvisioningWizard: typeof import('@/components/platform/ProvisioningWizard').ProvisioningWizard;

  beforeAll(async () => {
    const eph = await createEphemeralTestDatabase();
    dbName = eph.name;
    await eph.db.destroy(); // the fresh-required client.ts opens its own pool below

    const { host, port, user, password } = (await import('@/lib/env')).env.postgres;
    process.env['DATABASE_URL'] = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;
    // Force the NoOp billing provider (same assumption tests/phase12-billing-setup.test.ts's
    // BillingSetupPage suite relies on) — dotenv/config above loads a real STRIPE_SECRET_KEY
    // from .env, which the plain SQLite-era test never triggered (it never imports
    // dotenv/config), so it must be explicitly cleared here to get the same deterministic,
    // no-network-call behavior rather than a real Stripe API call with a fake setupIntentId.
    delete process.env['STRIPE_SECRET_KEY'];
    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const client = require('@/lib/db/client');
    getDb = client.getDb;
    db = getDb();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    tenantsRoute = require('@/app/api/platform/tenants/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    checkSlugRoute = require('@/app/api/platform/tenants/check-slug/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    tenantByIdRoute = require('@/app/api/platform/tenants/[tenantId]/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    impersonateRoute = require('@/app/api/platform/tenants/[tenantId]/impersonate/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    rateRoute = require('@/app/api/platform/tenants/[tenantId]/rate/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    resendAdminRoute = require('@/app/api/platform/tenants/[tenantId]/resend-admin-invite/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    resendBillingRoute = require('@/app/api/platform/tenants/[tenantId]/resend-billing-link/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    retryBillingRoute = require('@/app/api/platform/tenants/[tenantId]/retry-billing/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    setupFeeRoute = require('@/app/api/platform/tenants/[tenantId]/setup-fee/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    provisionRoute = require('@/app/api/platform/provision/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    billingConfirmRoute = require('@/app/api/billing/setup/confirm/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    stripeWebhookRoute = require('@/app/api/webhooks/stripe/route');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    BillingSetupPage = require('@/app/billing/setup/page').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    PlatformLayout = require('@/app/platform/layout').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    PlatformFleetPage = require('@/app/platform/page').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ProvisioningPage = require('@/app/platform/provisioning/page').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    CardEntryForm = require('@/app/billing/setup/CardEntryForm').CardEntryForm;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    PlatformShell = require('@/components/platform/PlatformShell').PlatformShell;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    FleetRoster = require('@/components/platform/FleetRoster').FleetRoster;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ProvisioningWizard = require('@/components/platform/ProvisioningWizard').ProvisioningWizard;
  });

  afterAll(async () => {
    // Close the second (post-reset) pool first, if the webhook describe block created one.
    if (extraCloseDb) await extraCloseDb();
    // Pass the already-open `db` straight through — dropEphemeralTestDatabase() destroys it
    // itself. Calling closeDb() first and then opening a THROWAWAY kyselyFor(dbName) connection
    // just to destroy it immediately raced pg_terminate_backend against that connection's own
    // not-yet-finished teardown (an unhandled 57P01 on an unrelated, needless pool). Matches
    // Stage 8b's claim-race test's working pattern: hand the function the live connection.
    delete process.env['DATABASE_URL'];
    await dropEphemeralTestDatabase(dbName, db);
  });

  async function seedTenant(overrides: Partial<{ id: string; slug: string | null; stripe_customer_id: string | null; stripe_setup_intent_id: string | null; lifecycle_state: string }> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insertInto('tenants').values({
      id, name: 'Route Tenant', lifecycle_state: overrides.lifecycle_state ?? 'provisioning',
      monthly_rate_cents: 9000, created_at: new Date(),
      slug: 'slug' in overrides ? overrides.slug : `slug-${id.slice(0, 8)}`,
      stripe_customer_id: overrides.stripe_customer_id ?? null,
      stripe_setup_intent_id: overrides.stripe_setup_intent_id ?? null,
    }).execute();
    return id;
  }

  async function seedAdmin(tenantId: string) {
    const id = randomUUID();
    await db.insertInto('users').values({
      id, tenant_id: tenantId, email: `${id}@x.test`, name: 'Admin', role: 'admin',
      password_hash: null, status: 'invited', created_at: new Date(),
    }).execute();
    return id;
  }

  // ── /api/platform/tenants ───────────────────────────────────────────────────────

  test('POST creates a tenant, GET lists it', async () => {
    const jwt = platformToken();
    const postRes = await tenantsRoute.POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt), body: JSON.stringify({ name: 'New Co' }) }));
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()).data;
    expect(created.name).toBe('New Co');

    const getRes = await tenantsRoute.GET(new Request('http://t/x', bearer(jwt)));
    expect(getRes.status).toBe(200);
    const list = (await getRes.json()).data;
    expect(list.some((t: { id: string }) => t.id === created.id)).toBe(true);
  });

  // ── /api/platform/tenants/check-slug ────────────────────────────────────────────

  test('check-slug reports taken vs available', async () => {
    const jwt = platformToken();
    await seedTenant({ slug: 'taken-slug' });

    const takenRes = await checkSlugRoute.GET(new Request('http://t/x?slug=taken-slug', bearer(jwt)));
    expect((await takenRes.json()).data.available).toBe(false);

    const freeRes = await checkSlugRoute.GET(new Request('http://t/x?slug=free-slug', bearer(jwt)));
    expect((await freeRes.json()).data.available).toBe(true);
  });

  // ── /api/platform/tenants/[tenantId] ────────────────────────────────────────────

  test('GET returns the tenant; PATCH updates it', async () => {
    const jwt = platformToken();
    const tenantId = await seedTenant();

    const getRes = await tenantByIdRoute.GET(new Request('http://t/x', bearer(jwt)), { params: { tenantId } });
    expect(getRes.status).toBe(200);

    const patchRes = await tenantByIdRoute.PATCH(
      new Request('http://t/x', { method: 'PATCH', ...bearer(jwt), body: JSON.stringify({ lifecycleState: 'active' }) }),
      { params: { tenantId } }
    );
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).data.lifecycle_state).toBe('active');
  });

  test('GET 404s for an unknown tenant', async () => {
    const jwt = platformToken();
    const res = await tenantByIdRoute.GET(new Request('http://t/x', bearer(jwt)), { params: { tenantId: randomUUID() } });
    expect(res.status).toBe(404);
  });

  // ── /api/platform/tenants/[tenantId]/impersonate ────────────────────────────────

  test('impersonate issues a valid tenant JWT attributed to the platform user', async () => {
    const jwt = platformToken('platform-9');
    const tenantId = await seedTenant();
    const res = await impersonateRoute.POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt) }), { params: { tenantId } });
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.impersonatedBy).toBe('platform-9');
  });

  // ── /api/platform/tenants/[tenantId]/rate ───────────────────────────────────────

  test('rate PATCH updates monthly_rate_cents when no live Stripe subscription exists', async () => {
    const jwt = platformToken();
    const tenantId = await seedTenant();
    const res = await rateRoute.PATCH(
      new Request('http://t/x', { method: 'PATCH', ...bearer(jwt), body: JSON.stringify({ monthlyRateCents: 12000 }) }),
      { params: { tenantId } }
    );
    expect(res.status).toBe(200);
    const row = await db.selectFrom('tenants').select('monthly_rate_cents').where('id', '=', tenantId).executeTakeFirstOrThrow();
    expect(row.monthly_rate_cents).toBe(12000);
  });

  // ── /api/platform/tenants/[tenantId]/setup-fee ──────────────────────────────────

  test('setup-fee PATCH updates setup_fee_cents pre-attach', async () => {
    const jwt = platformToken();
    const tenantId = await seedTenant();
    const res = await setupFeeRoute.PATCH(
      new Request('http://t/x', { method: 'PATCH', ...bearer(jwt), body: JSON.stringify({ setupFeeCents: 50000 }) }),
      { params: { tenantId } }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.updated).toBe(true);
    const row = await db.selectFrom('tenants').select('setup_fee_cents').where('id', '=', tenantId).executeTakeFirstOrThrow();
    expect(row.setup_fee_cents).toBe(50000);
  });

  // ── resend-admin-invite / resend-billing-link ───────────────────────────────────

  test('resend-admin-invite reissues a token for the tenant\'s first admin', async () => {
    const jwt = platformToken();
    const tenantId = await seedTenant();
    await seedAdmin(tenantId);
    const res = await resendAdminRoute.POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt) }), { params: { tenantId } });
    expect(res.status).toBe(200);
  });

  test('resend-billing-link requires a Stripe customer to already exist (BAD_REQUEST-shaped failure surfaces cleanly, not a raw 500)', async () => {
    const jwt = platformToken();
    const tenantId = await seedTenant({ stripe_customer_id: null });
    const res = await resendBillingRoute.POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt) }), { params: { tenantId } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // ── retry-billing ────────────────────────────────────────────────────────────────

  test('retry-billing (NoOp Stripe provider in test env) attaches a customer id', async () => {
    const jwt = platformToken();
    const tenantId = await seedTenant();
    await seedAdmin(tenantId); // attachBilling requires an admin to bill
    const res = await retryBillingRoute.POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt) }), { params: { tenantId } });
    expect(res.status).toBe(200);
    const row = await db.selectFrom('tenants').select('stripe_customer_id').where('id', '=', tenantId).executeTakeFirstOrThrow();
    expect(row.stripe_customer_id).not.toBeNull();
  });

  // ── /api/platform/provision ─────────────────────────────────────────────────────

  test('provision creates a tenant end to end (201)', async () => {
    const jwt = platformToken();
    const templateId = randomUUID();
    await db.insertInto('requirement_templates').values({
      id: templateId, name: 'Stage 8d Template', payload_json: JSON.stringify({ defaults: { 'doc_required.coi': 'true' }, floor: {} }), created_at: new Date(),
    }).execute();

    const res = await provisionRoute.POST(new Request('http://t/x', {
      method: 'POST', ...bearer(jwt),
      body: JSON.stringify({
        name: 'Provisioned Co', slug: `provisioned-${randomUUID().slice(0, 8)}`, timezone: 'America/Chicago',
        firstAdmin: { name: 'First Admin', email: `admin-${randomUUID().slice(0, 8)}@x.test` },
        templateId, locations: [{ name: 'Store 1' }],
      }),
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).data.tenant.name).toBe('Provisioned Co');
  });

  // ── /api/billing/setup/confirm ──────────────────────────────────────────────────

  test('billing/setup/confirm: invalid token → 400', async () => {
    const res = await billingConfirmRoute.POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ token: 'nonsense' }) }));
    expect(res.status).toBe(400);
  });

  test('billing/setup/confirm: already-active tenant is an idempotent 200 {paid:true}', async () => {
    const tenantId = await seedTenant({ lifecycle_state: 'active', stripe_customer_id: 'cus_x', stripe_setup_intent_id: 'seti_x' });
    const admin = await seedAdmin(tenantId);
    const { rawToken } = await issueBillingSetupToken(db, { tenantId, userId: admin });
    const res = await billingConfirmRoute.POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ token: rawToken }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.paid).toBe(true);
  });

  // ── /api/webhooks/stripe ────────────────────────────────────────────────────────

  describe('POST /api/webhooks/stripe', () => {
    const SECRET = 'whsec_test_' + Buffer.from('stage8d-route-secret').toString('hex');
    function sign(payload: string): string {
      return Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    }
    function req(body: string, headers: Record<string, string> = {}): Request {
      return new Request('http://t/api/webhooks/stripe', { method: 'POST', headers, body });
    }

    beforeAll(() => { process.env['STRIPE_WEBHOOK_SECRET'] = SECRET; });
    afterAll(() => { delete process.env['STRIPE_WEBHOOK_SECRET']; });

    test('no secret configured → 503', async () => {
      delete process.env['STRIPE_WEBHOOK_SECRET'];
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const unconfigured = require('@/app/api/webhooks/stripe/route');
      const res = await unconfigured.POST(req(JSON.stringify({ type: 'ping' })));
      expect(res.status).toBe(503);
      process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      stripeWebhookRoute = require('@/app/api/webhooks/stripe/route');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      extraCloseDb = require('@/lib/db/client').closeDb;
    });

    test('valid signature, ignored event type → 200 handled:false', async () => {
      const payload = JSON.stringify({ id: 'evt_1', type: 'customer.created', data: { object: {} } });
      const res = await stripeWebhookRoute.POST(req(payload, { 'stripe-signature': sign(payload) }));
      expect(res.status).toBe(200);
      expect((await res.json()).handled).toBe(false);
    });

    test('valid signature, invoice.paid for a real seeded tenant → activates it (await threaded through correctly)', async () => {
      const tenantId = await seedTenant({ stripe_customer_id: 'cus_stage8d_1' });
      await seedAdmin(tenantId);
      const payload = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { customer: 'cus_stage8d_1', billing_reason: 'subscription_create' } } });
      const res = await stripeWebhookRoute.POST(req(payload, { 'stripe-signature': sign(payload) }));
      expect(res.status).toBe(200);
      expect((await res.json()).handled).toBe(true);

      const row = await db.selectFrom('tenants').select('lifecycle_state').where('id', '=', tenantId).executeTakeFirstOrThrow();
      expect(row.lifecycle_state).toBe('active');
    });
  });

  // ── /billing/setup (page) ───────────────────────────────────────────────────────

  test('BillingSetupPage: invalid token renders the dead-end branch', async () => {
    const el = await BillingSetupPage({ searchParams: { token: 'nonsense' } });
    const html = renderToStaticMarkup(el);
    expect(html).toMatch(/isn.t valid/);
  });

  test('BillingSetupPage: valid pending-setup token renders CardEntryForm (structurally — never invoking its real Stripe.js loader)', async () => {
    const tenantId = await seedTenant({ stripe_customer_id: 'cus_page', stripe_setup_intent_id: 'seti_page' });
    const admin = await seedAdmin(tenantId);
    const { rawToken } = await issueBillingSetupToken(db, { tenantId, userId: admin });
    const el = await BillingSetupPage({ searchParams: { token: rawToken } }) as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(CardEntryForm);
    expect(el.props).toMatchObject({ token: rawToken, tenantName: 'Route Tenant' });
    expect(el.props['clientSecret']).toBeTruthy();
  });

  // ── /platform (layout + pages) ──────────────────────────────────────────────────

  test('PlatformLayout redirects to /login when unauthenticated', async () => {
    mockCookieToken = undefined;
    await expect(PlatformLayout({ children: null })).rejects.toThrow('REDIRECT:/login');
  });

  test('PlatformLayout redirects a tenant-type token to / (not a platform user)', async () => {
    mockCookieToken = issueToken({ sub: 'u1', tenantId: 'x', role: 'admin', type: 'tenant' });
    await expect(PlatformLayout({ children: null })).rejects.toThrow('REDIRECT:/');
  });

  test('PlatformLayout renders PlatformShell for a real platform user (getMeInfo awaited correctly) — checked structurally, PlatformShell itself uses client hooks (usePathname/useState) that SSR-render outside a real Next.js request can\'t execute', async () => {
    await db.insertInto('platform_users').values({
      id: 'platform-layout-1', email: 'owner@x.test', name: 'Owner Name', role: 'owner',
      password_hash: 'x', created_at: new Date(),
    }).onConflict((oc) => oc.column('id').doNothing()).execute();
    mockCookieToken = issueToken({ sub: 'platform-layout-1', tenantId: null, role: 'owner', type: 'platform' });
    const el = await PlatformLayout({ children: null }) as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(PlatformShell);
    expect(el.props['userName']).toBe('Owner Name');
    expect(el.props['userRole']).toBe('owner');
  });

  test('PlatformFleetPage passes the seeded tenants through to FleetRoster (listTenants awaited correctly) — checked structurally, FleetRoster uses useState', async () => {
    await seedTenant({ id: 'fleet-tenant-1' });
    const el = await PlatformFleetPage() as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(FleetRoster);
    const tenants = el.props['tenants'] as { id: string }[];
    expect(tenants.some((t) => t.id === 'fleet-tenant-1')).toBe(true);
  });

  test('ProvisioningPage passes templates through to ProvisioningWizard (listTemplates awaited correctly) — checked structurally, ProvisioningWizard uses useState', async () => {
    const el = await ProvisioningPage() as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(ProvisioningWizard);
    expect(Array.isArray(el.props['templates'])).toBe(true); // awaited correctly, not a Promise leaking through as a prop
  });
});
