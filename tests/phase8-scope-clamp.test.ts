// Phase 8, Slice C — District / Store scope clamping on the read surfaces + detail endpoints.
//
// Same components, server-side clamp via resolveScope(). Non-vacuous: excluded vendors are
// proven to exist (Admin sees them) AND proven absent from the District/Store responses.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import {
  seedTenant, seedTenantUser, seedRegion, seedLocation, seedVendor, seedVendorLocation,
  assignUserToRegion, assignUserToLocation,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }

interface Scenario {
  db: Database.Database;
  adminJwt: string; districtJwt: string; storeJwt: string;
  r3ApprovedVendor: { id: string; business_name: string }; // approved at R3 — Dashboard out-of-scope probe
  r3ExpiredVendor: { id: string; business_name: string };  // at-risk at R3 — Command Center named-row probe
  sameRegionOtherLocVendor: { id: string; business_name: string }; // R1 but not Store's L1
}

function setup(): Scenario {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db);
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const district = seedTenantUser(db, t.id, { role: 'district_manager' });
  const store = seedTenantUser(db, t.id, { role: 'store_manager' });

  const r1 = seedRegion(db, t.id, 'Region One');
  const r2 = seedRegion(db, t.id, 'Region Two');
  const r3 = seedRegion(db, t.id, 'Region Three');

  // District covers R1 + R2 (not R3).
  assignUserToRegion(db, district.id, r1.id, t.id);
  assignUserToRegion(db, district.id, r2.id, t.id);

  // L1 + L1b are both in R1; the store manager is assigned ONLY L1.
  const l1 = seedLocation(db, t.id, { name: 'Store L1', regionId: r1.id });
  const l1b = seedLocation(db, t.id, { name: 'Store L1b', regionId: r1.id });
  const l2 = seedLocation(db, t.id, { name: 'Store L2', regionId: r2.id });
  const l3 = seedLocation(db, t.id, { name: 'Store L3', regionId: r3.id });
  assignUserToLocation(db, store.id, l1.id, t.id);

  const at = (locId: string, name: string, status: string) => {
    const v = seedVendor(db, t.id, { business_name: name, trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, locId, { status });
    return v;
  };
  // In-scope named rows (so name-presence assertions are meaningful):
  at(l1.id, 'R1 L1 Hireable', 'approved');     // Dashboard in-scope
  at(l1.id, 'R1 Expired InScope', 'expired');  // Command Center in-scope (named Tier-1 row)
  at(l2.id, 'R2 L2 Vendor', 'approved');
  // Out-of-scope probes:
  const r3ApprovedVendor = at(l3.id, 'R3 ONLY Approved', 'approved');
  const r3ExpiredVendor = at(l3.id, 'R3 ONLY Expired', 'expired');
  const sameRegionOtherLocVendor = at(l1b.id, 'R1 L1b Vendor', 'approved');

  return {
    db,
    adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }),
    districtJwt: issueToken({ sub: district.id, tenantId: t.id, role: 'district_manager', type: 'tenant' }),
    storeJwt: issueToken({ sub: store.id, tenantId: t.id, role: 'store_manager', type: 'tenant' }),
    r3ApprovedVendor, r3ExpiredVendor, sameRegionOtherLocVendor,
  };
}

async function ccBody(jwt: string): Promise<string> {
  const { GET } = await import('@/app/api/command-center/route');
  return (await GET(new Request('http://t/api/command-center', bearer(jwt)))).text();
}
async function dashBody(jwt: string): Promise<string> {
  const { GET } = await import('@/app/api/dashboard/route');
  return (await GET(new Request('http://t/api/dashboard', bearer(jwt)))).text();
}

afterEach(() => closeDb());

// ── Non-vacuous: Admin sees the R3-only vendor everywhere ─────────────────────────

describe('scope clamp — Admin baseline (non-vacuous)', () => {
  test('Admin Command Center includes the at-risk R3 vendor (named row)', async () => {
    expect(await ccBody(setup().adminJwt)).toContain('R3 ONLY Expired');
  });
  test('Admin Dashboard includes the approved R3 vendor', async () => {
    expect(await dashBody(setup().adminJwt)).toContain('R3 ONLY Approved');
  });
  test('Admin can GET the R3 vendor record (200)', async () => {
    const s = setup();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(new Request(`http://t/api/vendors/${s.r3ApprovedVendor.id}`, bearer(s.adminJwt)), { params: { id: s.r3ApprovedVendor.id } });
    expect(res.status).toBe(200);
  });
});

// ── District: surfaces clamp to R1+R2 ─────────────────────────────────────────────

describe('scope clamp — District oversight (regions R1,R2)', () => {
  test('Command Center shows an in-scope at-risk vendor but excludes the R3 one', async () => {
    const body = await ccBody(setup().districtJwt);
    expect(body).toContain('R1 Expired InScope');
    expect(body).not.toContain('R3 ONLY Expired');
  });

  test('Dashboard shows in-scope approved vendors but excludes the R3 one', async () => {
    const body = await dashBody(setup().districtJwt);
    expect(body).toContain('R1 L1 Hireable');
    expect(body).not.toContain('R3 ONLY Approved');
  });

  test('URL-construction attack: District GET of the R3 vendor record is blocked (403/404)', async () => {
    const s = setup();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(new Request(`http://t/api/vendors/${s.r3ApprovedVendor.id}`, bearer(s.districtJwt)), { params: { id: s.r3ApprovedVendor.id } });
    expect([403, 404]).toContain(res.status);
  });
});

// ── Store Manager: clamps to assigned location L1 (not the whole region) ───────────

describe('scope clamp — Store Manager (location L1 only)', () => {
  test('Dashboard shows L1 vendors only, not other locations in the same region', async () => {
    const s = setup();
    const body = await dashBody(s.storeJwt);
    expect(body).toContain('R1 L1 Hireable');
    expect(body).not.toContain('R1 L1b Vendor'); // same region R1, different (unassigned) location
    expect(body).not.toContain('R3 ONLY Vendor');
  });

  test('URL-construction attack: Store GET of a same-region out-of-scope vendor is blocked (403/404)', async () => {
    const s = setup();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(new Request(`http://t/api/vendors/${s.sameRegionOtherLocVendor.id}`, bearer(s.storeJwt)), { params: { id: s.sameRegionOtherLocVendor.id } });
    expect([403, 404]).toContain(res.status);
  });
});

// ── Fix specifics: in-scope row filtering, audit event, uniform 404 ────────────────

describe('scope clamp — GET /api/vendors/:id fix details', () => {
  test('blocked attempt writes a security.scope_violation audit event (no Sensitive)', async () => {
    const s = setup();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    await GET(new Request(`http://t/api/vendors/${s.r3ApprovedVendor.id}`, bearer(s.districtJwt)), { params: { id: s.r3ApprovedVendor.id } });
    const evt = s.db.prepare(
      `SELECT event_type, actor_type, target_id, payload_json FROM audit_events WHERE event_type='security.scope_violation' ORDER BY created_at DESC LIMIT 1`
    ).get() as { event_type: string; actor_type: string; target_id: string; payload_json: string } | undefined;
    expect(evt).toBeDefined();
    expect(evt!.actor_type).toBe('user');
    expect(evt!.target_id).toBe(s.r3ApprovedVendor.id);
    expect(evt!.payload_json).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });

  test('vendor spanning in- and out-of-scope locations → District sees only the in-scope rows', async () => {
    // Build a vendor approved at L2 (R2, in District scope) AND L3 (R3, out of scope).
    const db = getRawDb(); // same migrated DB as the last setup()
    closeDb();
    const fresh = getRawDb();
    const dir = path.join(process.cwd(), 'src', 'migrations');
    fresh.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) fresh.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));

    const t = seedTenant(fresh);
    const district = seedTenantUser(fresh, t.id, { role: 'district_manager' });
    const r2 = seedRegion(fresh, t.id, 'R2'); const r3 = seedRegion(fresh, t.id, 'R3');
    assignUserToRegion(fresh, district.id, r2.id, t.id);
    const l2 = seedLocation(fresh, t.id, { name: 'In-Scope Store', regionId: r2.id });
    const l3 = seedLocation(fresh, t.id, { name: 'Out Store', regionId: r3.id });
    const v = seedVendor(fresh, t.id, { business_name: 'Spanning Vendor' });
    seedVendorLocation(fresh, t.id, v.id, l2.id, { status: 'approved' });
    seedVendorLocation(fresh, t.id, v.id, l3.id, { status: 'expired' });
    const jwt = issueToken({ sub: district.id, tenantId: t.id, role: 'district_manager', type: 'tenant' });

    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(new Request(`http://t/api/vendors/${v.id}`, bearer(jwt)), { params: { id: v.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.locations).toHaveLength(1);
    expect(body.data.locations[0].location_name).toBe('In-Scope Store');
    void db;
  });

  test('uniform 404: Admin requesting a genuinely-missing vendor gets the same 404 shape', async () => {
    const s = setup();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(new Request('http://t/api/vendors/does-not-exist', bearer(s.adminJwt)), { params: { id: 'does-not-exist' } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Vendor not found');
  });
});
