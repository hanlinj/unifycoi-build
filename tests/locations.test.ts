import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedRegion,
  seedLocation,
  assignUserToRegion,
  assignUserToLocation,
} from './helpers';
import {
  createLocation,
  listLocations,
  getLocationById,
  updateLocation,
  bulkImportLocations,
  parseImportCSV,
} from '@/lib/services/locations';
import { resolveScope } from '@/lib/scope';

describe('createLocation', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('creates an active location', () => {
    const loc = createLocation(db, tenant.id, { name: 'Main St Store', address: '1 Main St' }, admin.id);
    expect(loc.status).toBe('active');
    expect(loc.name).toBe('Main St Store');
  });

  test('creates a billing snapshot', () => {
    createLocation(db, tenant.id, { name: 'Snap Store' }, admin.id);
    const snap = db.prepare("SELECT * FROM billing_snapshots WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1").get(tenant.id) as Record<string, unknown>;
    expect(snap).toBeTruthy();
    expect(Number(snap.billable_locations)).toBeGreaterThan(0);
  });

  test('logs audit event', () => {
    const loc = createLocation(db, tenant.id, { name: 'Audit Loc' }, admin.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'location.created' AND target_id = ?").get(loc.id);
    expect(event).toBeTruthy();
  });

  test('assigns to region when regionId provided', () => {
    const region = seedRegion(db, tenant.id);
    const loc = createLocation(db, tenant.id, { name: 'Region Store', regionId: region.id }, admin.id);
    expect(loc.region_id).toBe(region.id);
  });
});

describe('listLocations scope', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let region: { id: string };
  let locInRegion: ReturnType<typeof seedLocation>;
  let locOutside: ReturnType<typeof seedLocation>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    region = seedRegion(db, tenant.id);
    locInRegion = seedLocation(db, tenant.id, { regionId: region.id });
    locOutside = seedLocation(db, tenant.id);
  });
  afterEach(() => db.close());

  test('admin sees all locations', () => {
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    const locs = listLocations(db, tenant.id, scope);
    const ids = locs.map((l) => l.id);
    expect(ids).toContain(locInRegion.id);
    expect(ids).toContain(locOutside.id);
  });

  test('district_manager sees only region locations', () => {
    const dm = seedTenantUser(db, tenant.id, { role: 'district_manager' });
    assignUserToRegion(db, dm.id, region.id, tenant.id);
    const scope = resolveScope(db, tenant.id, dm.id, 'district_manager');
    const locs = listLocations(db, tenant.id, scope);
    const ids = locs.map((l) => l.id);
    expect(ids).toContain(locInRegion.id);
    expect(ids).not.toContain(locOutside.id);
  });

  test('store_manager sees only their locations', () => {
    const sm = seedTenantUser(db, tenant.id, { role: 'store_manager' });
    assignUserToLocation(db, sm.id, locInRegion.id, tenant.id);
    const scope = resolveScope(db, tenant.id, sm.id, 'store_manager');
    const locs = listLocations(db, tenant.id, scope);
    expect(locs.length).toBe(1);
    expect(locs[0].id).toBe(locInRegion.id);
  });
});

describe('updateLocation', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;
  let loc: ReturnType<typeof seedLocation>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    loc = seedLocation(db, tenant.id, { name: 'Original' });
  });
  afterEach(() => db.close());

  test('updates name', () => {
    const updated = updateLocation(db, tenant.id, loc.id, { name: 'Renamed Store' }, admin.id);
    expect(updated.name).toBe('Renamed Store');
  });

  test('archives location (never hard-deletes)', () => {
    const updated = updateLocation(db, tenant.id, loc.id, { status: 'archived' }, admin.id);
    expect(updated.status).toBe('archived');
    // Record still exists
    const still = getLocationById(db, tenant.id, loc.id);
    expect(still).not.toBeNull();
    expect(still!.status).toBe('archived');
  });

  test('archiving creates a billing snapshot', () => {
    updateLocation(db, tenant.id, loc.id, { status: 'archived' }, admin.id);
    const snap = db.prepare("SELECT billable_locations FROM billing_snapshots WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1").get(tenant.id) as Record<string, unknown>;
    expect(Number(snap.billable_locations)).toBe(0);
  });

  test('logs location.archived event', () => {
    updateLocation(db, tenant.id, loc.id, { status: 'archived' }, admin.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'location.archived' AND target_id = ?").get(loc.id);
    expect(event).toBeTruthy();
  });

  test('throws for unknown location', () => {
    expect(() => updateLocation(db, tenant.id, 'no-such-id', { name: 'X' }, admin.id)).toThrow(/not found/i);
  });
});

// ─── Bulk import ─────────────────────────────────────────────────────────────

const VALID_CSV = `Store Name,Address,City,State,ZIP,Region / District,Manager First Name,Manager Last Name,Manager Email
Main Street Store,123 Main St,Portland,OR,97201,North,Alice,Smith,alice@example.com
Oak Avenue Store,456 Oak Ave,Seattle,WA,98101,,,,`;

const MISSING_REQUIRED_CSV = `Store Name,Address,City,State,ZIP
Good Store,123 Main St,Portland,OR,97201
,456 Oak Ave,Seattle,WA,98101`;

const DUPLICATE_STORE_CSV = `Store Name,Address,City,State,ZIP
Alpha Store,123 Main St,Portland,OR,97201
Alpha Store,456 Oak Ave,Seattle,WA,98102`;

describe('parseImportCSV', () => {
  test('parses valid CSV headers', () => {
    const { rows, headerErrors } = parseImportCSV(VALID_CSV);
    expect(headerErrors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0].storeName).toBe('Main Street Store');
    expect(rows[0].managerEmail).toBe('alice@example.com');
  });

  test('returns error on missing Store Name header', () => {
    const { headerErrors } = parseImportCSV('Address,City\n123 Main,Portland');
    expect(headerErrors.length).toBeGreaterThan(0);
  });
});

describe('bulkImportLocations', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('imports valid rows and creates managers', () => {
    const result = bulkImportLocations(db, tenant.id, VALID_CSV, admin.id);
    expect(result.created).toBe(2);
    expect(result.managersCreated).toBe(1); // Alice created
    expect(result.failed).toBe(0);
  });

  test('partial import: valid rows go in, invalid are reported', () => {
    const result = bulkImportLocations(db, tenant.id, MISSING_REQUIRED_CSV, admin.id);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0].reasons.some((r) => r.includes('Store Name'))).toBe(true);
  });

  test('duplicate store name within tenant is flagged', () => {
    bulkImportLocations(db, tenant.id, DUPLICATE_STORE_CSV, admin.id);
    const result = bulkImportLocations(db, tenant.id, DUPLICATE_STORE_CSV, admin.id);
    // Both stores are already imported; re-import should flag all as duplicates
    expect(result.failed).toBeGreaterThanOrEqual(2);
  });

  test('intra-batch duplicate flagged', () => {
    const result = bulkImportLocations(db, tenant.id, DUPLICATE_STORE_CSV, admin.id);
    // First row succeeds, second is flagged as duplicate
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('manager email dedup: existing user is reused', () => {
    // Import once to create Alice
    bulkImportLocations(db, tenant.id, VALID_CSV, admin.id);
    // Import again with same manager email on a different store
    const csv2 = `Store Name,Address,City,State,ZIP,Manager Email
New Store,789 Elm St,Portland,OR,97202,alice@example.com`;
    const result = bulkImportLocations(db, tenant.id, csv2, admin.id);
    expect(result.managersFound).toBe(1);
    expect(result.managersCreated).toBe(0);
  });

  test('logs bulk import audit event', () => {
    bulkImportLocations(db, tenant.id, VALID_CSV, admin.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'locations.bulk_imported' AND tenant_id = ?").get(tenant.id);
    expect(event).toBeTruthy();
  });

  test('invalid ZIP is flagged', () => {
    const csv = `Store Name,Address,City,State,ZIP\nBad ZIP Store,123 Main,Portland,OR,BADZIP`;
    const result = bulkImportLocations(db, tenant.id, csv, admin.id);
    expect(result.failed).toBe(1);
    expect(result.failures[0].reasons.some((r) => r.includes('ZIP'))).toBe(true);
  });

  test('manager name without email is flagged', () => {
    const csv = `Store Name,Address,City,State,ZIP,Manager First Name,Manager Last Name
OK Store,123 Main,Portland,OR,97201,Bob,Jones`;
    const result = bulkImportLocations(db, tenant.id, csv, admin.id);
    expect(result.failed).toBe(1);
    expect(result.failures[0].reasons.some((r) => r.includes('email'))).toBe(true);
  });

  test('region is created if it does not exist', () => {
    bulkImportLocations(db, tenant.id, VALID_CSV, admin.id);
    const region = db.prepare("SELECT * FROM regions WHERE tenant_id = ? AND name = 'North'").get(tenant.id);
    expect(region).toBeTruthy();
  });

  test('state is normalized to abbreviation', () => {
    const csv = `Store Name,Address,City,State,ZIP\nOregon Store,123 Main,Portland,Oregon,97201`;
    bulkImportLocations(db, tenant.id, csv, admin.id);
    const loc = db.prepare("SELECT address FROM locations WHERE tenant_id = ? AND name = 'Oregon Store'").get(tenant.id) as Record<string, unknown> | undefined;
    expect(loc?.address).toContain('OR');
  });
});
