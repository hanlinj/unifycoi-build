// tests/audit-scope.pg.test.ts — Phase 13 migration, Stage 2: verifies logAudit (src/lib/audit.ts)
// and scope.ts against real Postgres, in isolation from downstream callers that haven't
// converted yet (same rationale as tests/db-core.pg.test.ts in Stage 1).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { logAudit } from '@/lib/audit';
import { resolveScope, scopeIncludesLocation, scopeIncludesRegion, userManageableByScope } from '@/lib/scope';
import { TenantDB } from '@/lib/db/tenant';
import type { Db } from '@/lib/db/client';

describe('db-core (Stage 2): logAudit', () => {
  let db: Db;
  const tenantId = randomUUID();

  beforeEach(async () => {
    db = await setupTestDb();
    await db.insertInto('tenants').values({ id: tenantId, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('writes a row scoped to tenantId, with payload_json round-tripping as a real jsonb value', async () => {
    await logAudit(db, {
      tenantId,
      actorType: 'user',
      actorId: 'user-1',
      eventType: 'vendor.approved',
      targetType: 'vendor',
      targetId: 'vendor-1',
      payload: { note: 'looks good' },
    });
    const row = await db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('event_type', '=', 'vendor.approved')
      .executeTakeFirstOrThrow();
    expect(row.actor_id).toBe('user-1');
    expect(row.payload_json).toEqual({ note: 'looks good' });
    expect(row.created_at).toBeInstanceOf(Date);
  });

  test('null actorId/targetType/targetId/payload all persist as real NULLs, not the string "null"', async () => {
    await logAudit(db, { tenantId, actorType: 'system', eventType: 'password_reset.requested' });
    const row = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    expect(row.actor_id).toBeNull();
    expect(row.target_type).toBeNull();
    expect(row.payload_json).toBeNull();
  });
});

describe('db-core (Stage 2): scope.ts', () => {
  let db: Db;
  const tenantId = randomUUID();
  let districtUserId: string;
  let storeUserId: string;
  let adminUserId: string;
  let regionA: string;
  let regionB: string;
  let locA1: string;
  let locA2: string;
  let locB1: string;

  beforeEach(async () => {
    db = await setupTestDb();
    await db.insertInto('tenants').values({ id: tenantId, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();

    districtUserId = randomUUID();
    storeUserId = randomUUID();
    adminUserId = randomUUID();
    regionA = randomUUID();
    regionB = randomUUID();
    locA1 = randomUUID();
    locA2 = randomUUID();
    locB1 = randomUUID();

    const tdb = new TenantDB(db, tenantId);
    await tdb.insert('users', { id: adminUserId, email: 'admin@test.com', name: 'Admin', role: 'admin', status: 'active', created_at: new Date() });
    await tdb.insert('users', { id: districtUserId, email: 'district@test.com', name: 'District', role: 'district_manager', status: 'active', created_at: new Date() });
    await tdb.insert('users', { id: storeUserId, email: 'store@test.com', name: 'Store', role: 'store_manager', status: 'active', created_at: new Date() });
    await tdb.insert('regions', { id: regionA, name: 'Region A' });
    await tdb.insert('regions', { id: regionB, name: 'Region B' });
    await tdb.insert('locations', { id: locA1, region_id: regionA, name: 'A1', status: 'active', created_at: new Date() });
    await tdb.insert('locations', { id: locA2, region_id: regionA, name: 'A2', status: 'active', created_at: new Date() });
    await tdb.insert('locations', { id: locB1, region_id: regionB, name: 'B1', status: 'active', created_at: new Date() });
    await tdb.insert('user_regions', { user_id: districtUserId, region_id: regionA });
    await tdb.insert('user_locations', { user_id: storeUserId, location_id: locA1 });
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('admin scope is unrestricted (null/null) without querying the DB', async () => {
    const scope = await resolveScope(db, tenantId, adminUserId, 'admin');
    expect(scope).toEqual({ locationIds: null, regionIds: null });
    expect(scopeIncludesLocation(scope, 'anything')).toBe(true);
    expect(scopeIncludesRegion(scope, 'anything')).toBe(true);
  });

  test('district_manager scope resolves to their region\'s locations only', async () => {
    const scope = await resolveScope(db, tenantId, districtUserId, 'district_manager');
    expect(scope.regionIds).toEqual([regionA]);
    expect(new Set(scope.locationIds)).toEqual(new Set([locA1, locA2]));
    expect(scopeIncludesLocation(scope, locB1)).toBe(false);
  });

  test('district_manager with no assigned regions gets an empty (not null) scope', async () => {
    const unassignedDistrict = randomUUID();
    const tdb = new TenantDB(db, tenantId);
    await tdb.insert('users', { id: unassignedDistrict, email: 'district2@test.com', name: 'D2', role: 'district_manager', status: 'active', created_at: new Date() });
    const scope = await resolveScope(db, tenantId, unassignedDistrict, 'district_manager');
    expect(scope).toEqual({ locationIds: [], regionIds: [] });
  });

  test('store_manager scope resolves to their assigned locations only, regionIds null', async () => {
    const scope = await resolveScope(db, tenantId, storeUserId, 'store_manager');
    expect(scope.locationIds).toEqual([locA1]);
    expect(scope.regionIds).toBeNull();
    expect(scopeIncludesLocation(scope, locA2)).toBe(false);
  });

  test('userManageableByScope: admin caller can manage anyone', async () => {
    const adminScope = await resolveScope(db, tenantId, adminUserId, 'admin');
    const result = await userManageableByScope(db, tenantId, adminScope, storeUserId);
    expect(result).toEqual({ exists: true, inScope: true });
  });

  test('userManageableByScope: a district caller can never manage an admin', async () => {
    const districtScope = await resolveScope(db, tenantId, districtUserId, 'district_manager');
    const result = await userManageableByScope(db, tenantId, districtScope, adminUserId);
    expect(result).toEqual({ exists: true, inScope: false });
  });

  test('userManageableByScope: district caller manages a store manager fully within their region', async () => {
    const districtScope = await resolveScope(db, tenantId, districtUserId, 'district_manager');
    const result = await userManageableByScope(db, tenantId, districtScope, storeUserId);
    expect(result).toEqual({ exists: true, inScope: true });
  });

  test('userManageableByScope: district caller cannot manage a store manager outside their region', async () => {
    const otherStoreUserId = randomUUID();
    const tdb = new TenantDB(db, tenantId);
    await tdb.insert('users', { id: otherStoreUserId, email: 'store2@test.com', name: 'Store2', role: 'store_manager', status: 'active', created_at: new Date() });
    await tdb.insert('user_locations', { user_id: otherStoreUserId, location_id: locB1 });
    const districtScope = await resolveScope(db, tenantId, districtUserId, 'district_manager');
    const result = await userManageableByScope(db, tenantId, districtScope, otherStoreUserId);
    expect(result).toEqual({ exists: true, inScope: false });
  });

  test('userManageableByScope: nonexistent target reports exists:false, inScope:false', async () => {
    const adminScope = await resolveScope(db, tenantId, adminUserId, 'admin');
    const result = await userManageableByScope(db, tenantId, adminScope, randomUUID());
    expect(result).toEqual({ exists: false, inScope: false });
  });
});
