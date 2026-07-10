import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { issueToken } from '@/lib/auth/jwt';

export interface Tenant {
  id: string;
  name: string;
  slug: string | null;
  lifecycle_state: string;
  monthly_rate_cents: number;
  setup_fee_cents: number | null;
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
export function isSlugTaken(db: Database.Database, slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug);
}

export interface UpdateTenantInput {
  name?: string;
  monthlyRateCents?: number;
  lifecycleState?: string;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  provisioning: ['active'],
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: ['active'],
};

export function createTenant(
  db: Database.Database,
  input: CreateTenantInput,
  actorId: string
): Tenant {
  const id = randomUUID();
  const now = new Date().toISOString();
  const rate = input.monthlyRateCents ?? 9000;

  // Backstop to the wizard's slug-uniqueness pre-check: a UNIQUE constraint violation here
  // (e.g. a race between two concurrent provisions) surfaces as a clean 409, not a raw
  // SQLite error deep in the transaction.
  try {
    db.prepare(
      'INSERT INTO tenants (id, name, slug, lifecycle_state, monthly_rate_cents, setup_fee_cents, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.name.trim(), input.slug ?? null, 'provisioning', rate, input.setupFeeCents ?? null, input.timezone ?? null, now);
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' && input.slug) {
      throw Object.assign(new Error(`Slug "${input.slug}" is already in use`), { status: 409 });
    }
    throw err;
  }

  // Initial billing snapshot (0 locations) and requirement settings defaults
  const tdb = new TenantDB(db, id);
  tdb.insert('billing_snapshots', { id: randomUUID(), billable_locations: 0, amount_cents: 0, changed: 1, created_at: now });
  db.prepare(
    'INSERT OR IGNORE INTO requirement_settings (tenant_id, precedence_policy) VALUES (?, ?)'
  ).run(id, 'strictest');

  logAudit(db, {
    tenantId: id,
    actorType: 'platform',
    actorId,
    eventType: 'tenant.created',
    targetType: 'tenant',
    targetId: id,
    payload: { name: input.name },
  });

  return db.prepare('SELECT id, name, slug, lifecycle_state, monthly_rate_cents, setup_fee_cents, created_at FROM tenants WHERE id = ?').get(id) as Tenant;
}

export function listTenants(db: Database.Database): Tenant[] {
  return db.prepare('SELECT id, name, slug, lifecycle_state, monthly_rate_cents, setup_fee_cents, created_at FROM tenants ORDER BY created_at DESC').all() as Tenant[];
}

export function getTenantById(db: Database.Database, tenantId: string): Tenant | null {
  return (
    (db.prepare('SELECT id, name, slug, lifecycle_state, monthly_rate_cents, setup_fee_cents, created_at FROM tenants WHERE id = ?').get(tenantId) as Tenant | undefined) ?? null
  );
}

export function updateTenant(
  db: Database.Database,
  tenantId: string,
  input: UpdateTenantInput,
  actorId: string
): Tenant {
  const tenant = getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });

  if (input.lifecycleState && input.lifecycleState !== tenant.lifecycle_state) {
    const allowed = VALID_TRANSITIONS[tenant.lifecycle_state] ?? [];
    if (!allowed.includes(input.lifecycleState)) {
      throw Object.assign(
        new Error(`Invalid lifecycle transition: ${tenant.lifecycle_state} → ${input.lifecycleState}`),
        { status: 400 }
      );
    }
    db.prepare('UPDATE tenants SET lifecycle_state = ? WHERE id = ?').run(input.lifecycleState, tenantId);

    logAudit(db, {
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
    db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(input.name.trim(), tenantId);
  }
  if (input.monthlyRateCents !== undefined && input.monthlyRateCents !== tenant.monthly_rate_cents) {
    settingsChanges['monthly_rate_cents'] = { from: tenant.monthly_rate_cents, to: input.monthlyRateCents };
    db.prepare('UPDATE tenants SET monthly_rate_cents = ? WHERE id = ?').run(input.monthlyRateCents, tenantId);
  }

  // Audit tenant settings changes (name / billing rate) with before→after. A billing-rate
  // change with no trail is a defensibility hole (Audit_Trail.md). No Sensitive values here.
  if (Object.keys(settingsChanges).length > 0) {
    logAudit(db, {
      tenantId,
      actorType: 'platform',
      actorId,
      eventType: 'tenant.settings_changed',
      targetType: 'tenant',
      targetId: tenantId,
      payload: { changes: settingsChanges },
    });
  }

  return getTenantById(db, tenantId) as Tenant;
}

export function impersonateTenant(
  db: Database.Database,
  tenantId: string,
  platformUserId: string
): string {
  const tenant = getTenantById(db, tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });

  // Use the first active admin's ID as the subject, or a synthetic one if none exists
  const firstAdmin = db
    .prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' AND status != 'disabled' LIMIT 1")
    .get(tenantId) as { id: string } | undefined;
  const sub = firstAdmin?.id ?? `system:${tenantId}`;

  const token = issueToken({
    sub,
    tenantId,
    role: 'admin',
    type: 'tenant',
    impersonatedBy: platformUserId,
  });

  logAudit(db, {
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
