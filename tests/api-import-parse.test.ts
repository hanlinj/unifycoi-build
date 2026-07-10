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

function csvRequest(url: string, jwt: string): Request {
  const form = new FormData();
  const csv = 'Store Name,Address,Manager Email\nMain St,1 Main St,bob@store.test\n';
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'stores.csv');
  return new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
}

afterEach(() => closeDb());

describe('POST /api/platform/import/parse', () => {
  test('platform-authed request parses a csv into rows (creates nothing)', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const platformJwt = issueToken({ sub: 'plat-1', tenantId: null, role: 'owner', type: 'platform' });

    const { POST } = await import('@/app/api/platform/import/parse/route');
    const res = await POST(csvRequest('http://t/api/platform/import/parse', platformJwt));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ storeName: 'Main St', address: '1 Main St', managerFirstName: '', managerLastName: '', managerEmail: 'bob@store.test' }]);

    const count = db.prepare('SELECT COUNT(*) as n FROM locations').get() as { n: number };
    expect(count.n).toBe(0);
  });

  test('a tenant-scoped token is rejected', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const tenantJwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const { POST } = await import('@/app/api/platform/import/parse/route');
    const res = await POST(csvRequest('http://t/api/platform/import/parse', tenantJwt));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/locations/import/parse', () => {
  test('Admin can parse a csv into rows', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const adminJwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const { POST } = await import('@/app/api/locations/import/parse/route');
    const res = await POST(csvRequest('http://t/api/locations/import/parse', adminJwt));
    expect(res.status).toBe(200);
  });

  test('a store manager is forbidden', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const sm = seedTenantUser(db, t.id, { role: 'store_manager' });
    const smJwt = issueToken({ sub: sm.id, tenantId: t.id, role: 'store_manager', type: 'tenant' });

    const { POST } = await import('@/app/api/locations/import/parse/route');
    const res = await POST(csvRequest('http://t/api/locations/import/parse', smJwt));
    expect(res.status).toBe(403);
  });
});
