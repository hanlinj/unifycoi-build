import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { seedTenant } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } }; }

async function patchRate(jwt: string, tenantId: string, monthlyRateCents: unknown) {
  const { PATCH } = await import('@/app/api/platform/tenants/[tenantId]/rate/route');
  return PATCH(new Request('http://t/x', { method: 'PATCH', ...bearer(jwt), body: JSON.stringify({ monthlyRateCents }) }), { params: { tenantId } });
}
async function patchSetupFee(jwt: string, tenantId: string, setupFeeCents: unknown) {
  const { PATCH } = await import('@/app/api/platform/tenants/[tenantId]/setup-fee/route');
  return PATCH(new Request('http://t/x', { method: 'PATCH', ...bearer(jwt), body: JSON.stringify({ setupFeeCents }) }), { params: { tenantId } });
}

afterEach(() => closeDb());

describe('PATCH /api/platform/tenants/:id/rate', () => {
  test('platform auth required — 403 for a tenant-type token', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const tenantJwt = issueToken({ sub: 'user-1', tenantId: t.id, role: 'admin', type: 'tenant' });
    expect((await patchRate(tenantJwt, t.id, 12000)).status).toBe(403);
  });

  test('platform caller updates the rate (no live subscription — local only)', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await patchRate(platformJwt, t.id, 12500);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ monthlyRateCents: 12500, pushedToStripe: false });
  });

  test('a non-numeric body is a 400, not a 500', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });
    const res = await patchRate(platformJwt, t.id, 'not-a-number');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/platform/tenants/:id/setup-fee', () => {
  test('platform auth required — 403 for a tenant-type token', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const tenantJwt = issueToken({ sub: 'user-1', tenantId: t.id, role: 'admin', type: 'tenant' });
    expect((await patchSetupFee(tenantJwt, t.id, 5000)).status).toBe(403);
  });

  test('platform caller updates the fee pre-activation', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await patchSetupFee(platformJwt, t.id, 5000);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ setupFeeCents: 5000, updated: true });
  });

  test('is blocked (200, updated:false) once billing has attached — not a 500, not silently accepted', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    db.prepare('UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?').run('cus_x', 'sub_x', t.id);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await patchSetupFee(platformJwt, t.id, 5000);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.updated).toBe(false);
    expect(body.data.blockedReason).toMatch(/already invoiced/i);
  });

  test('null is accepted (clears the fee)', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const res = await patchSetupFee(platformJwt, t.id, null);
    expect(res.status).toBe(200);
  });
});
