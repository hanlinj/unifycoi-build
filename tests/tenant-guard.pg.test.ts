// tests/tenant-guard.pg.test.ts — Phase 13 migration, Stage 10: converts tests/tenant-guard.ts
// (a pre-migration test, never assigned to any stage — TenantDB's own tests, not a feature's).
// Surfaced by Stage 10's uninstall verification: the old file used a standalone real
// better-sqlite3 :memory: instance, bypassing this migration entirely, so it kept "passing"
// throughout Stages 1-9 — but 3 of its assertions were false positives, not real coverage.
// TenantDB.update()/insert()/del() became async in Stage 1; the old tests called them without
// awaiting and immediately asserted on a synchronous read — the assertion ran BEFORE the
// fire-and-forget write ever executed, so "the other tenant's row is unchanged" trivially
// passed because the write literally hadn't happened yet, not because isolation held. Fixed
// here by awaiting the write before asserting — the same class of finding as invariant 10's
// handle-type-lie pattern (latent because the failing path was never actually exercised).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { TenantDB, createTenantDb } from '@/lib/db/tenant';
import type { Db } from '@/lib/db/client';

async function seedTenant(db: Db, id: string): Promise<void> {
  await db.insertInto('tenants').values({
    id, name: `Tenant ${id}`, lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date(),
  }).execute();
}

describe('db-core (Stage 10): TenantDB construction guards', () => {
  // The constructor never touches `db` for these cases — validated before any query runs — so
  // no real database connection is needed at all, matching the original tests' own intent.
  const stub = {} as unknown as Db;

  test('throws when tenantId is an empty string', () => {
    expect(() => new TenantDB(stub, '')).toThrow('TenantDB requires a non-empty tenantId');
  });
  test('throws when tenantId is whitespace', () => {
    expect(() => new TenantDB(stub, '   ')).toThrow('TenantDB requires a non-empty tenantId');
  });
  test('throws when tenantId is null (cast)', () => {
    expect(() => new TenantDB(stub, null as unknown as string)).toThrow('TenantDB requires a non-empty tenantId');
  });
  test('throws when tenantId is undefined (cast)', () => {
    expect(() => new TenantDB(stub, undefined as unknown as string)).toThrow('TenantDB requires a non-empty tenantId');
  });
  test('constructs successfully with a valid tenantId', () => {
    expect(() => createTenantDb(stub, 'tenant-1')).not.toThrow();
  });
  test('tenantId is accessible and correct', () => {
    const tdb = createTenantDb(stub, 'tenant-1');
    expect(tdb.tenantId).toBe('tenant-1');
  });
});

describe('db-core (Stage 10): TenantDB query isolation', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('TenantDB for t1 only sees t1 vendors', async () => {
    await seedTenant(db, 't1'); await seedTenant(db, 't2');
    await db.insertInto('vendors').values({ id: 'v1', tenant_id: 't1', business_name: 'Acme Plumbing', trade: 'plumbing', created_at: new Date() }).execute();
    await db.insertInto('vendors').values({ id: 'v2', tenant_id: 't2', business_name: 'Beta Electric', trade: 'electrical', created_at: new Date() }).execute();

    const tdb = createTenantDb(db, 't1');
    const rows = await tdb.all<{ business_name: string }>('SELECT business_name FROM vendors WHERE tenant_id = $1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.business_name).toBe('Acme Plumbing');
  });

  test('cross-tenant get returns undefined', async () => {
    await seedTenant(db, 't1'); await seedTenant(db, 't2');
    await db.insertInto('vendors').values({ id: 'v2', tenant_id: 't2', business_name: 'Beta Electric', trade: 'electrical', created_at: new Date() }).execute();

    const tdb = createTenantDb(db, 't1');
    const row = await tdb.get('SELECT * FROM vendors WHERE tenant_id = $1 AND id = $2', ['v2']);
    expect(row).toBeUndefined();
  });
});

describe('db-core (Stage 10): TenantDB write helpers', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('insert() writes tenant_id automatically', async () => {
    await seedTenant(db, 'ta');
    const tdb = createTenantDb(db, 'ta');
    await tdb.insert('vendors', { id: 'v1', business_name: 'Acme', trade: 'plumbing', created_at: new Date() });
    const row = await db.selectFrom('vendors').select('tenant_id').where('id', '=', 'v1').executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe('ta');
  });

  test('insert() throws when row.tenant_id conflicts with bound tenantId', async () => {
    await seedTenant(db, 'ta'); await seedTenant(db, 'tb');
    const tdb = createTenantDb(db, 'ta');
    await expect(
      tdb.insert('vendors', { id: 'v2', tenant_id: 'tb', business_name: 'X', trade: 'plumbing', created_at: new Date() })
    ).rejects.toThrow(/conflicts with bound tenantId/);
  });

  // Was a false positive pre-migration: the original test called update() without awaiting it,
  // then immediately read the row back — the read ran before the fire-and-forget write ever
  // executed, so "unchanged" trivially held regardless of whether isolation actually worked.
  test('update() cannot modify a row belonging to a different tenant', async () => {
    await seedTenant(db, 'ta'); await seedTenant(db, 'tb');
    await db.insertInto('vendors').values({ id: 'v-a', tenant_id: 'ta', business_name: 'Acme Plumbing', trade: 'plumbing', created_at: new Date() }).execute();

    const tdbB = createTenantDb(db, 'tb');
    await tdbB.update('vendors', { business_name: 'Hacked!' }, { id: 'v-a' });

    const row = await db.selectFrom('vendors').select('business_name').where('id', '=', 'v-a').executeTakeFirstOrThrow();
    expect(row.business_name).toBe('Acme Plumbing'); // genuinely unchanged — the update is awaited above
  });

  test('update() modifies the correct tenant row and leaves the other untouched', async () => {
    await seedTenant(db, 'ta'); await seedTenant(db, 'tb');
    await db.insertInto('vendors').values({ id: 'v-a', tenant_id: 'ta', business_name: 'Acme Plumbing', trade: 'plumbing', created_at: new Date() }).execute();
    await db.insertInto('vendors').values({ id: 'v-b', tenant_id: 'tb', business_name: 'Beta Electric', trade: 'electrical', created_at: new Date() }).execute();

    const tdbA = createTenantDb(db, 'ta');
    await tdbA.update('vendors', { business_name: 'Acme Updated' }, { id: 'v-a' });

    const a = await db.selectFrom('vendors').select('business_name').where('id', '=', 'v-a').executeTakeFirstOrThrow();
    const b = await db.selectFrom('vendors').select('business_name').where('id', '=', 'v-b').executeTakeFirstOrThrow();
    expect(a.business_name).toBe('Acme Updated');
    expect(b.business_name).toBe('Beta Electric');
  });

  // Was also a false positive pre-migration — same fire-and-forget-then-read-too-early shape.
  test('del() cannot delete a row belonging to a different tenant', async () => {
    await seedTenant(db, 'ta'); await seedTenant(db, 'tb');
    await db.insertInto('vendors').values({ id: 'v-a', tenant_id: 'ta', business_name: 'Acme', trade: 'plumbing', created_at: new Date() }).execute();

    const tdbB = createTenantDb(db, 'tb');
    await tdbB.del('vendors', { id: 'v-a' });

    const row = await db.selectFrom('vendors').select('id').where('id', '=', 'v-a').executeTakeFirst();
    expect(row).toBeTruthy(); // genuinely still exists — the delete is awaited above, and scoped to tb
  });

  test('update() throws when set is empty', async () => {
    await seedTenant(db, 'ta');
    const tdb = createTenantDb(db, 'ta');
    await expect(tdb.update('vendors', {}, { id: 'v-a' })).rejects.toThrow(/set object must not be empty/);
  });

  test('update() throws when where is empty', async () => {
    await seedTenant(db, 'ta');
    const tdb = createTenantDb(db, 'ta');
    await expect(tdb.update('vendors', { business_name: 'X' }, {})).rejects.toThrow(/where object must not be empty/);
  });

  test('del() throws when where is empty', async () => {
    await seedTenant(db, 'ta');
    const tdb = createTenantDb(db, 'ta');
    await expect(tdb.del('vendors', {})).rejects.toThrow(/where object must not be empty/);
  });
});
