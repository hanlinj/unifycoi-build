import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { bulkCreateLocationsWithManagers } from '@/lib/services/bulk-onboarding';
import { emptyImportRow, type ImportLocationRow } from '@/lib/import/location-rows';

function row(overrides: Partial<ImportLocationRow>): ImportLocationRow {
  return { ...emptyImportRow(), ...overrides };
}

describe('bulkCreateLocationsWithManagers', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('creates one location per row', () => {
    const result = bulkCreateLocationsWithManagers(db, tenant.id, [row({ storeName: 'Main St' }), row({ storeName: 'Oak Ave' })], admin.id);
    expect(result.locationIds).toHaveLength(2);
    const count = db.prepare("SELECT COUNT(*) as n FROM locations WHERE tenant_id = ?").get(tenant.id) as { n: number };
    expect(count.n).toBe(2);
  });

  test('a row with no manager email creates no user', () => {
    const result = bulkCreateLocationsWithManagers(db, tenant.id, [row({ storeName: 'Main St' })], admin.id);
    expect(result.managerUserIds).toHaveLength(0);
    expect(result.managersCreated).toBe(0);
  });

  test('a manager is created dormant: invited, no password, no notification queued', () => {
    bulkCreateLocationsWithManagers(db, tenant.id, [row({ storeName: 'Main St', managerFirstName: 'Bob', managerLastName: 'Jones', managerEmail: 'bob@store.test' })], admin.id);
    const manager = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND email = 'bob@store.test'").get(tenant.id) as Record<string, unknown>;
    expect(manager).toBeTruthy();
    expect(manager.status).toBe('invited');
    expect(manager.password_hash).toBeNull();
    expect(manager.role).toBe('store_manager');
    const notifications = db.prepare("SELECT COUNT(*) as n FROM notifications WHERE tenant_id = ?").get(tenant.id) as { n: number };
    expect(notifications.n).toBe(0);
  });

  test('same email on multiple rows consolidates to one manager linked to all those locations', () => {
    const result = bulkCreateLocationsWithManagers(
      db,
      tenant.id,
      [
        row({ storeName: 'Main St', managerEmail: 'multi@store.test' }),
        row({ storeName: 'Oak Ave', managerEmail: 'Multi@Store.test' }), // same person, different case
        row({ storeName: 'Elm St', managerEmail: 'other@store.test' }),
      ],
      admin.id
    );
    expect(result.managersCreated).toBe(2); // multi + other, not 3
    expect(result.managerUserIds).toHaveLength(2);
    const multi = db.prepare("SELECT id FROM users WHERE tenant_id = ? AND email = 'multi@store.test'").get(tenant.id) as { id: string };
    const links = db.prepare('SELECT COUNT(*) as n FROM user_locations WHERE user_id = ?').get(multi.id) as { n: number };
    expect(links.n).toBe(2); // Main St + Oak Ave
  });

  test('an existing tenant user with that email is reused, not recreated', () => {
    const existing = seedTenantUser(db, tenant.id, { email: 'known@store.test', role: 'store_manager' });
    const result = bulkCreateLocationsWithManagers(db, tenant.id, [row({ storeName: 'Main St', managerEmail: 'known@store.test' })], admin.id);
    expect(result.managersCreated).toBe(0);
    expect(result.managersReused).toBe(1);
    expect(result.managerUserIds).toEqual([existing.id]);
  });

  test('writes a billing snapshot reflecting the new location count', () => {
    bulkCreateLocationsWithManagers(db, tenant.id, [row({ storeName: 'Main St' }), row({ storeName: 'Oak Ave' })], admin.id);
    const snap = db.prepare('SELECT billable_locations FROM billing_snapshots WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1').get(tenant.id) as { billable_locations: number };
    expect(snap.billable_locations).toBe(2);
  });

  test('logs a locations.bulk_imported audit event', () => {
    bulkCreateLocationsWithManagers(db, tenant.id, [row({ storeName: 'Main St', managerEmail: 'bob@store.test' })], admin.id);
    const event = db.prepare("SELECT payload_json FROM audit_events WHERE tenant_id = ? AND event_type = 'locations.bulk_imported'").get(tenant.id) as { payload_json: string };
    expect(event).toBeTruthy();
    const payload = JSON.parse(event.payload_json);
    expect(payload.created).toBe(1);
    expect(payload.managers_created).toBe(1);
  });

  test('an empty row set creates nothing and logs no audit event', () => {
    const result = bulkCreateLocationsWithManagers(db, tenant.id, [], admin.id);
    expect(result.locationIds).toHaveLength(0);
    const event = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'locations.bulk_imported'").get(tenant.id);
    expect(event).toBeUndefined();
  });
});
