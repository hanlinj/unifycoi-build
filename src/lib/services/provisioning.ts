// Provisioning (OPS-8 core + OPS-7 input). The audited platform transaction that turns "a sales
// conversation" into a ready-to-activate tenant: tenant + first Admin + locations + requirements
// template + a REQUIRED validated timezone, all through the real services (audit + invariants
// hold) — never the raw-SQL dev-seed path.
//
// ── DB-commit / Stripe-call boundary (the load-bearing bit) ──────────────────────────────
// A DB transaction cannot wrap an external network call. So:
//   1. The DB transaction commits the core atomically (tenant+admin+locations+template). If
//      any step throws, it all rolls back — no partial/orphan tenant.
//   2. AFTER commit, the Stripe customer + SetupIntent + recurring subscription are created,
//      then stripe_customer_id/stripe_subscription_id are stored. Ordering is
//      create-tenant-then-customer-then-subscription, so nothing Stripe-side is ever created
//      for a tenant that doesn't exist → NO orphaned customer/subscription-without-tenant.
//   3. If any Stripe step fails, the tenant stays in 'provisioning' with the Stripe id(s) still
//      NULL and billing.attached=false — recoverable (retry is idempotent via the
//      provision:<tenantId> key family → reuses the same customer/subscription, no dupes).
//      NO orphaned live tenant.
//
// ── Credential model (Slice 4), REVISED by Slice 5a's activation-on-payment ──────────────
// The wizard never handles a password. The first Admin is created 'invited' (no password_hash
// — createUser's existing no-password branch). Slice 4 minted the invite token immediately at
// provision time; Slice 5a moves that to activateTenantOnFirstPayment (fired by the Stripe
// invoice.paid webhook, src/lib/billing/stripe-webhook.ts) — the tenant goes 'active' and the
// Admin's invite is issued together, gated on the first invoice actually being paid, not on
// the DB transaction committing. provisionTenant no longer returns an `invite` field.
//
// ── Automatic billing (Slice 5a, ADR-012-05) ──────────────────────────────────────────────
// attachBilling grows from "card on file" into "card on file + active recurring subscription":
// customer → SetupIntent → subscription (rate × current billable_locations, + an optional
// one-time setup-fee invoice item on the first invoice only). Location-count changes AFTER
// activation are pushed to the subscription's quantity by a separate worker
// (src/lib/billing/quantity-sync.ts) polling billing_snapshots — see that file for why this
// can't just happen inline in createLocation/updateLocation (db.transaction() callbacks must
// be fully synchronous; a Stripe call can't live inside one).

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';
import { isValidTimeZone } from '@/lib/time/zone';
import { env } from '@/lib/env';
import { createTenant, getTenantById, updateTenant, isSlugTaken, isValidSlug, type Tenant } from './tenants';
import { createUser } from './users';
import { createLocation } from './locations';
import { getTemplate, applyTemplate } from '@/lib/requirements/templates';
import { issueInviteToken, issueBillingSetupToken } from './password-reset';
import type { BillingProvider } from '@/lib/billing/provider';

export interface ProvisionInput {
  name: string;
  slug: string; // REQUIRED, unique tenant identifier (Slice 4)
  timezone: string; // REQUIRED, validated IANA zone (OPS-7 input)
  firstAdmin: { email: string; name: string }; // no password — invite/deferred-credential
  locations?: { name: string; address?: string }[];
  templateId: string;
  monthlyRateCents?: number; // per-location rate (default $90)
  setupFeeCents?: number; // one-time fee, first invoice only (Slice 5a). Omitted = none.
}

export interface BillingAttachResult {
  attached: boolean;
  customerId: string | null;
  setupIntentClientSecret: string | null;
  subscriptionId: string | null;
  /** The link the operator sends the customer to enter a card (Slice 5a.1). Null iff attached=false. */
  billingSetupUrl: string | null;
  error?: string;
}

export interface ProvisionResult {
  tenant: Tenant;
  adminUserId: string;
  locationIds: string[];
  billing: BillingAttachResult;
}

export interface ActivationResult {
  adminUserId: string;
  invite: { rawToken: string; inviteUrl: string; expiresAt: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409 });
}

/**
 * Attach (or retry-attach) Stripe billing for a tenant: customer → SetupIntent → recurring
 * subscription (rate × current billable location count, + a one-time setup fee on the first
 * invoice if set). Shared by provisionTenant's post-commit step AND the wizard's "Retry
 * billing" action — one function, so a retry is exactly the same call, not a
 * re-implementation. Never throws: a Stripe failure is a structured `{ attached: false, error }`
 * result, not an exception, so the tenant is never left in an ambiguous state. Every Stripe
 * call here is idempotency-keyed off `provision:<tenantId>` (suffixed per resource), so a retry
 * after a partial failure reuses whatever already succeeded — no dupes.
 */
export async function attachBilling(
  db: Database.Database,
  tenantId: string,
  billing: BillingProvider,
  platformUserId: string
): Promise<BillingAttachResult> {
  const tenant = getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const admin = db
    .prepare(`SELECT id, email, name FROM users WHERE tenant_id = ? AND role = 'admin' ORDER BY created_at LIMIT 1`)
    .get(tenantId) as { id: string; email: string; name: string } | undefined;
  if (!admin) throw Object.assign(new Error('Tenant has no admin user to bill'), { status: 409 });

  try {
    const idempotencyKey = `provision:${tenantId}`;
    const customer = await billing.createCustomer({
      tenantId,
      name: tenant.name,
      email: admin.email,
      idempotencyKey,
    });
    const si = await billing.createSetupIntent({ customerId: customer.customerId });

    // Quantity is authoritative from billing_snapshots — the latest row is the current
    // billable count (createTenant always writes an initial 0-location row, then createLocation
    // writes one per location added during provisioning, so this reads the just-provisioned
    // count). Ordered by rowid, not created_at: provisioning can write several snapshot rows
    // within the same millisecond (one per location), and ISO-string created_at ties resolve
    // arbitrarily — rowid is a reliable, monotonically-increasing insertion-order tiebreaker.
    const latestSnapshot = db
      .prepare(`SELECT billable_locations FROM billing_snapshots WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(tenantId) as { billable_locations: number } | undefined;
    const quantity = latestSnapshot?.billable_locations ?? 0;

    const subscription = await billing.createSubscription({
      customerId: customer.customerId,
      unitAmountCents: tenant.monthly_rate_cents,
      quantity,
      setupFeeCents: tenant.setup_fee_cents,
      idempotencyKey: `${idempotencyKey}:subscription`,
    });

    db.prepare('UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ?, stripe_setup_intent_id = ? WHERE id = ?')
      .run(customer.customerId, subscription.subscriptionId, si.setupIntentId, tenantId);

    // The subscription's initial quantity already reflects every snapshot taken up to this
    // point (all pre-activation) — mark them synced so the quantity-sync worker's first tick
    // after activation doesn't redundantly re-push the same number it just saw appear.
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE billing_snapshots SET stripe_synced_at = ? WHERE tenant_id = ? AND stripe_synced_at IS NULL`)
      .run(nowIso, tenantId);

    logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'billing.customer_attached',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { attached: true },
    });
    logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'billing.subscription_created',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { quantity, unit_amount_cents: tenant.monthly_rate_cents, setup_fee_cents: tenant.setup_fee_cents ?? null },
    });

    // The link the operator sends the customer (Slice 5a.1) — revisitable, not single-use, so
    // a fresh one each successful attach/retry is harmless (old ones for this tenant still
    // resolve fine too; nothing invalidates them).
    const { rawToken } = issueBillingSetupToken(db, { tenantId, userId: admin.id });
    const billingSetupUrl = `${env.app.baseUrl}/billing/setup?token=${rawToken}`;

    return {
      attached: true,
      customerId: customer.customerId,
      setupIntentClientSecret: si.clientSecret,
      subscriptionId: subscription.subscriptionId,
      billingSetupUrl,
    };
  } catch (err) {
    // Recoverable: 'provisioning' tenant, no customer/subscription, non-billable, activation-gated. No orphan.
    return { attached: false, customerId: null, setupIntentClientSecret: null, subscriptionId: null, billingSetupUrl: null, error: (err as Error).message };
  }
}

/**
 * Activate a tenant on its first Stripe payment (invoice.paid webhook, billing_reason ===
 * 'subscription_create' — see stripe-webhook.ts). Idempotent: a redelivered webhook event for
 * an already-active tenant is a no-op (returns null), never a duplicate invite/activation.
 * This is where Slice 4's invite issuance moved to — gated on payment, not on the DB commit.
 */
export function activateTenantOnFirstPayment(
  db: Database.Database,
  tenantId: string,
  now: Date = new Date()
): ActivationResult | null {
  const tenant = getTenantById(db, tenantId);
  if (!tenant || tenant.lifecycle_state !== 'provisioning') return null; // already active, or unknown tenant

  const admin = db
    .prepare(`SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' ORDER BY created_at LIMIT 1`)
    .get(tenantId) as { id: string } | undefined;
  if (!admin) return null; // shouldn't happen — provisioning always creates one

  // updateTenant's audit call is hardcoded actorType:'platform' — there's no 'webhook' actor
  // type in the audit vocabulary (system|ai|user|vendor|platform) that fits better; actorId
  // 'stripe-webhook' at least distinguishes this from an actual platform-user click.
  updateTenant(db, tenantId, { lifecycleState: 'active' }, 'stripe-webhook');

  const { rawToken, expiresAt } = issueInviteToken(db, { tenantId, userId: admin.id }, now);
  logAudit(db, {
    tenantId,
    actorType: 'system',
    actorId: 'stripe-webhook',
    eventType: 'admin.invite_issued',
    targetType: 'user',
    targetId: admin.id,
  });

  // Same path requestPasswordReset already builds — one token table, one landing path,
  // whichever flow minted the token (see src/app/reset-password/page.tsx, Slice 4a).
  return { adminUserId: admin.id, invite: { rawToken, inviteUrl: `${env.app.baseUrl}/reset-password?token=${rawToken}`, expiresAt } };
}

export async function provisionTenant(
  db: Database.Database,
  input: ProvisionInput,
  platformUserId: string,
  billing: BillingProvider
): Promise<ProvisionResult> {
  // ── Validate up front (before any writes) — fails loud, never half-written ──
  if (!input.name?.trim()) bad('name is required');
  if (!isValidSlug(input.slug ?? '')) bad('a valid slug (lowercase letters, numbers, hyphens) is required');
  if (isSlugTaken(db, input.slug)) conflict(`Slug "${input.slug}" is already in use`);
  if (!isValidTimeZone(input.timezone)) bad('a valid IANA timezone is required');
  if (!input.firstAdmin || !EMAIL_RE.test(input.firstAdmin.email ?? '')) bad('a valid first-admin email is required');
  if (!input.firstAdmin.name?.trim()) bad('first-admin name is required');
  if (!input.templateId || !getTemplate(db, input.templateId)) bad('a valid requirements template is required');
  if (input.monthlyRateCents !== undefined && (!Number.isInteger(input.monthlyRateCents) || input.monthlyRateCents < 0)) {
    bad('per-location rate must be a non-negative integer number of cents');
  }
  if (input.setupFeeCents !== undefined && (!Number.isInteger(input.setupFeeCents) || input.setupFeeCents < 0)) {
    bad('setup fee must be a non-negative integer number of cents');
  }
  for (const loc of input.locations ?? []) {
    if (!loc.name?.trim()) bad('every location needs a name');
  }

  // ── 1. Atomic DB core (all-or-nothing) ──
  const tx = db.transaction((): { tenant: Tenant; adminUserId: string; locationIds: string[] } => {
    const tenant = createTenant(
      db,
      { name: input.name, slug: input.slug, monthlyRateCents: input.monthlyRateCents, setupFeeCents: input.setupFeeCents, timezone: input.timezone },
      platformUserId
    );
    const admin = createUser(
      db,
      tenant.id,
      { email: input.firstAdmin.email, name: input.firstAdmin.name, role: 'admin' }, // no password → 'invited'
      platformUserId,
      { locationIds: null, regionIds: null }, // org-wide (admin); scope checks skipped for role='admin'
      'admin'
    );
    const locationIds = (input.locations ?? []).map(
      (l) => createLocation(db, tenant.id, { name: l.name, address: l.address }, platformUserId).id
    );
    // Template rules are attributed to the first Admin (requirement_rules.created_by → users(id));
    // the platform user isn't a tenant user, so it can't be the creator.
    applyTemplate(db, tenant.id, input.templateId, admin.id);

    logAudit(db, {
      tenantId: tenant.id,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'tenant.provisioned',
      targetType: 'tenant',
      targetId: tenant.id,
      payload: { admin_user_id: admin.id, location_count: locationIds.length, template_id: input.templateId, timezone: input.timezone },
    });
    return { tenant, adminUserId: admin.id, locationIds };
  });
  const core = tx(); // COMMITS here

  // ── 2. Billing attach — AFTER commit (external call; can't be inside the DB tx) ──
  // No invite is issued here anymore (Slice 5a) — activateTenantOnFirstPayment mints it once
  // the first invoice is actually paid (see the stripe-webhook.ts invoice.paid handler).
  const billingResult = await attachBilling(db, core.tenant.id, billing, platformUserId);

  return { ...core, billing: billingResult };
}
