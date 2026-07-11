import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { logAudit } from '@/lib/audit';
import { issueToken } from '@/lib/auth/jwt';

export interface Tenant {
  id: string;
  name: string;
  slug: string | null;
  lifecycle_state: string;
  monthly_rate_cents: number;
  setup_fee_cents: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_setup_intent_id: string | null;
  /** The requirements template applied at provisioning (Phase 3) — null for a tenant that
   *  predates templates or never had one applied. Resolve the name via getTemplate/listTemplates. */
  applied_template_id: string | null;
  created_at: string;
}

export interface CreateTenantInput {
  name: string;
  slug?: string; // unique tenant identifier (Slice 4). Optional here; provisioning REQUIRES + validates it.
  monthlyRateCents?: number;
  setupFeeCents?: number; // one-time fee charged on the first invoice only (Slice 5a). Omitted = none.
  timezone?: string; // IANA zone (OPS-7). Optional here; provisioning REQUIRES + validates it.
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** True if `slug` is well-formed: lowercase alphanumerics separated by single hyphens. */
export function isValidSlug(slug: string): boolean {
  return !!slug && SLUG_RE.test(slug);
}

/** True if `slug` is already in use by another tenant. Pre-check for the wizard's Tenant step. */
export async function isSlugTaken(db: Db, slug: string): Promise<boolean> {
  const row = await db.selectFrom('tenants').select('id').where('slug', '=', slug).executeTakeFirst();
  return !!row;
}

export interface UpdateTenantInput {
  name?: string;
  monthlyRateCents?: number;
  setupFeeCents?: number | null;
  lifecycleState?: string;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  provisioning: ['active'],
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: ['active'],
};

const TENANT_COLUMNS = [
  'id', 'name', 'slug', 'lifecycle_state', 'monthly_rate_cents', 'setup_fee_cents',
  'stripe_customer_id', 'stripe_subscription_id', 'stripe_setup_intent_id', 'applied_template_id', 'created_at',
] as const;

export async function createTenant(
  db: Db,
  input: CreateTenantInput,
  actorId: string
): Promise<Tenant> {
  const id = randomUUID();
  const now = new Date();
  const rate = input.monthlyRateCents ?? 9000;

  // Backstop to the wizard's slug-uniqueness pre-check: a UNIQUE constraint violation here
  // (e.g. a race between two concurrent provisions) surfaces as a clean 409, not a raw
  // Postgres error deep in the transaction. Postgres's unique_violation SQLSTATE is '23505'
  // (was SQLite_CONSTRAINT_UNIQUE).
  try {
    await db
      .insertInto('tenants')
      .values({
        id, name: input.name.trim(), slug: input.slug ?? null, lifecycle_state: 'provisioning',
        monthly_rate_cents: rate, setup_fee_cents: input.setupFeeCents ?? null, timezone: input.timezone ?? null, created_at: now,
      })
      .execute();
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && input.slug) {
      throw Object.assign(new Error(`Slug "${input.slug}" is already in use`), { status: 409 });
    }
    throw err;
  }

  // Initial billing snapshot (0 locations) and requirement settings defaults
  await db.insertInto('billing_snapshots').values({ id: randomUUID(), tenant_id: id, billable_locations: 0, amount_cents: 0, changed: true, created_at: now }).execute();
  await db
    .insertInto('requirement_settings')
    .values({ tenant_id: id, precedence_policy: 'strictest' })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await logAudit(db, {
    tenantId: id,
    actorType: 'platform',
    actorId,
    eventType: 'tenant.created',
    targetType: 'tenant',
    targetId: id,
    payload: { name: input.name },
  });

  return db.selectFrom('tenants').select(TENANT_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow() as Promise<Tenant>;
}

export async function listTenants(db: Db): Promise<Tenant[]> {
  return db.selectFrom('tenants').select(TENANT_COLUMNS).orderBy('created_at', 'desc').execute() as Promise<Tenant[]>;
}

export async function getTenantById(db: Db, tenantId: string): Promise<Tenant | null> {
  const row = await db.selectFrom('tenants').select(TENANT_COLUMNS).where('id', '=', tenantId).executeTakeFirst();
  return (row as Tenant | undefined) ?? null;
}

export async function updateTenant(
  db: Db,
  tenantId: string,
  input: UpdateTenantInput,
  actorId: string
): Promise<Tenant> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });

  if (input.lifecycleState && input.lifecycleState !== tenant.lifecycle_state) {
    const allowed = VALID_TRANSITIONS[tenant.lifecycle_state] ?? [];
    if (!allowed.includes(input.lifecycleState)) {
      throw Object.assign(
        new Error(`Invalid lifecycle transition: ${tenant.lifecycle_state} → ${input.lifecycleState}`),
        { status: 400 }
      );
    }
    await db.updateTable('tenants').set({ lifecycle_state: input.lifecycleState }).where('id', '=', tenantId).execute();

    await logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId,
      eventType: 'tenant.lifecycle_changed',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { from: tenant.lifecycle_state, to: input.lifecycleState },
    });
  }

  const settingsChanges: Record<string, { from: unknown; to: unknown }> = {};
  if (input.name !== undefined && input.name.trim() !== tenant.name) {
    settingsChanges['name'] = { from: tenant.name, to: input.name.trim() };
    await db.updateTable('tenants').set({ name: input.name.trim() }).where('id', '=', tenantId).execute();
  }
  if (input.monthlyRateCents !== undefined && input.monthlyRateCents !== tenant.monthly_rate_cents) {
    settingsChanges['monthly_rate_cents'] = { from: tenant.monthly_rate_cents, to: input.monthlyRateCents };
    await db.updateTable('tenants').set({ monthly_rate_cents: input.monthlyRateCents }).where('id', '=', tenantId).execute();
  }
  if (input.setupFeeCents !== undefined && input.setupFeeCents !== tenant.setup_fee_cents) {
    settingsChanges['setup_fee_cents'] = { from: tenant.setup_fee_cents, to: input.setupFeeCents };
    await db.updateTable('tenants').set({ setup_fee_cents: input.setupFeeCents }).where('id', '=', tenantId).execute();
  }

  // Audit tenant settings changes (name / billing rate) with before→after. A billing-rate
  // change with no trail is a defensibility hole (Audit_Trail.md). No Sensitive values here.
  if (Object.keys(settingsChanges).length > 0) {
    await logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId,
      eventType: 'tenant.settings_changed',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { changes: settingsChanges },
    });
  }

  return getTenantById(db, tenantId) as Promise<Tenant>;
}

export async function impersonateTenant(
  db: Db,
  tenantId: string,
  platformUserId: string
): Promise<string> {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });

  // Use the first active admin's ID as the subject, or a synthetic one if none exists
  const firstAdmin = await db
    .selectFrom('users')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'admin')
    .where('status', '!=', 'disabled')
    .limit(1)
    .executeTakeFirst();
  const sub = firstAdmin?.id ?? `system:${tenantId}`;

  const token = issueToken({
    sub,
    tenantId,
    role: 'admin',
    type: 'tenant',
    impersonatedBy: platformUserId,
  });

  await logAudit(db, {
    tenantId,
    actorType: 'platform',
    actorId: platformUserId,
    eventType: 'impersonation.started',
    targetType: 'tenant',
    targetId: tenantId,
    payload: { platform_user_id: platformUserId, impersonated_role: 'admin' },
  });

  return token;
}
