// Provisioning (OPS-8 core + OPS-7 input + billing-attach). The audited platform transaction
// that turns "a sales conversation" into a ready-to-activate tenant: tenant + first Admin +
// locations + requirements template + a REQUIRED validated timezone, all through the real
// services (audit + invariants hold) — never the raw-SQL dev-seed path.
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
//      (activation, Slice 5, is gated on stripe_customer_id). So NO orphaned live tenant.

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';
import { isValidTimeZone } from '@/lib/time/zone';
import { createTenant, type Tenant } from './tenants';
import { createUser } from './users';
import { createLocation } from './locations';
import { getTemplate, applyTemplate } from '@/lib/requirements/templates';
import type { BillingProvider } from '@/lib/billing/provider';

export interface ProvisionInput {
  name: string;
  timezone: string; // REQUIRED, validated IANA zone (OPS-7 input)
  firstAdmin: { email: string; name: string; password: string };
  locations?: { name: string; address?: string }[];
  templateId: string;
  monthlyRateCents?: number; // operator-set per-location price (default $90)
}

export interface ProvisionResult {
  tenant: Tenant;
  adminUserId: string;
  locationIds: string[];
  billing: { attached: boolean; customerId: string | null; setupIntentClientSecret: string | null; error?: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export async function provisionTenant(
  db: Database.Database,
  input: ProvisionInput,
  platformUserId: string,
  billing: BillingProvider
): Promise<ProvisionResult> {
  // ── Validate up front (before any writes) ──
  if (!input.name?.trim()) bad('name is required');
  if (!isValidTimeZone(input.timezone)) bad('a valid IANA timezone is required');
  if (!input.firstAdmin || !EMAIL_RE.test(input.firstAdmin.email ?? '')) bad('a valid first-admin email is required');
  if (!input.firstAdmin.name?.trim()) bad('first-admin name is required');
  if (!input.firstAdmin.password || input.firstAdmin.password.length < 8) bad('first-admin password must be at least 8 characters');
  if (!input.templateId || !getTemplate(db, input.templateId)) bad('a valid requirements template is required');
  for (const loc of input.locations ?? []) {
    if (!loc.name?.trim()) bad('every location needs a name');
  }

  // ── 1. Atomic DB core (all-or-nothing) ──
  const tx = db.transaction((): { tenant: Tenant; adminUserId: string; locationIds: string[] } => {
    const tenant = createTenant(
      db,
      { name: input.name, monthlyRateCents: input.monthlyRateCents, timezone: input.timezone },
      platformUserId
    );
    const admin = createUser(
      db,
      tenant.id,
      { email: input.firstAdmin.email, name: input.firstAdmin.name, role: 'admin', password: input.firstAdmin.password },
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
  try {
    const customer = await billing.createCustomer({
      tenantId: core.tenant.id,
      name: input.name.trim(),
      email: input.firstAdmin.email,
      idempotencyKey: `provision:${core.tenant.id}`,
    });
    const si = await billing.createSetupIntent({ customerId: customer.customerId });
    db.prepare('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?').run(customer.customerId, core.tenant.id);
    logAudit(db, {
      tenantId: core.tenant.id,
      actorType: 'platform',
      actorId: platformUserId,
      eventType: 'billing.customer_attached',
      targetType: 'tenant',
      targetId: core.tenant.id,
      payload: { attached: true },
    });
    return { ...core, billing: { attached: true, customerId: customer.customerId, setupIntentClientSecret: si.clientSecret } };
  } catch (err) {
    // Recoverable: 'provisioning' tenant, no customer, non-billable, activation-gated. No orphan.
    return { ...core, billing: { attached: false, customerId: null, setupIntentClientSecret: null, error: (err as Error).message } };
  }
}
