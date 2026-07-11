// tests/locations-users-dashboards.pg.test.ts — Phase 13 migration, Stage 5: verifies
// users.ts, locations.ts, notifications/chase.ts, location-record.ts, manager-home.ts,
// command-center.ts, and bulk-onboarding.ts against real Postgres.
//
// chase.ts gets deliberately thorough coverage here: its json_extract(payload_json,'$.key')
// SQLite queries had NO Postgres equivalent (a Stage-5 finding, not caught by Stage 0's DDL-only
// investigation) and were rewritten using the ->> jsonb text-extraction operator. These tests
// prove that rewrite is actually correct — the equality filter (payload_json->>'vendor_id' =
// $2), the ->>'type' IN-list, AND (a pre-commit gap-closing fix) that ordering/aggregation over
// expiration_date is a genuine chronological comparison, not a lexicographic string one, proven
// with an unpadded date-only fixture ("2026-9-5", the REALISTIC shape — COI expiry dates are
// date-only) that sorts wrong as raw text but right once compared correctly — while ALSO proving
// the fix does not reformat the value (an earlier version of the fix did, via to_char, which
// silently broke expiryBoundaryMs's tenant-timezone-aware DATE_ONLY detection downstream; see
// the command-center.ts timezone-boundary test below for that mechanism end-to-end).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { createTenant } from '@/lib/services/tenants';
import {
  createUser, listUsers, getUserById, usersForManagement, updateUser, inviteUser, sendUserInvite,
} from '@/lib/services/users';
import {
  createLocation, listLocations, getLocationById, updateLocation, bulkImportLocations,
} from '@/lib/services/locations';
import { findChaseRows, vendorExpiry, chaseExpiryByVendor } from '@/lib/notifications/chase';
import { buildLocationRecord } from '@/lib/services/location-record';
import { buildManagerHome } from '@/lib/services/manager-home';
import { buildCommandCenter } from '@/lib/services/command-center';
import { bulkCreateLocationsWithManagers } from '@/lib/services/bulk-onboarding';
import type { Db } from '@/lib/db/client';
import type { Scope } from '@/lib/scope';

const ADMIN_SCOPE: Scope = { locationIds: null, regionIds: null };

async function seedTenantId(db: Db, name = 'Test Tenant'): Promise<string> {
  const tenant = await createTenant(db, { name, slug: `t-${randomUUID().slice(0, 8)}` }, 'p1');
  return tenant.id;
}

async function seedVendor(db: Db, tenantId: string, overrides: Partial<{ business_name: string; trade: string }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('vendors').values({
    id, tenant_id: tenantId,
    business_name: overrides.business_name ?? 'Acme Fire Safety',
    trade: overrides.trade ?? 'fire_suppression',
    created_at: new Date(),
  }).execute();
  return id;
}

async function seedChaseNotification(
  db: Db,
  tenantId: string,
  input: { vendorId: string; expirationDate: string; daysBefore?: number; type?: string; status?: string; scheduledFor?: Date }
): Promise<string> {
  const id = randomUUID();
  await db.insertInto('notifications').values({
    id, tenant_id: tenantId,
    recipient_type: 'user', recipient_ref: 'admin',
    channel: 'email', kind: 'exception',
    status: input.status ?? 'queued',
    scheduled_for: input.scheduledFor ?? new Date(input.expirationDate),
    payload_json: JSON.stringify({
      type: input.type ?? 'renewal_reminder',
      vendor_id: input.vendorId,
      expiration_date: input.expirationDate,
      days_before: input.daysBefore ?? 30,
    }),
    created_at: new Date(),
  }).execute();
  return id;
}

describe('db-core (Stage 5): users.ts', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => { db = await setupTestDb(); tenantId = await seedTenantId(db); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('createUser rejects a case-insensitive duplicate email (lower() rewrite of COLLATE NOCASE)', async () => {
    await createUser(db, tenantId, { email: 'Manager@Example.com', name: 'M One', role: 'store_manager' }, 'admin-1', ADMIN_SCOPE, 'admin');
    await expect(
      createUser(db, tenantId, { email: 'manager@example.com', name: 'M Two', role: 'store_manager' }, 'admin-1', ADMIN_SCOPE, 'admin')
    ).rejects.toMatchObject({ status: 409 });
  });

  test('listUsers (admin scope) returns every user with scope arrays populated, N+1 fix intact', async () => {
    const u1 = await createUser(db, tenantId, { email: 'a@x.test', name: 'A', role: 'admin' }, 'admin-1', ADMIN_SCOPE, 'admin');
    const u2 = await createUser(db, tenantId, { email: 'b@x.test', name: 'B', role: 'district_manager', regionIds: [] }, 'admin-1', ADMIN_SCOPE, 'admin');
    const all = await listUsers(db, tenantId, ADMIN_SCOPE);
    expect(all.map((u) => u.id).sort()).toEqual([u1.id, u2.id].sort());
    expect(all.every((u) => Array.isArray(u.regionIds) && Array.isArray(u.locationIds))).toBe(true);
  });

  test('listUsers (district scope) returns only users assigned to in-scope locations', async () => {
    const loc = await createLocation(db, tenantId, { name: 'Loc A' }, 'admin-1');
    const inScope = await createUser(db, tenantId, { email: 'in@x.test', name: 'In', role: 'store_manager', locationIds: [loc.id] }, 'admin-1', ADMIN_SCOPE, 'admin');
    await createUser(db, tenantId, { email: 'out@x.test', name: 'Out', role: 'store_manager' }, 'admin-1', ADMIN_SCOPE, 'admin');

    const scoped = await listUsers(db, tenantId, { locationIds: [loc.id], regionIds: [] });
    expect(scoped.map((u) => u.id)).toEqual([inScope.id]);
  });

  test('getUserById round-trips a created user', async () => {
    const created = await createUser(db, tenantId, { email: 'c@x.test', name: 'C', role: 'admin' }, 'admin-1', ADMIN_SCOPE, 'admin');
    const fetched = await getUserById(db, tenantId, created.id);
    expect(fetched?.email).toBe('c@x.test');
    expect(await getUserById(db, tenantId, randomUUID())).toBeNull();
  });

  test('usersForManagement: District sees Admins marked unmanageable, in-scope non-admins manageable, out-of-scope non-admins omitted', async () => {
    const admin = await createUser(db, tenantId, { email: 'admin2@x.test', name: 'Admin Two', role: 'admin' }, 'admin-1', ADMIN_SCOPE, 'admin');
    const regionId = randomUUID();
    await db.insertInto('regions').values({ id: regionId, tenant_id: tenantId, name: 'District Region' }).execute();
    const loc = await createLocation(db, tenantId, { name: 'Loc B', regionId }, 'admin-1');
    const inScopeMgr = await createUser(db, tenantId, { email: 'mgr-in@x.test', name: 'Mgr In', role: 'store_manager', locationIds: [loc.id] }, 'admin-1', ADMIN_SCOPE, 'admin');
    const outOfScopeMgr = await createUser(db, tenantId, { email: 'mgr-out@x.test', name: 'Mgr Out', role: 'store_manager' }, 'admin-1', ADMIN_SCOPE, 'admin');

    const districtScope: Scope = { locationIds: [loc.id], regionIds: [regionId] };
    const result = await usersForManagement(db, tenantId, districtScope, 'district_manager');
    const byId = new Map(result.map((u) => [u.id, u]));
    expect(byId.get(admin.id)?.manageable).toBe(false);
    expect(byId.get(inScopeMgr.id)?.manageable).toBe(true);
    expect(byId.has(outOfScopeMgr.id)).toBe(false);
    expect(result.length).toBe(2); // admin (marked) + in-scope manager; out-of-scope manager omitted
  });

  test('updateUser blocks deactivating the last active Admin (COUNT(*) string cast)', async () => {
    // password provided -> status='active' on creation; the last-admin guard only fires against
    // an active admin (an 'invited' admin who never logged in isn't the org's operative admin).
    const onlyAdmin = await createUser(db, tenantId, { email: 'sole@x.test', name: 'Sole', role: 'admin', password: 'securepassword123' }, 'admin-1', ADMIN_SCOPE, 'admin');
    await expect(updateUser(db, tenantId, onlyAdmin.id, { status: 'disabled' }, 'admin-1')).rejects.toMatchObject({ status: 409 });

    await createUser(db, tenantId, { email: 'second@x.test', name: 'Second', role: 'admin', password: 'securepassword123' }, 'admin-1', ADMIN_SCOPE, 'admin');
    const updated = await updateUser(db, tenantId, onlyAdmin.id, { status: 'disabled' }, 'admin-1');
    expect(updated.status).toBe('disabled');
  });

  test('inviteUser / sendUserInvite issue a working invite link and stamp invite_sent_at', async () => {
    const created = await createUser(db, tenantId, { email: 'invitee@x.test', name: 'Invitee', role: 'store_manager' }, 'admin-1', ADMIN_SCOPE, 'admin');
    await inviteUser(db, tenantId, created.id, 'admin-1'); // no-op status flip, already 'invited'
    const result = await sendUserInvite(db, tenantId, created.id, 'admin-1');
    expect(result.inviteUrl).toContain('/reset-password?token=');
    expect(result.user.invite_sent_at).not.toBeNull();
  });
});

describe('db-core (Stage 5): locations.ts', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => { db = await setupTestDb(); tenantId = await seedTenantId(db); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('createLocation records a billing snapshot and findOrCreateRegion folds case-insensitively', async () => {
    const loc = await createLocation(db, tenantId, { name: 'Main St', regionId: undefined }, 'admin-1');
    expect(loc.status).toBe('active');
    const snapshot = await db.selectFrom('billing_snapshots').selectAll().where('tenant_id', '=', tenantId).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(snapshot.billable_locations).toBe(1);
  });

  test('listLocations (admin) vs scoped by locationIds, with placeholder numbering starting at $2', async () => {
    const a = await createLocation(db, tenantId, { name: 'A' }, 'admin-1');
    const b = await createLocation(db, tenantId, { name: 'B' }, 'admin-1');
    const c = await createLocation(db, tenantId, { name: 'C' }, 'admin-1');

    const all = await listLocations(db, tenantId, ADMIN_SCOPE);
    expect(all.map((l) => l.id).sort()).toEqual([a.id, b.id, c.id].sort());

    const scoped = await listLocations(db, tenantId, { locationIds: [a.id, c.id], regionIds: [] });
    expect(scoped.map((l) => l.id).sort()).toEqual([a.id, c.id].sort());
  });

  test('getLocationById / updateLocation (archiving records another billing snapshot)', async () => {
    const loc = await createLocation(db, tenantId, { name: 'Archive Me' }, 'admin-1');
    const archived = await updateLocation(db, tenantId, loc.id, { status: 'archived' }, 'admin-1');
    expect(archived.status).toBe('archived');
    const snapshot = await db.selectFrom('billing_snapshots').selectAll().where('tenant_id', '=', tenantId).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(snapshot.billable_locations).toBe(0); // the only location just got archived

    expect(await getLocationById(db, tenantId, randomUUID())).toBeNull();
  });

  test('bulkImportLocations: dedup-by-name across rows, manager email lower() fold, single billing snapshot at the end', async () => {
    const csv = [
      'Store Name,Address,City,State,Zip,Manager Email,First Name,Last Name',
      'Store One,100 Main St,Springfield,IL,62701,Manager@Example.com,Pat,One',
      'Store Two,200 Elm St,Springfield,IL,62701,manager@example.com,Pat,One',
      'Store One,300 Oak St,Springfield,IL,62701,other@example.com,Other,Two',
    ].join('\n');

    const result = await bulkImportLocations(db, tenantId, csv, 'admin-1');
    expect(result.created).toBe(2); // Store One (first occurrence) + Store Two
    expect(result.failed).toBe(1); // duplicate "Store One"
    expect(result.managersCreated).toBe(1); // Manager@Example.com created once
    expect(result.managersFound).toBe(1); // manager@example.com (case-fold) reused for Store Two

    const locs = await listLocations(db, tenantId, ADMIN_SCOPE);
    expect(locs.length).toBe(2);
  });
});

describe('db-core (Stage 5): notifications/chase.ts — jsonb ->> rewrite', () => {
  let db: Db;
  let tenantId: string;
  let vendorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    vendorId = await seedVendor(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('findChaseRows: payload_json->>\'vendor_id\' equality filter and ->>\'type\' IN-list both match correctly', async () => {
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-09-01T00:00:00.000Z' });
    const otherVendor = await seedVendor(db, tenantId, { business_name: 'Other Co' });
    await seedChaseNotification(db, tenantId, { vendorId: otherVendor, expirationDate: '2026-09-15T00:00:00.000Z' });
    // Wrong type — must be excluded by the ->>'type' IN-list filter.
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-10-01T00:00:00.000Z', type: 'digest' });
    // Not queued — must be excluded by status filter.
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-11-01T00:00:00.000Z', status: 'sent' });

    const rows = await findChaseRows(db, tenantId, vendorId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vendor_id).toBe(vendorId);
    expect(rows[0]!.expiration_date).toBe('2026-09-01T00:00:00.000Z');
    expect(rows[0]!.payload_type).toBe('renewal_reminder');
  });

  test('findChaseRows casts days_before to a real number (::int), not the raw ->> text', async () => {
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-09-01T00:00:00.000Z', daysBefore: 14 });
    const rows = await findChaseRows(db, tenantId, vendorId);
    expect(rows[0]!.days_before).toBe(14);
    expect(typeof rows[0]!.days_before).toBe('number'); // NOT '14' (string) — the pre-cast bug
  });

  test('vendorExpiry returns the EARLIEST queued expiration among multiple chase rows for a vendor', async () => {
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-12-01T00:00:00.000Z' });
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-08-15T00:00:00.000Z' });
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-10-01T00:00:00.000Z' });

    expect(await vendorExpiry(db, tenantId, vendorId)).toBe('2026-08-15T00:00:00.000Z');
    expect(await vendorExpiry(db, tenantId, randomUUID())).toBeNull();
  });

  test('vendorExpiry: an unpadded date-only month ("2026-9-5") sorts chronologically BEFORE a padded later date-only month ("2026-10-01"), even though it sorts AFTER as raw text — proves the Date.parse()-based comparison, not a lexicographic one, drives the result', async () => {
    // Date-only (no time component) is the REALISTIC shape here — COI certificates state a bare
    // expiration date, not a timestamp (see expiryBoundaryMs's DATE_ONLY handling). Lexically:
    // "2026-9-5" > "2026-10-01" (character 6 is '9' vs '1') — a naive text comparison would pick
    // October as "earliest". Chronologically September 5 is earlier.
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-9-5', scheduledFor: new Date('2026-09-05T00:00:00.000Z') });
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-10-01' });

    const earliest = await vendorExpiry(db, tenantId, vendorId);
    // findChaseRows does NOT reformat expiration_date (must stay date-only for expiryBoundaryMs
    // downstream) — the original unpadded text comes back untouched, just correctly SELECTED.
    expect(earliest).toBe('2026-9-5');
  });

  test('chaseExpiryByVendor: DISTINCT ON ordered by a ::timestamptz cast is a correct chronological min per vendor, not a lexicographic min over raw text', async () => {
    const v2 = await seedVendor(db, tenantId, { business_name: 'Second Vendor' });
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-09-20T00:00:00.000Z' });
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-08-01T00:00:00.000Z' }); // earliest for vendorId
    await seedChaseNotification(db, tenantId, { vendorId: v2, expirationDate: '2027-01-01T00:00:00.000Z' });

    const map = await chaseExpiryByVendor(db, tenantId);
    expect(map.get(vendorId)).toBe('2026-08-01T00:00:00.000Z');
    expect(map.get(v2)).toBe('2027-01-01T00:00:00.000Z');
    expect(map.size).toBe(2);
  });

  test('chaseExpiryByVendor: same unpadded date-only fixture as the vendorExpiry test — must pick September, not October, and return it UNTOUCHED (still unpadded, not reformatted to a timestamp)', async () => {
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-9-5', scheduledFor: new Date('2026-09-05T00:00:00.000Z') });
    await seedChaseNotification(db, tenantId, { vendorId, expirationDate: '2026-10-01' });

    const map = await chaseExpiryByVendor(db, tenantId);
    // A lexicographic MIN(text) would return '2026-10-01' here (wrong: '1' < '9'). Also asserts
    // the exact unpadded string, not a reformatted one — proves the DATE_ONLY shape survives.
    expect(map.get(vendorId)).toBe('2026-9-5');
  });

  test('a bare, zero-padded date-only expiration_date round-trips IDENTICALLY through both the server-side DISTINCT ON path (chaseExpiryByVendor) and the client-side Date.parse() reduction (vendorExpiry)', async () => {
    // The durable fix for the timezone-interpretation seam (raw Vision-extracted dates are now
    // normalized to zero-padded ISO at the single write choke point — earliestExpiration() in
    // renewal.ts) means every value chase.ts reads going forward has this exact shape: bare,
    // zero-padded, date-only. For that shape specifically, Date.parse()'s spec-defined ISO-8601
    // branch (UTC, unambiguous) and Postgres's ::timestamptz cast agree everywhere, independent
    // of either process's local/server timezone — unlike the unpadded case covered above, whose
    // agreement is coincidental to this environment's Node and Postgres both running in UTC.
    const rows: [string, string][] = [
      ['2026-01-31', '2026-02-01'], // month-boundary
      ['2026-02-28', '2026-03-01'], // Feb 2026 is not a leap year — 28 is the last day
      ['2026-12-31', '2027-01-01'], // year-boundary
    ];
    for (const [earlier, later] of rows) {
      const v = await seedVendor(db, tenantId, { business_name: `Boundary ${earlier}` });
      await seedChaseNotification(db, tenantId, { vendorId: v, expirationDate: earlier, scheduledFor: new Date(`${earlier}T00:00:00.000Z`) });
      await seedChaseNotification(db, tenantId, { vendorId: v, expirationDate: later, scheduledFor: new Date(`${later}T00:00:00.000Z`) });

      const [serverSide, clientSide] = await Promise.all([chaseExpiryByVendor(db, tenantId), vendorExpiry(db, tenantId, v)]);
      expect(serverSide.get(v)).toBe(earlier);
      expect(clientSide).toBe(earlier);
      expect(serverSide.get(v)).toBe(clientSide); // the actual round-trip-consistency assertion
    }
  });
});

describe('db-core (Stage 5): location-record.ts', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => { db = await setupTestDb(); tenantId = await seedTenantId(db); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('buildLocationRecord joins vendors at a location with their chase expiry and supports status/trade filters', async () => {
    const loc = await createLocation(db, tenantId, { name: 'Record Loc' }, 'admin-1');
    const vendor = await seedVendor(db, tenantId, { business_name: 'Fire Co', trade: 'fire_suppression' });
    await db.insertInto('vendor_locations').values({
      id: randomUUID(), tenant_id: tenantId, vendor_id: vendor, location_id: loc.id,
      status: 'approved', approved_at: new Date(), created_at: new Date(),
    }).execute();
    await seedChaseNotification(db, tenantId, { vendorId: vendor, expirationDate: '2026-12-25T00:00:00.000Z' });

    const record = await buildLocationRecord(db, tenantId, loc.id);
    expect(record?.vendors).toHaveLength(1);
    expect(record?.vendors[0]!.expiresAt).toBe('2026-12-25T00:00:00.000Z');
    expect(record?.trades).toEqual(['fire_suppression']);

    const filtered = await buildLocationRecord(db, tenantId, loc.id, { trade: 'plumbing' });
    expect(filtered?.vendors).toHaveLength(0);

    expect(await buildLocationRecord(db, tenantId, randomUUID())).toBeNull();
  });
});

describe('db-core (Stage 5): manager-home.ts', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => { db = await setupTestDb(); tenantId = await seedTenantId(db); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('buildManagerHome groups approved vendors at active locations by trade, with facilitiesInScope cast to a number', async () => {
    const loc = await createLocation(db, tenantId, { name: 'Hireable Loc' }, 'admin-1');
    const vendor = await seedVendor(db, tenantId, { business_name: 'Plumb Co', trade: 'plumbing' });
    await db.insertInto('vendor_locations').values({
      id: randomUUID(), tenant_id: tenantId, vendor_id: vendor, location_id: loc.id,
      status: 'approved', approved_at: new Date(), created_at: new Date(),
    }).execute();

    const result = await buildManagerHome(db, tenantId, { locationIds: null });
    expect(typeof result.facilitiesInScope).toBe('number');
    expect(result.facilitiesInScope).toBe(1);
    expect(result.groups).toEqual([{ trade: 'plumbing', vendors: expect.arrayContaining([expect.objectContaining({ vendorId: vendor })]) }]);

    const scoped = await buildManagerHome(db, tenantId, { locationIds: [] });
    expect(scoped.facilitiesInScope).toBe(0);
    expect(scoped.groups).toEqual([]);
  });
});

describe('db-core (Stage 5): command-center.ts', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => { db = await setupTestDb(); tenantId = await seedTenantId(db); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('buildCommandCenter tiers an expired vendor into Tier 1, reads tenant timezone via Kysely (not raw db.prepare)', async () => {
    const loc = await createLocation(db, tenantId, { name: 'CC Loc' }, 'admin-1');
    const vendor = await seedVendor(db, tenantId, { business_name: 'Expired Co' });
    await db.insertInto('vendor_locations').values({
      id: randomUUID(), tenant_id: tenantId, vendor_id: vendor, location_id: loc.id,
      status: 'expired', created_at: new Date(),
    }).execute();

    const result = await buildCommandCenter(db, tenantId, { locationIds: null });
    expect(result.facilitiesInScope).toBe(1);
    expect(result.tier1).toHaveLength(1);
    expect(result.tier1[0]).toMatchObject({ vendorId: vendor, condition: 'expired' });
  });

  test('buildCommandCenter: the imminent_lapse daysToExpiry tile is tenant-timezone-aware end-to-end — the SAME stored date-only expiration_date and the SAME "now" produce a DIFFERENT daysToExpiry for a UTC tenant vs. an America/Los_Angeles tenant', async () => {
    // Proves the whole pipeline for this Stage-5 tile: tenants.timezone (read via the
    // command-center.ts Kysely conversion) -> chaseExpiryByVendor (must NOT reformat a
    // date-only value, see chase.ts) -> expiryBoundaryMs's DATE_ONLY tenant-local-midnight math
    // -> the tier's daysToExpiry field. A UTC-vs-lexicographic-only test would never catch a
    // regression here; only an actual different tz on real data does.
    //
    // expiration boundary (date-only "2026-07-20"): UTC midnight = 2026-07-20T00:00:00Z.
    // America/Los_Angeles midnight (PDT, UTC-7 in July) = 2026-07-20T07:00:00Z — 7h later.
    // now = 2026-07-16T03:00:00Z, chosen so the 7h gap crosses a whole-day floor() boundary:
    //   UTC:  (Jul20T00:00 - Jul16T03:00) = 93h  -> floor(93/24)  = 3 days
    //   LA:   (Jul20T07:00 - Jul16T03:00) = 100h -> floor(100/24) = 4 days
    const now = Date.parse('2026-07-16T03:00:00.000Z');

    async function setupTenantWithImminentVendor(timezone: string | null): Promise<string> {
      const tenant = await createTenant(db, { name: `TZ Co ${timezone ?? 'UTC'}`, slug: `tz-${randomUUID().slice(0, 8)}` }, 'p1');
      if (timezone) await db.updateTable('tenants').set({ timezone }).where('id', '=', tenant.id).execute();
      const loc = await createLocation(db, tenant.id, { name: 'TZ Loc' }, 'admin-1');
      const vendor = await seedVendor(db, tenant.id, { business_name: 'TZ Vendor' });
      await db.insertInto('vendor_locations').values({
        id: randomUUID(), tenant_id: tenant.id, vendor_id: vendor, location_id: loc.id,
        status: 'approved', created_at: new Date(),
      }).execute();
      await seedChaseNotification(db, tenant.id, { vendorId: vendor, expirationDate: '2026-07-20', scheduledFor: new Date('2026-07-20T00:00:00.000Z') });
      return tenant.id;
    }

    const utcTenantId = await setupTenantWithImminentVendor(null);
    const laTenantId = await setupTenantWithImminentVendor('America/Los_Angeles');

    const utcResult = await buildCommandCenter(db, utcTenantId, { locationIds: null }, now);
    const laResult = await buildCommandCenter(db, laTenantId, { locationIds: null }, now);

    expect(utcResult.tier1[0]).toMatchObject({ condition: 'imminent_lapse', daysToExpiry: 3 });
    expect(laResult.tier1[0]).toMatchObject({ condition: 'imminent_lapse', daysToExpiry: 4 });
  });

  test('buildCommandCenter surfaces deficient requirement_evaluations for the LATEST run only (run_id IN-list placeholder numbering)', async () => {
    const loc = await createLocation(db, tenantId, { name: 'Def Loc' }, 'admin-1');
    const vendor = await seedVendor(db, tenantId, { business_name: 'Deficient Co' });
    await db.insertInto('vendor_locations').values({
      id: randomUUID(), tenant_id: tenantId, vendor_id: vendor, location_id: loc.id,
      status: 'under_review', created_at: new Date(),
    }).execute();

    const oldRunId = randomUUID();
    await db.insertInto('verification_runs').values({
      id: oldRunId, tenant_id: tenantId, vendor_id: vendor, trigger: 'onboarding', engine_version: 'v1',
      recommendation: 'deficiencies', created_at: new Date(Date.now() - 60_000),
    }).execute();
    const newRunId = randomUUID();
    await db.insertInto('verification_runs').values({
      id: newRunId, tenant_id: tenantId, vendor_id: vendor, trigger: 'resubmission', engine_version: 'v1',
      recommendation: 'deficiencies', created_at: new Date(),
    }).execute();
    await db.insertInto('requirement_evaluations').values({
      id: randomUUID(), tenant_id: tenantId, run_id: newRunId, vendor_id: vendor, location_id: loc.id,
      requirement_key: 'coverage.general_liability', comparison_result: 'fails', outcome: 'deficient',
    }).execute();

    const result = await buildCommandCenter(db, tenantId, { locationIds: null });
    expect(result.tier1[0]).toMatchObject({ vendorId: vendor, condition: 'review_deficiencies' });
    expect(result.tier1[0]!.phrase).toContain('General Liability');
  });
});

describe('db-core (Stage 5): bulk-onboarding.ts', () => {
  let db: Db;
  let tenantId: string;
  beforeEach(async () => { db = await setupTestDb(); tenantId = await seedTenantId(db); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('bulkCreateLocationsWithManagers consolidates the same manager email across rows into one dormant user, reuses an existing user by lower(email)', async () => {
    const existing = await createUser(db, tenantId, { email: 'existing@x.test', name: 'Existing', role: 'store_manager' }, 'admin-1', ADMIN_SCOPE, 'admin');

    const result = await bulkCreateLocationsWithManagers(db, tenantId, [
      { storeName: 'Loc One', address: '1 St', managerFirstName: 'New', managerLastName: 'Mgr', managerEmail: 'new@x.test' },
      { storeName: 'Loc Two', address: '2 St', managerFirstName: 'New', managerLastName: 'Mgr', managerEmail: 'NEW@X.TEST' },
      { storeName: 'Loc Three', address: '3 St', managerFirstName: '', managerLastName: '', managerEmail: 'Existing@X.test' },
    ], 'admin-1');

    expect(result.locationIds).toHaveLength(3);
    expect(result.managersCreated).toBe(1); // new@x.test, consolidated across rows 1+2
    expect(result.managersReused).toBe(1); // existing user reused via lower(email)
    expect(result.managerUserIds).toHaveLength(2); // one new manager + the reused existing one

    const newMgrLocations = await db.selectFrom('user_locations').select('location_id').where('tenant_id', '=', tenantId).where('user_id', '!=', existing.id).execute();
    expect(newMgrLocations).toHaveLength(2); // Loc One + Loc Two both linked to the SAME new manager
  });

  test('a row with no manager email creates the location but skips manager creation entirely', async () => {
    const result = await bulkCreateLocationsWithManagers(db, tenantId, [
      { storeName: 'Solo Loc', address: '1 St', managerFirstName: '', managerLastName: '', managerEmail: '' },
    ], 'admin-1');
    expect(result.locationIds).toHaveLength(1);
    expect(result.managerUserIds).toHaveLength(0);
  });

  test('nothing commits when a location insert fails partway through (withTransaction rollback, savepoint-safe when nested)', async () => {
    const badTenantId = randomUUID(); // no matching row in tenants — FK violation on locations.tenant_id
    await expect(
      bulkCreateLocationsWithManagers(db, badTenantId, [
        { storeName: 'Ghost Loc', address: '1 St', managerFirstName: '', managerLastName: '', managerEmail: 'ghost@x.test' },
      ], 'admin-1')
    ).rejects.toThrow();
    const locs = await db.selectFrom('locations').selectAll().where('tenant_id', '=', badTenantId).execute();
    expect(locs).toHaveLength(0);
  });
});
