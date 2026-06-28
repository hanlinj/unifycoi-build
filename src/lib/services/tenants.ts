import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { issueToken } from '@/lib/auth/jwt';

export interface Tenant {
  id: string;
  name: string;
  lifecycle_state: string;
  monthly_rate_cents: number;
  created_at: string;
}

export interface CreateTenantInput {
  name: string;
  monthlyRateCents?: number;
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

  db.prepare(
    'INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, input.name.trim(), 'provisioning', rate, now);

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

  return db.prepare('SELECT id, name, lifecycle_state, monthly_rate_cents, created_at FROM tenants WHERE id = ?').get(id) as Tenant;
}

export function listTenants(db: Database.Database): Tenant[] {
  return db.prepare('SELECT id, name, lifecycle_state, monthly_rate_cents, created_at FROM tenants ORDER BY created_at DESC').all() as Tenant[];
}

export function getTenantById(db: Database.Database, tenantId: string): Tenant | null {
  return (
    (db.prepare('SELECT id, name, lifecycle_state, monthly_rate_cents, created_at FROM tenants WHERE id = ?').get(tenantId) as Tenant | undefined) ?? null
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

  if (input.name !== undefined) {
    db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(input.name.trim(), tenantId);
  }
  if (input.monthlyRateCents !== undefined) {
    db.prepare('UPDATE tenants SET monthly_rate_cents = ? WHERE id = ?').run(input.monthlyRateCents, tenantId);
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
