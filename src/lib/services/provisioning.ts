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
// (src/lib/billing/quantity-sync.ts) polling billing_snapshots.
//
// Phase 13 migration note: this split was originally forced by better-sqlite3's requirement
// that a db.transaction() callback be fully synchronous (a Stripe call couldn't live inside
// one). Kysely/Postgres transactions ARE async-capable, so that specific constraint no longer
// applies — but the separate-poller architecture is kept as-is this pass (foundation only, no
// behavior/design changes); revisiting it is a deliberate future call, not something to change
// incidentally while just swapping the data layer underneath it.

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { withTransaction } from '@/lib/db/transaction';
import { logAudit } from '@/lib/audit';
import { isValidTimeZone } from '@/lib/time/zone';
import { env } from '@/lib/env';
import { createTenant, getTenantById, updateTenant, isSlugTaken, isValidSlug, type Tenant } from './tenants';
import { createUser } from './users';
import { createLocation } from './locations';
import { getTemplate, applyTemplate } from '@/lib/requirements/templates';
import { issueInviteToken, issueBillingSetupToken } from './password-reset';
import type { BillingProvider } from '@/lib/billing/provider';
import type { Mailer } from '@/lib/notifications/mailer';
import { resolveFrom } from '@/lib/notifications/mailer';

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
  /** So the caller (stripe-webhook.ts) can email the invite without a second lookup. */
  adminEmail: string;
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
  db: Db,
  tenantId: string,
  billing: BillingProvider,
  platformUserId: string
): Promise<BillingAttachResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const admin = await db
    .selectFrom('users')
    .select(['id', 'email', 'name'])
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
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
    // count). Ordered by seq, not created_at: provisioning can write several snapshot rows
    // within the same millisecond (one per location), and timestamp ties resolve arbitrarily —
    // seq (bigserial, Stage 4's rowid replacement) is a reliable, monotonically-increasing
    // insertion-order tiebreaker.
    const latestSnapshot = await db
      .selectFrom('billing_snapshots')
      .select('billable_locations')
      .where('tenant_id', '=', tenantId)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const quantity = latestSnapshot?.billable_locations ?? 0;

    const subscription = await billing.createSubscription({
      customerId: customer.customerId,
      unitAmountCents: tenant.monthly_rate_cents,
      quantity,
      setupFeeCents: tenant.setup_fee_cents,
      idempotencyKey: `${idempotencyKey}:subscription`,
    });

    await db
      .updateTable('tenants')
      .set({ stripe_customer_id: customer.customerId, stripe_subscription_id: subscription.subscriptionId, stripe_setup_intent_id: si.setupIntentId })
      .where('id', '=', tenantId)
      .execute();

    // The subscription's initial quantity already reflects every snapshot taken up to this
    // point (all pre-activation) — mark them synced so the quantity-sync worker's first tick
    // after activation doesn't redundantly re-push the same number it just saw appear.
    await db
      .updateTable('billing_snapshots')
      .set({ stripe_synced_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('stripe_synced_at', 'is', null)
      .execute();

    await logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'billing.customer_attached',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { attached: true },
    });
    await logAudit(db, {
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
    const { rawToken } = await issueBillingSetupToken(db, { tenantId, userId: admin.id });
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
export async function activateTenantOnFirstPayment(
  db: Db,
  tenantId: string,
  now: Date = new Date()
): Promise<ActivationResult | null> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant || tenant.lifecycle_state !== 'provisioning') return null; // already active, or unknown tenant

  const admin = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!admin) return null; // shouldn't happen — provisioning always creates one

  // updateTenant's audit call is hardcoded actorType:'platform' — there's no 'webhook' actor
  // type in the audit vocabulary (system|ai|user|vendor|platform) that fits better; actorId
  // 'stripe-webhook' at least distinguishes this from an actual platform-user click.
  await updateTenant(db, tenantId, { lifecycleState: 'active' }, 'stripe-webhook');

  const { rawToken, expiresAt } = await issueInviteToken(db, { tenantId, userId: admin.id }, now);
  // Records that the credential was MINTED, not that it was delivered — deliberately kept as
  // its original meaning (a valid invite now exists) rather than repurposed to mean "sent",
  // since minting happens here but the actual send is a separate, best-effort step the caller
  // (stripe-webhook.ts) performs afterward and can fail independently. See
  // admin.invite_emailed for the delivery-confirmation signal.
  await logAudit(db, {
    tenantId,
    actorType: 'system',
    actorId: 'stripe-webhook',
    eventType: 'admin.invite_issued',
    targetType: 'user',
    targetId: admin.id,
  });

  // Same path requestPasswordReset already builds — one token table, one landing path,
  // whichever flow minted the token (see src/app/reset-password/page.tsx, Slice 4a).
  return {
    adminUserId: admin.id,
    adminEmail: admin.email,
    invite: { rawToken, inviteUrl: `${env.app.baseUrl}/reset-password?token=${rawToken}`, expiresAt },
  };
}

export interface ResendResult {
  inviteUrl: string;
  expiresAt: string;
}

/**
 * Resend the first Admin's credential-set invite link from the tenant cockpit (Slice 6, closes
 * the OPS-14 remainder). Reuses issueInviteToken verbatim — the SAME primitive
 * activateTenantOnFirstPayment uses, not a new issuer. Deliberately NOT sendUserInvite
 * (src/lib/services/users.ts): that function's audit call is hardcoded actorType:'user' for a
 * tenant-Admin caller, which would misattribute a platform-initiated resend. Same status guard
 * as sendUserInvite (only a dormant/invited admin can be resent a link) and the same
 * non-invalidating resend semantics (confirmPasswordReset invalidates every sibling token the
 * moment any one is used, so there is never more than one *usable* outcome).
 */
export async function resendFirstAdminInvite(
  db: Db,
  tenantId: string,
  platformUserId: string,
  now: Date = new Date()
): Promise<ResendResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const admin = await db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!admin) throw Object.assign(new Error('Tenant has no admin user to invite'), { status: 409 });
  if (admin.status !== 'invited') {
    throw Object.assign(new Error('The first Admin has already accepted their invite — nothing to resend'), { status: 409 });
  }

  const { rawToken, expiresAt } = await issueInviteToken(db, { tenantId, userId: admin.id }, now);
  await db.updateTable('users').set({ invite_sent_at: now }).where('id', '=', admin.id).where('tenant_id', '=', tenantId).execute();

  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId: platformUserId,
    eventType: 'admin.invite_resent',
    targetType: 'user',
    targetId: admin.id,
  });

  return { inviteUrl: `${env.app.baseUrl}/reset-password?token=${rawToken}`, expiresAt };
}

export interface SendAdminInviteEmailResult {
  sent: boolean;
  recipientEmail: string;
  inviteUrl: string;
  expiresAt: string;
  error?: string;
}

/**
 * Resend AND actually email the first Admin's credential-set invite — the tenant cockpit's
 * "Resend admin invite" button. Same guard/mint/stamp/audit shape as resendFirstAdminInvite
 * (only a dormant/invited admin can be resent a link — kept as a separate, self-contained
 * function rather than composing over it, same "each caller does its own lookup" style
 * sendBillingSetupLinkEmail/attachBilling/resendBillingSetupLink already use), plus the actual
 * send via the given Mailer using sendBillingSetupLinkEmail's proven shape — never throws on a
 * send failure; the link is returned either way so the cockpit can still show it as a copyable
 * fallback (same "sent AND copyable" pattern as the provisioning wizard's completion step).
 */
export async function sendAdminInviteEmail(
  db: Db,
  tenantId: string,
  mailer: Mailer,
  platformUserId: string,
  now: Date = new Date()
): Promise<SendAdminInviteEmailResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const admin = await db
    .selectFrom('users')
    .select(['id', 'email', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!admin) throw Object.assign(new Error('Tenant has no admin user to invite'), { status: 409 });
  if (admin.status !== 'invited') {
    throw Object.assign(new Error('The first Admin has already accepted their invite — nothing to resend'), { status: 409 });
  }

  const { rawToken, expiresAt } = await issueInviteToken(db, { tenantId, userId: admin.id }, now);
  const inviteUrl = `${env.app.baseUrl}/reset-password?token=${rawToken}`;
  await db.updateTable('users').set({ invite_sent_at: now }).where('id', '=', admin.id).where('tenant_id', '=', tenantId).execute();

  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId: platformUserId,
    eventType: 'admin.invite_resent',
    targetType: 'user',
    targetId: admin.id,
  });

  const from = resolveFrom('internal', null);
  const result = await mailer.send({
    to: admin.email,
    fromName: from.fromName,
    fromEmail: from.fromEmail,
    subject: `You're invited to ${tenant.name} on UnifyCOI`,
    body:
      `Set your password to finish setting up your account:\n\n${inviteUrl}\n\n` +
      `This link expires ${expiresAt}.`,
  });

  if (!result.ok) {
    return { sent: false, recipientEmail: admin.email, inviteUrl, expiresAt, error: result.error ?? 'send failed' };
  }

  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId: platformUserId,
    eventType: 'admin.invite_emailed',
    targetType: 'user',
    targetId: admin.id,
    payload: { recipient: admin.email },
  });
  return { sent: true, recipientEmail: admin.email, inviteUrl, expiresAt };
}

/**
 * Resend the billing-setup link from the tenant cockpit (Slice 6). Reuses issueBillingSetupToken
 * verbatim — the SAME issuer attachBilling calls. No status guard: unlike the credential invite,
 * a billing-setup link isn't gated on the target user's account state (it never touches a
 * password), so it's always resendable once a subscription exists to attach a card to.
 */
export async function resendBillingSetupLink(
  db: Db,
  tenantId: string,
  platformUserId: string,
  now: Date = new Date()
): Promise<ResendResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  if (!tenant.stripe_customer_id) {
    throw Object.assign(new Error('Billing has not been attached for this tenant yet — nothing to send'), { status: 409 });
  }
  const admin = await db
    .selectFrom('users')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!admin) throw Object.assign(new Error('Tenant has no admin user to bill'), { status: 409 });

  const { rawToken, expiresAt } = await issueBillingSetupToken(db, { tenantId, userId: admin.id }, now);

  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId: platformUserId,
    eventType: 'billing.setup_link_resent',
    targetType: 'tenant',
    targetId: tenantId,
  });

  return { inviteUrl: `${env.app.baseUrl}/billing/setup?token=${rawToken}`, expiresAt };
}

export interface SendBillingLinkEmailResult {
  sent: boolean;
  recipientEmail: string;
  billingSetupUrl: string;
  expiresAt: string;
  error?: string;
}

/**
 * Email the billing-setup link to the tenant's first Admin — the completion-step "Send via
 * email" action (operator-triggered only; never auto-sent, so the channel/timing stay in the
 * operator's control — copy-link remains the alternative for Teams/Messenger/text). Mints a
 * fresh token via issueBillingSetupToken (same primitive attachBilling/resendBillingSetupLink
 * use — revisitable, not single-use, so this doesn't invalidate the link already shown on
 * screen). Sends synchronously via the given Mailer (not the async notification queue) so the
 * caller can report the TRUE delivery outcome, not just "queued".
 */
export async function sendBillingSetupLinkEmail(
  db: Db,
  tenantId: string,
  mailer: Mailer,
  platformUserId: string
): Promise<SendBillingLinkEmailResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  if (!tenant.stripe_customer_id) {
    throw Object.assign(new Error('Billing has not been attached for this tenant yet — nothing to send'), { status: 409 });
  }
  const admin = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!admin) throw Object.assign(new Error('Tenant has no admin user to bill'), { status: 409 });

  const { rawToken, expiresAt } = await issueBillingSetupToken(db, { tenantId, userId: admin.id });
  const billingSetupUrl = `${env.app.baseUrl}/billing/setup?token=${rawToken}`;
  const from = resolveFrom('internal', null);

  const result = await mailer.send({
    to: admin.email,
    fromName: from.fromName,
    fromEmail: from.fromEmail,
    subject: `Set up billing for ${tenant.name}`,
    body:
      `Please set up billing for ${tenant.name} using the secure link below:\n\n${billingSetupUrl}\n\n` +
      `Card entry happens entirely on Stripe's own secure form — nothing here ever sees your card number.`,
  });

  if (!result.ok) {
    return { sent: false, recipientEmail: admin.email, billingSetupUrl, expiresAt, error: result.error ?? 'send failed' };
  }

  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId: platformUserId,
    eventType: 'billing.setup_link_emailed',
    targetType: 'tenant',
    targetId: tenantId,
    payload: { recipient: admin.email },
  });
  return { sent: true, recipientEmail: admin.email, billingSetupUrl, expiresAt };
}

export interface RateUpdateResult {
  monthlyRateCents: number; // the rate now in effect (unchanged from before if this failed)
  pushedToStripe: boolean; // true iff a live subscription existed and was updated
  error?: string; // present iff the Stripe push failed — local rate was NOT changed either
}

/**
 * Edit a tenant's per-location rate from the cockpit (Slice 6). Stripe Prices are immutable, so
 * a rate change is always create-a-new-Price + repoint-the-subscription-item (see
 * StripeBillingProvider.updateSubscriptionPrice) — never an edit of the existing Price.
 * `proration_behavior: 'none'`, same rule as quantity-sync: the new rate takes effect at the
 * NEXT billing cycle, never a mid-month partial charge.
 *
 * Consistency, the whole point of this function: if a live subscription exists, the Stripe push
 * happens FIRST — the local `monthly_rate_cents` column is only written after Stripe confirms
 * the swap. A Stripe failure returns a structured `{ pushedToStripe: false, error }` result
 * (same non-throwing shape as attachBilling) and leaves the local rate COMPLETELY UNCHANGED —
 * never a local rate Stripe isn't actually charging. If no subscription exists yet
 * (pre-activation), there's nothing live to push to; the local rate is simply what
 * attachBilling will use whenever it eventually runs.
 */
export async function updateTenantRate(
  db: Db,
  tenantId: string,
  newRateCents: number,
  billing: BillingProvider,
  actorId: string
): Promise<RateUpdateResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  if (!Number.isInteger(newRateCents) || newRateCents < 0) {
    throw Object.assign(new Error('rate must be a non-negative integer number of cents'), { status: 400 });
  }

  if (!tenant.stripe_subscription_id) {
    // Pre-attach: nothing live to push to. The local column IS the source of truth until
    // attachBilling runs and reads it.
    await updateTenant(db, tenantId, { monthlyRateCents: newRateCents }, actorId);
    return { monthlyRateCents: newRateCents, pushedToStripe: false };
  }

  try {
    await billing.updateSubscriptionPrice({
      subscriptionId: tenant.stripe_subscription_id,
      unitAmountCents: newRateCents,
      idempotencyKey: `rate-update:${tenantId}:${randomUUID()}`,
    });
  } catch (err) {
    // Stripe rejected the swap — the local rate is NOT touched. No divergence: what's in the DB
    // still matches what Stripe is actually charging.
    return { monthlyRateCents: tenant.monthly_rate_cents, pushedToStripe: false, error: (err as Error).message };
  }

  // Stripe confirmed the swap — NOW (and only now) commit the local column to match.
  await updateTenant(db, tenantId, { monthlyRateCents: newRateCents }, actorId);
  // Distinct from tenant.settings_changed (which updateTenant already logs with a from/to
  // payload) — this one specifically attests that the change actually reached Stripe, not just
  // the local column, for the same defensibility reason attachBilling logs
  // billing.subscription_created as its own event alongside billing.customer_attached.
  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId,
    eventType: 'billing.rate_synced_to_stripe',
    targetType: 'tenant',
    targetId: tenantId,
    payload: { new_rate_cents: newRateCents, subscription_id: tenant.stripe_subscription_id },
  });
  return { monthlyRateCents: newRateCents, pushedToStripe: true };
}

export interface SetupFeeUpdateResult {
  setupFeeCents: number | null;
  updated: boolean;
  /** Present iff blocked — the fee was already invoiced to Stripe at billing attach. */
  blockedReason?: string;
}

/**
 * Edit a tenant's one-time setup fee from the cockpit (Slice 6). A setup fee is a PENDING
 * invoice item created once, synchronously, inside attachBilling — the moment a subscription
 * exists (tenant.stripe_subscription_id is set), that fee is already queued on Stripe's
 * open/first invoice, paid or not. Editing the local column after that point would be a lie:
 * Stripe would still charge whatever amount was queued at attach time, regardless of what the
 * local column says. So the gate is `stripe_subscription_id IS NOT NULL` — NOT
 * `lifecycle_state === 'active'` — because the fee is committed to Stripe at attach, before the
 * tenant has necessarily paid (activation is gated on the invoice.paid webhook, which fires
 * after attach). Pre-attach, this is a plain local column write (no Stripe call at all — there
 * is nothing to push to yet).
 */
export async function updateTenantSetupFee(
  db: Db,
  tenantId: string,
  newFeeCents: number | null,
  actorId: string
): Promise<SetupFeeUpdateResult> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  if (newFeeCents !== null && (!Number.isInteger(newFeeCents) || newFeeCents < 0)) {
    throw Object.assign(new Error('setup fee must be a non-negative integer number of cents, or null for none'), { status: 400 });
  }

  if (tenant.stripe_subscription_id) {
    return {
      setupFeeCents: tenant.setup_fee_cents,
      updated: false,
      blockedReason: 'The setup fee was already invoiced to Stripe when billing attached — it cannot be changed after the fact. A charge already queued or paid cannot be un-charged.',
    };
  }

  await updateTenant(db, tenantId, { setupFeeCents: newFeeCents }, actorId);
  return { setupFeeCents: newFeeCents, updated: true };
}

export async function provisionTenant(
  db: Db,
  input: ProvisionInput,
  platformUserId: string,
  billing: BillingProvider
): Promise<ProvisionResult> {
  // ── Validate up front (before any writes) — fails loud, never half-written ──
  if (!input.name?.trim()) bad('name is required');
  if (!isValidSlug(input.slug ?? '')) bad('a valid slug (lowercase letters, numbers, hyphens) is required');
  if (await isSlugTaken(db, input.slug)) conflict(`Slug "${input.slug}" is already in use`);
  if (!isValidTimeZone(input.timezone)) bad('a valid IANA timezone is required');
  if (!input.firstAdmin || !EMAIL_RE.test(input.firstAdmin.email ?? '')) bad('a valid first-admin email is required');
  if (!input.firstAdmin.name?.trim()) bad('first-admin name is required');
  if (!input.templateId || !(await getTemplate(db, input.templateId))) bad('a valid requirements template is required');
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
  const core = await withTransaction(db, async (trx): Promise<{ tenant: Tenant; adminUserId: string; locationIds: string[] }> => {
    const tenant = await createTenant(
      trx,
      { name: input.name, slug: input.slug, monthlyRateCents: input.monthlyRateCents, setupFeeCents: input.setupFeeCents, timezone: input.timezone },
      platformUserId
    );
    const admin = await createUser(
      trx,
      tenant.id,
      { email: input.firstAdmin.email, name: input.firstAdmin.name, role: 'admin' }, // no password → 'invited'
      platformUserId,
      { locationIds: null, regionIds: null }, // org-wide (admin); scope checks skipped for role='admin'
      'admin'
    );
    // Stage 0's catalogued N+1-in-.map() finding, live: recordBillingSnapshot (called by
    // createLocation) reads the current active-location COUNT then inserts the next snapshot —
    // running these concurrently (Promise.all) could interleave two reads of the same count and
    // produce a WRONG billing snapshot (e.g. two locations both reading count=2, both writing
    // count=3, losing the count=4 snapshot entirely). Sequential for...of preserves the same
    // one-at-a-time behavior the original synchronous .map() had — required for correctness
    // here, not just a mechanical await-insertion.
    const locationIds: string[] = [];
    for (const l of input.locations ?? []) {
      const loc = await createLocation(trx, tenant.id, { name: l.name, address: l.address }, platformUserId);
      locationIds.push(loc.id);
    }
    // Template rules are attributed to the first Admin (requirement_rules.created_by → users(id));
    // the platform user isn't a tenant user, so it can't be the creator.
    await applyTemplate(trx, tenant.id, input.templateId, admin.id);

    await logAudit(trx, {
      tenantId: tenant.id,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'tenant.provisioned',
      targetType: 'tenant',
      targetId: tenant.id,
      payload: { admin_user_id: admin.id, location_count: locationIds.length, template_id: input.templateId, timezone: input.timezone },
    });
    return { tenant, adminUserId: admin.id, locationIds };
  }); // COMMITS here

  // ── 2. Billing attach — AFTER commit (external call; can't be inside the DB tx) ──
  // No invite is issued here anymore (Slice 5a) — activateTenantOnFirstPayment mints it once
  // the first invoice is actually paid (see the stripe-webhook.ts invoice.paid handler).
  const billingResult = await attachBilling(db, core.tenant.id, billing, platformUserId);

  return { ...core, billing: billingResult };
}
