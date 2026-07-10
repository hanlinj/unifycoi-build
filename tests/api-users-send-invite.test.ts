import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { seedTenant, seedTenantUser, seedRegion, assignUserToRegion, seedLocation, assignUserToLocation } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }
async function sendInviteReq(jwt: string, userId: string) {
  const { POST } = await import('@/app/api/users/[userId]/send-invite/route');
  return POST(new Request('http://t/api/users/x/send-invite', { method: 'POST', ...bearer(jwt) }), { params: { userId } });
}

afterEach(() => closeDb());

describe('POST /api/users/:id/send-invite', () => {
  test('Admin sends an invite to a dormant user; response carries the link', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const target = seedTenantUser(db, t.id, { role: 'store_manager', status: 'invited' });
    const adminJwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const res = await sendInviteReq(adminJwt, target.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inviteUrl).toContain('/reset-password?token=');
  });

  test('store_manager caller is forbidden', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const sm = seedTenantUser(db, t.id, { role: 'store_manager' });
    const target = seedTenantUser(db, t.id, { role: 'store_manager', status: 'invited' });
    const smJwt = issueToken({ sub: sm.id, tenantId: t.id, role: 'store_manager', type: 'tenant' });

    const res = await sendInviteReq(smJwt, target.id);
    expect(res.status).toBe(403);
  });

  test('District Manager out-of-region target is a 404 (scope clamp), same shape as PATCH/invite', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const district = seedTenantUser(db, t.id, { role: 'district_manager' });
    const inRegion = seedRegion(db, t.id, 'R1');
    const otherRegion = seedRegion(db, t.id, 'R2');
    assignUserToRegion(db, district.id, inRegion.id, t.id);

    const outOfScopeLoc = seedLocation(db, t.id, { name: 'Other Loc', regionId: otherRegion.id });
    const outOfScopeTarget = seedTenantUser(db, t.id, { role: 'store_manager', status: 'invited' });
    assignUserToLocation(db, outOfScopeTarget.id, outOfScopeLoc.id, t.id);

    const districtJwt = issueToken({ sub: district.id, tenantId: t.id, role: 'district_manager', type: 'tenant' });
    const res = await sendInviteReq(districtJwt, outOfScopeTarget.id);
    expect(res.status).toBe(404);
  });

  test('active user is a 409, not silently accepted', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const target = seedTenantUser(db, t.id, { role: 'store_manager', status: 'active', password: 'existing-pass-1' });
    const adminJwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const res = await sendInviteReq(adminJwt, target.id);
    expect(res.status).toBe(409);
  });
});
