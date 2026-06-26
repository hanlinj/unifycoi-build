import { setupTestDb, seedPlatformUser, seedTenant, seedTenantUser } from './helpers';
import {
  createTenant,
  listTenants,
  getTenantById,
  updateTenant,
  impersonateTenant,
} from '@/lib/services/tenants';
import { verifyToken } from '@/lib/auth/jwt';

describe('createTenant', () => {
  let db: ReturnType<typeof setupTestDb>;
  let actor: ReturnType<typeof seedPlatformUser>;

  beforeEach(() => { db = setupTestDb(); actor = seedPlatformUser(db); });
  afterEach(() => db.close());

  test('creates tenant in provisioning state', () => {
    const t = createTenant(db, { name: 'Acme Storage' }, actor.id);
    expect(t.lifecycle_state).toBe('provisioning');
    expect(t.name).toBe('Acme Storage');
    expect(t.id).toBeTruthy();
  });

  test('creates a billing snapshot at creation', () => {
    const t = createTenant(db, { name: 'Test' }, actor.id);
    const snapshot = db.prepare('SELECT * FROM billing_snapshots WHERE tenant_id = ?').get(t.id) as Record<string, unknown>;
    expect(snapshot).toBeTruthy();
    expect(snapshot.billable_locations).toBe(0);
  });

  test('logs audit event', () => {
    const t = createTenant(db, { name: 'AuditTest' }, actor.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'tenant.created'").get(t.id);
    expect(event).toBeTruthy();
  });

  test('uses custom monthly rate when provided', () => {
    const t = createTenant(db, { name: 'Custom Rate', monthlyRateCents: 12000 }, actor.id);
    expect(t.monthly_rate_cents).toBe(12000);
  });
});

describe('listTenants and getTenantById', () => {
  let db: ReturnType<typeof setupTestDb>;
  let actor: ReturnType<typeof seedPlatformUser>;

  beforeEach(() => { db = setupTestDb(); actor = seedPlatformUser(db); });
  afterEach(() => db.close());

  test('lists created tenants', () => {
    createTenant(db, { name: 'A' }, actor.id);
    createTenant(db, { name: 'B' }, actor.id);
    expect(listTenants(db).length).toBeGreaterThanOrEqual(2);
  });

  test('getTenantById returns correct tenant', () => {
    const t = createTenant(db, { name: 'Find Me' }, actor.id);
    const found = getTenantById(db, t.id);
    expect(found?.name).toBe('Find Me');
  });

  test('getTenantById returns null for unknown id', () => {
    expect(getTenantById(db, 'no-such-id')).toBeNull();
  });
});

describe('updateTenant — lifecycle transitions', () => {
  let db: ReturnType<typeof setupTestDb>;
  let actor: ReturnType<typeof seedPlatformUser>;

  beforeEach(() => { db = setupTestDb(); actor = seedPlatformUser(db); });
  afterEach(() => db.close());

  test('provisioning → active is allowed', () => {
    const t = createTenant(db, { name: 'X' }, actor.id);
    expect(t.lifecycle_state).toBe('provisioning');
    const updated = updateTenant(db, t.id, { lifecycleState: 'active' }, actor.id);
    expect(updated.lifecycle_state).toBe('active');
  });

  test('active → suspended is allowed', () => {
    const t = seedTenant(db, { lifecycle_state: 'active' });
    const updated = updateTenant(db, t.id, { lifecycleState: 'suspended' }, actor.id);
    expect(updated.lifecycle_state).toBe('suspended');
  });

  test('active → offboarded is allowed', () => {
    const t = seedTenant(db, { lifecycle_state: 'active' });
    const updated = updateTenant(db, t.id, { lifecycleState: 'offboarded' }, actor.id);
    expect(updated.lifecycle_state).toBe('offboarded');
  });

  test('suspended → active (reactivation) is allowed', () => {
    const t = seedTenant(db, { lifecycle_state: 'suspended' });
    const updated = updateTenant(db, t.id, { lifecycleState: 'active' }, actor.id);
    expect(updated.lifecycle_state).toBe('active');
  });

  test('offboarded → active is allowed (spec: Suspended/Offboarded can return to Active)', () => {
    const t = seedTenant(db, { lifecycle_state: 'offboarded' });
    const updated = updateTenant(db, t.id, { lifecycleState: 'active' }, actor.id);
    expect(updated.lifecycle_state).toBe('active');
  });

  test('provisioning → suspended is NOT allowed', () => {
    const t = createTenant(db, { name: 'Y' }, actor.id);
    expect(() => updateTenant(db, t.id, { lifecycleState: 'suspended' }, actor.id)).toThrow();
  });

  test('logs audit event on lifecycle change', () => {
    const t = createTenant(db, { name: 'Z' }, actor.id);
    updateTenant(db, t.id, { lifecycleState: 'active' }, actor.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'tenant.lifecycle_changed'").get(t.id);
    expect(event).toBeTruthy();
  });

  test('can update name without changing lifecycle', () => {
    const t = seedTenant(db, { name: 'Old Name' });
    const updated = updateTenant(db, t.id, { name: 'New Name' }, actor.id);
    expect(updated.name).toBe('New Name');
  });
});

describe('impersonateTenant', () => {
  let db: ReturnType<typeof setupTestDb>;
  let actor: ReturnType<typeof seedPlatformUser>;
  let tenant: ReturnType<typeof seedTenant>;

  beforeEach(() => {
    db = setupTestDb();
    actor = seedPlatformUser(db);
    tenant = seedTenant(db);
  });
  afterEach(() => db.close());

  test('returns a valid JWT', () => {
    const token = impersonateTenant(db, tenant.id, actor.id);
    expect(typeof token).toBe('string');
    const payload = verifyToken(token);
    expect(payload.type).toBe('tenant');
    expect(payload.tenantId).toBe(tenant.id);
    expect(payload.role).toBe('admin');
  });

  test('token contains impersonatedBy field', () => {
    const token = impersonateTenant(db, tenant.id, actor.id);
    const payload = verifyToken(token);
    expect(payload.impersonatedBy).toBe(actor.id);
  });

  test('logs impersonation.started to audit_events', () => {
    impersonateTenant(db, tenant.id, actor.id);
    const event = db.prepare(
      "SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'impersonation.started'"
    ).get(tenant.id) as Record<string, unknown> | undefined;
    expect(event).toBeTruthy();
    expect(event!.actor_type).toBe('platform');
    expect(event!.actor_id).toBe(actor.id);
  });

  test('uses existing admin user as sub when one exists', () => {
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const token = impersonateTenant(db, tenant.id, actor.id);
    const payload = verifyToken(token);
    expect(payload.sub).toBe(admin.id);
  });

  test('uses synthetic sub when tenant has no admin', () => {
    const token = impersonateTenant(db, tenant.id, actor.id);
    const payload = verifyToken(token);
    expect(payload.sub).toContain(tenant.id);
  });

  test('throws for unknown tenant', () => {
    expect(() => impersonateTenant(db, 'no-such-tenant', actor.id)).toThrow();
  });
});
