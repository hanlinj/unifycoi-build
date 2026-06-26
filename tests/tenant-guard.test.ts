import Database from 'better-sqlite3';
import { TenantDB, createTenantDb } from '@/lib/db/tenant';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal table for testing
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      monthly_rate_cents INTEGER NOT NULL DEFAULT 9000,
      created_at TEXT NOT NULL
    );
    CREATE TABLE vendors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      business_name TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      trade TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('TenantDB construction guards', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  test('throws when tenantId is an empty string', () => {
    expect(() => new TenantDB(db, '')).toThrow('TenantDB requires a non-empty tenantId');
  });

  test('throws when tenantId is whitespace', () => {
    expect(() => new TenantDB(db, '   ')).toThrow('TenantDB requires a non-empty tenantId');
  });

  test('throws when tenantId is null (cast)', () => {
    expect(() => new TenantDB(db, null as unknown as string)).toThrow('TenantDB requires a non-empty tenantId');
  });

  test('throws when tenantId is undefined (cast)', () => {
    expect(() => new TenantDB(db, undefined as unknown as string)).toThrow('TenantDB requires a non-empty tenantId');
  });

  test('constructs successfully with a valid tenantId', () => {
    expect(() => createTenantDb(db, 'tenant-1')).not.toThrow();
  });
});

describe('TenantDB query isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    // Seed two tenants and two vendors
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tenants VALUES (?,?,?,?,?)').run('t1', 'Alpha', 'active', 9000, now);
    db.prepare('INSERT INTO tenants VALUES (?,?,?,?,?)').run('t2', 'Beta', 'active', 9000, now);
    db.prepare('INSERT INTO vendors VALUES (?,?,?,?,?,?,?,?)').run(
      'v1', 't1', 'Acme Plumbing', null, null, null, 'plumbing', now
    );
    db.prepare('INSERT INTO vendors VALUES (?,?,?,?,?,?,?,?)').run(
      'v2', 't2', 'Beta Electric', null, null, null, 'electrical', now
    );
  });

  afterEach(() => { db.close(); });

  test('TenantDB for t1 only sees t1 vendors', () => {
    const tdb = createTenantDb(db, 't1');
    const rows = tdb.all<{ business_name: string }>(
      'SELECT business_name FROM vendors WHERE tenant_id = ?'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].business_name).toBe('Acme Plumbing');
  });

  test('TenantDB for t2 only sees t2 vendors', () => {
    const tdb = createTenantDb(db, 't2');
    const rows = tdb.all<{ business_name: string }>(
      'SELECT business_name FROM vendors WHERE tenant_id = ?'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].business_name).toBe('Beta Electric');
  });

  test('cross-tenant get returns undefined', () => {
    const tdb = createTenantDb(db, 't1');
    // v2 belongs to t2; querying via t1 TenantDB returns nothing
    const row = tdb.get('SELECT * FROM vendors WHERE tenant_id = ? AND id = ?', ['v2']);
    expect(row).toBeUndefined();
  });

  test('TenantDB.tenantId is accessible and correct', () => {
    const tdb = createTenantDb(db, 't1');
    expect(tdb.tenantId).toBe('t1');
  });
});
