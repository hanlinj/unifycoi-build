// Provisioning (OPS-8 core + OPS-7 input). The audited platform transaction that turns "a sales
// conversation" into a ready-to-activate tenant: tenant + first Admin + locations + requirements
// template + a REQUIRED validated timezone, all through the real services (audit + invariants
// hold) — never the raw-SQL dev-seed path.
//
// ── DB-commit / Stripe-call boundary (the load-bearing bit) ──────────────────────────────
// A DB transaction cannot wrap an external network call. So:
//   1. The DB transaction commits the core atomically (tenant+admin+locations+template). If
//      any step throws, it all rolls back — no partial/orphan tenant.
//   2. AFTER commit, the Stripe customer + SetupIntent are created, then stripe_customer_id
//      is stored. Ordering is create-tenant-then-customer, so a Stripe customer is only ever
//      created for a tenant that already exists → NO orphaned customer-without-tenant.
//   3. If the Stripe step fails, the tenant stays in 'provisioning' with stripe_customer_id
//      NULL and billing.attached=false — recoverable (retry is idempotent via the
//      provision:<tenantId> key → reuses the same customer, no dupes) and NON-billable
//      (activation is gated on stripe_customer_id). So NO orphaned live tenant. attachBilling
//      is its own exported function (not inlined) so the wizard's "Retry billing" action
//      (POST /api/platform/tenants/:id/retry-billing) can call the exact same code path.
//
// ── Credential model (Slice 4) ─────────────────────────────────────────────────────────
// The wizard never handles a password. The first Admin is created 'invited' (no password_hash
// — createUser's existing no-password branch), and an invite token is minted immediately at
// provision time by reusing password_reset_tokens/generateResetToken verbatim (same hash-at-rest,
// same expiry shape) rather than a parallel token system. confirmPasswordReset flips
// invited→active on first credential set — the same operation serves both a password reset and
// a first-login accept.

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';
import { isValidTimeZone } from '@/lib/time/zone';
import { env } from '@/lib/env';
import { createTenant, getTenantById, isSlugTaken, isValidSlug, type Tenant } from './tenants';
import { createUser } from './users';
import { createLocation } from './locations';
import { getTemplate, applyTemplate } from '@/lib/requirements/templates';
import { issueInviteToken } from './password-reset';
import type { BillingProvider } from '@/lib/billing/provider';

export interface ProvisionInput {
  name: string;
  slug: string; // REQUIRED, unique tenant identifier (Slice 4)
  timezone: string; // REQUIRED, validated IANA zone (OPS-7 input)
  firstAdmin: { email: string; name: string }; // no password — invite/deferred-credential
  locations?: { name: string; address?: string }[];
  templateId: string;
  monthlyRateCents?: number; // operator-set per-location price (default $90)
}

export interface BillingAttachResult {
  attached: boolean;
  customerId: string | null;
  setupIntentClientSecret: string | null;
  error?: string;
}

export interface ProvisionResult {
  tenant: Tenant;
  adminUserId: string;
  locationIds: string[];
  billing: BillingAttachResult;
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
 * Attach (or retry-attach) Stripe billing for a tenant: customer → SetupIntent (card on file).
 * Shared by provisionTenant's post-commit step AND the wizard's "Retry billing" action — one
 * function, so a retry is exactly the same call, not a re-implementation. Never throws: a
 * Stripe failure is a structured `{ attached: false, error }` result, not an exception, so the
 * tenant is never left in an ambiguous state. Idempotency-keyed off `provision:<tenantId>`, so a
 * retry after a partial failure reuses the same customer — no dupes.
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

    db.prepare('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?').run(customer.customerId, tenantId);

    logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'billing.customer_attached',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { attached: true },
    });

    return { attached: true, customerId: customer.customerId, setupIntentClientSecret: si.clientSecret };
  } catch (err) {
    // Recoverable: 'provisioning' tenant, no customer, non-billable, activation-gated. No orphan.
    return { attached: false, customerId: null, setupIntentClientSecret: null, error: (err as Error).message };
  }
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
  for (const loc of input.locations ?? []) {
    if (!loc.name?.trim()) bad('every location needs a name');
  }

  // ── 1. Atomic DB core (all-or-nothing) ──
  const tx = db.transaction((): {
    tenant: Tenant;
    adminUserId: string;
    locationIds: string[];
    invite: { rawToken: string; inviteUrl: string; expiresAt: string };
  } => {
    const tenant = createTenant(
      db,
      { name: input.name, slug: input.slug, monthlyRateCents: input.monthlyRateCents, timezone: input.timezone },
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

    const { rawToken, expiresAt } = issueInviteToken(db, { tenantId: tenant.id, userId: admin.id });

    logAudit(db, {
      tenantId: tenant.id,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'tenant.provisioned',
      targetType: 'tenant',
      targetId: tenant.id,
      payload: { admin_user_id: admin.id, location_count: locationIds.length, template_id: input.templateId, timezone: input.timezone },
    });
    return {
      tenant,
      adminUserId: admin.id,
      locationIds,
      invite: { rawToken, inviteUrl: `${env.app.baseUrl}/reset-password?token=${rawToken}`, expiresAt },
    };
  });
  const core = tx(); // COMMITS here

  // ── 2. Billing attach — AFTER commit (external call; can't be inside the DB tx) ──
  const billingResult = await attachBilling(db, core.tenant.id, billing, platformUserId);

  return { ...core, billing: billingResult };
}
