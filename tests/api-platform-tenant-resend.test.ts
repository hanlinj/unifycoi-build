import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { seedTenant, seedTenantUser } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }

async function resendAdminInviteReq(jwt: string, tenantId: string) {
  const { POST } = await import('@/app/api/platform/tenants/[tenantId]/resend-admin-invite/route');
  return POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt) }), { params: { tenantId } });
}
async function resendBillingLinkReq(jwt: string, tenantId: string) {
  const { POST } = await import('@/app/api/platform/tenants/[tenantId]/resend-billing-link/route');
  return POST(new Request('http://t/x', { method: 'POST', ...bearer(jwt) }), { params: { tenantId } });
}

afterEach(() => closeDb());

describe('POST /api/platform/tenants/:id/resend-admin-invite', () => {
  test('platform auth required — 401 with none, 403 for a tenant-type token', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    const tenantJwt = issueToken({ sub: 'user-1', tenantId: t.id, role: 'admin', type: 'tenant' });

    expect((await resendAdminInviteReq('', t.id)).status).toBe(401);
    expect((await resendAdminInviteReq(tenantJwt, t.id)).status).toBe(403);
  });

  test('platform caller gets a working invite link', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin', status: 'invited' });
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await resendAdminInviteReq(platformJwt, t.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inviteUrl).toContain('/reset-password?token=');
  });

  test('an unknown tenant is a 404, not a 500', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });
    const res = await resendAdminInviteReq(platformJwt, 'no-such-tenant');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/platform/tenants/:id/resend-billing-link', () => {
  test('platform auth required — 403 for a tenant-type token', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const tenantJwt = issueToken({ sub: 'user-1', tenantId: t.id, role: 'admin', type: 'tenant' });
    expect((await resendBillingLinkReq(tenantJwt, t.id)).status).toBe(403);
  });

  test('platform caller gets a working billing-setup link once billing is attached', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    db.prepare('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?').run('cus_test', t.id);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await resendBillingLinkReq(platformJwt, t.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inviteUrl).toContain('/billing/setup?token=');
  });

  test('409 before billing has ever been attached', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await resendBillingLinkReq(platformJwt, t.id);
    expect(res.status).toBe(409);
  });
});
