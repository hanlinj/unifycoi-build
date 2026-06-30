// Phase 8, Slice C security pass — within-tenant scope clamp on user management.
//
// District may manage a user only if the target is fully within their region scope, and never
// an Admin. Out-of-scope OR missing → uniform 404 + security.scope_violation (when real).
// Structural + non-vacuous: excluded targets are proven to exist (an Admin caller can manage
// them) yet are 404 to the out-of-scope District.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import {
  seedTenant, seedTenantUser, seedRegion, seedLocation, assignUserToRegion, assignUserToLocation,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }
function jsonReq(jwt: string, body: unknown) {
  return new Request('http://t/api/users/x', { method: 'PATCH', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function patchUser(jwt: string, userId: string, body: unknown) {
  const { PATCH } = await import('@/app/api/users/[userId]/route');
  return PATCH(jsonReq(jwt, body), { params: { userId } });
}
async function inviteUserReq(jwt: string, userId: string) {
  const { POST } = await import('@/app/api/users/[userId]/invite/route');
  return POST(new Request('http://t/api/users/x/invite', { method: 'POST', ...bearer(jwt) }), { params: { userId } });
}

interface World {
  db: Database.Database;
  adminJwt: string; districtJwt: string; // district covers R1, R2
  targets: {
    admin: string;            // org-wide → never manageable by district
    storeInScope: string;     // store_manager in R1 → in scope
    districtSubset: string;   // district [R1] → subset → in scope
    districtDisjoint: string; // district [R3, R4] → out of scope
    districtPartial: string;  // district [R1, R3] → partial overlap → out of scope
  };
}

function world(): World {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db);
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const district = seedTenantUser(db, t.id, { role: 'district_manager' });

  const r1 = seedRegion(db, t.id, 'R1'); const r2 = seedRegion(db, t.id, 'R2');
  const r3 = seedRegion(db, t.id, 'R3'); const r4 = seedRegion(db, t.id, 'R4');
  assignUserToRegion(db, district.id, r1.id, t.id);
  assignUserToRegion(db, district.id, r2.id, t.id);

  // target: another admin
  const adminTarget = seedTenantUser(db, t.id, { role: 'admin' });

  // target: store manager assigned to a location in R1 (in scope)
  const l1 = seedLocation(db, t.id, { name: 'L1', regionId: r1.id });
  const storeInScope = seedTenantUser(db, t.id, { role: 'store_manager' });
  assignUserToLocation(db, storeInScope.id, l1.id, t.id);

  // target: district [R1] — subset of caller [R1,R2]
  const dSubset = seedTenantUser(db, t.id, { role: 'district_manager' });
  assignUserToRegion(db, dSubset.id, r1.id, t.id);

  // target: district [R3,R4] — disjoint
  const dDisjoint = seedTenantUser(db, t.id, { role: 'district_manager' });
  assignUserToRegion(db, dDisjoint.id, r3.id, t.id);
  assignUserToRegion(db, dDisjoint.id, r4.id, t.id);

  // target: district [R1,R3] — partial overlap (R3 outside caller)
  const dPartial = seedTenantUser(db, t.id, { role: 'district_manager' });
  assignUserToRegion(db, dPartial.id, r1.id, t.id);
  assignUserToRegion(db, dPartial.id, r3.id, t.id);

  return {
    db,
    adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }),
    districtJwt: issueToken({ sub: district.id, tenantId: t.id, role: 'district_manager', type: 'tenant' }),
    targets: { admin: adminTarget.id, storeInScope: storeInScope.id, districtSubset: dSubset.id, districtDisjoint: dDisjoint.id, districtPartial: dPartial.id },
  };
}

afterEach(() => closeDb());

// ── Non-vacuous baseline: Admin caller can manage all of these targets ─────────────

describe('user scope — Admin baseline (targets exist + are manageable)', () => {
  test('Admin can PATCH every target (200) — proves they exist', async () => {
    const w = world();
    for (const id of Object.values(w.targets)) {
      const res = await patchUser(w.adminJwt, id, { name: 'Renamed By Admin' });
      expect(res.status).toBe(200);
    }
  });
});

// ── District PATCH clamp ────────────────────────────────────────────────────────────

describe('user scope — District PATCH', () => {
  test('in-scope store manager → 200 (positive control)', async () => {
    const w = world();
    const res = await patchUser(w.districtJwt, w.targets.storeInScope, { name: 'OK Change' });
    expect(res.status).toBe(200);
  });

  test('subset district [R1] ⊆ [R1,R2] → 200', async () => {
    const w = world();
    const res = await patchUser(w.districtJwt, w.targets.districtSubset, { name: 'OK Change' });
    expect(res.status).toBe(200);
  });

  test('an Admin target → 404 (a District can never manage an Admin)', async () => {
    const w = world();
    const res = await patchUser(w.districtJwt, w.targets.admin, { name: 'Nope' });
    expect(res.status).toBe(404);
  });

  test('disjoint district [R3,R4] → 404', async () => {
    const w = world();
    const res = await patchUser(w.districtJwt, w.targets.districtDisjoint, { name: 'Nope' });
    expect(res.status).toBe(404);
  });

  test('partial-overlap district [R1,R3] → 404 (subset rule)', async () => {
    const w = world();
    const res = await patchUser(w.districtJwt, w.targets.districtPartial, { name: 'Nope' });
    expect(res.status).toBe(404);
  });

  test('blocked PATCH logs security.scope_violation; target was NOT modified', async () => {
    const w = world();
    await patchUser(w.districtJwt, w.targets.districtDisjoint, { name: 'Should Not Apply' });
    const evt = w.db.prepare(
      `SELECT actor_type, target_type, target_id FROM audit_events WHERE event_type='security.scope_violation' AND target_id=?`
    ).get(w.targets.districtDisjoint) as { actor_type: string; target_type: string; target_id: string } | undefined;
    expect(evt).toBeDefined();
    expect(evt!.actor_type).toBe('user');
    expect(evt!.target_type).toBe('user');
    const name = (w.db.prepare('SELECT name FROM users WHERE id=?').get(w.targets.districtDisjoint) as { name: string }).name;
    expect(name).not.toBe('Should Not Apply');
  });

  test('missing user → 404 (same shape as out-of-scope), no scope_violation logged', async () => {
    const w = world();
    const res = await patchUser(w.districtJwt, 'no-such-user', { name: 'x' });
    expect(res.status).toBe(404);
    const evt = w.db.prepare(`SELECT id FROM audit_events WHERE event_type='security.scope_violation' AND target_id='no-such-user'`).get();
    expect(evt).toBeUndefined();
  });
});

// ── District invite clamp ───────────────────────────────────────────────────────────

describe('user scope — District invite', () => {
  test('in-scope target → 200; disjoint + admin targets → 404', async () => {
    const w = world();
    expect((await inviteUserReq(w.districtJwt, w.targets.storeInScope)).status).toBe(200);
    expect((await inviteUserReq(w.districtJwt, w.targets.districtDisjoint)).status).toBe(404);
    expect((await inviteUserReq(w.districtJwt, w.targets.admin)).status).toBe(404);
  });

  test('partial-overlap target → 404', async () => {
    const w = world();
    expect((await inviteUserReq(w.districtJwt, w.targets.districtPartial)).status).toBe(404);
  });
});
