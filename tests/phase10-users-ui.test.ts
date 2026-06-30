// Phase 10, Slice G — User Management UI backend (usersForManagement) + the trade-enum
// unification lock. Manage actions (PATCH/invite) + scope clamp are covered by Phase 2/8.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { setupTestDb, seedTenant, seedTenantUser, seedRegion, seedLocation, assignUserToRegion, assignUserToLocation } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { resolveScope } from '@/lib/scope';
import { usersForManagement } from '@/lib/services/users';
import { VALID_TRADES } from '@/lib/services/vendors';
import { REQUIREMENT_TRADES } from '@/lib/services/requirements';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

// ── trade enum unification (Slice F follow-up item 3) ─────────────────────────────────

describe('trade enums are unified', () => {
  test('REQUIREMENT_TRADES is the same shared enum as the vendor VALID_TRADES', () => {
    expect(REQUIREMENT_TRADES).toBe(VALID_TRADES); // same reference — one source of truth
  });
});

// ── usersForManagement ────────────────────────────────────────────────────────────────

describe('usersForManagement', () => {
  function world() {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin', name: 'Ada Admin' });
    const admin2 = seedTenantUser(db, t.id, { role: 'admin', name: 'Bob Admin' });
    const district = seedTenantUser(db, t.id, { role: 'district_manager', name: 'Dana District' });
    const r1 = seedRegion(db, t.id, 'R1'); const r2 = seedRegion(db, t.id, 'R2');
    assignUserToRegion(db, district.id, r1.id, t.id);
    const l1 = seedLocation(db, t.id, { regionId: r1.id }); const l2 = seedLocation(db, t.id, { regionId: r2.id });
    const smIn = seedTenantUser(db, t.id, { role: 'store_manager', name: 'Sam InRegion' }); assignUserToLocation(db, smIn.id, l1.id, t.id);
    const smOut = seedTenantUser(db, t.id, { role: 'store_manager', name: 'Otto OutRegion' }); assignUserToLocation(db, smOut.id, l2.id, t.id);
    return { db, t, admin, admin2, district, smIn, smOut };
  }

  test('Admin: every user, all manageable', () => {
    const w = world();
    const scope = resolveScope(w.db, w.t.id, w.admin.id, 'admin');
    const list = usersForManagement(w.db, w.t.id, scope, 'admin');
    expect(list.length).toBe(5);
    expect(list.every((u) => u.manageable)).toBe(true);
    w.db.close();
  });

  test('District: in-region SM manageable; Admins shown but marked unmanageable; out-of-region SM omitted', () => {
    const w = world();
    const scope = resolveScope(w.db, w.t.id, w.district.id, 'district_manager');
    const list = usersForManagement(w.db, w.t.id, scope, 'district_manager');
    const byName = Object.fromEntries(list.map((u) => [u.name, u]));

    expect(byName['Sam InRegion']?.manageable).toBe(true);     // in region → manageable
    expect(byName['Dana District']?.manageable).toBe(true);    // self (district in its own region) → manageable
    expect(byName['Ada Admin']?.manageable).toBe(false);       // admin shown but not manageable
    expect(byName['Bob Admin']?.manageable).toBe(false);
    expect(byName['Otto OutRegion']).toBeUndefined();          // out-of-region non-admin → omitted
    w.db.close();
  });
});

// ── last-Admin guard ───────────────────────────────────────────────────────────────────

describe('updateUser — last active Admin guard', () => {
  test('single-Admin tenant cannot deactivate that Admin; two-Admin tenant can deactivate one', async () => {
    const { updateUser } = await import('@/lib/services/users');
    const db = setupTestDb();
    const t = seedTenant(db);
    const a1 = seedTenantUser(db, t.id, { role: 'admin' });

    // single admin → blocked
    expect(() => updateUser(db, t.id, a1.id, { status: 'disabled' }, a1.id)).toThrow(/last active Admin/);

    // add a second admin → now one can be deactivated, leaving the other as the last
    const a2 = seedTenantUser(db, t.id, { role: 'admin' });
    expect(() => updateUser(db, t.id, a2.id, { status: 'disabled' }, a1.id)).not.toThrow();
    // a1 is now the last active admin → blocked again
    expect(() => updateUser(db, t.id, a1.id, { status: 'disabled' }, a1.id)).toThrow(/last active Admin/);
    db.close();
  });

  test('non-status edits to an Admin are unaffected by the guard', async () => {
    const { updateUser } = await import('@/lib/services/users');
    const db = setupTestDb();
    const t = seedTenant(db);
    const a1 = seedTenantUser(db, t.id, { role: 'admin' });
    expect(() => updateUser(db, t.id, a1.id, { name: 'Renamed Admin' }, a1.id)).not.toThrow();
    db.close();
  });
});

// ── GET /api/users route (enriched) ───────────────────────────────────────────────────

describe('GET /api/users — management list', () => {
  afterEach(() => closeDb());
  test('Admin gets the enriched list with manageable flags; Store Manager 403', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const store = seedTenantUser(db, t.id, { role: 'store_manager' });
    const { GET } = await import('@/app/api/users/route');

    const adminRes = await GET(new Request('http://t/api/users', { headers: { Authorization: `Bearer ${issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' })}` } }));
    expect(adminRes.status).toBe(200);
    const list = (await adminRes.json()).data as { manageable: boolean }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.every((u) => typeof u.manageable === 'boolean')).toBe(true);

    const storeRes = await GET(new Request('http://t/api/users', { headers: { Authorization: `Bearer ${issueToken({ sub: store.id, tenantId: t.id, role: 'store_manager', type: 'tenant' })}` } }));
    expect(storeRes.status).toBe(403);
  });
});
