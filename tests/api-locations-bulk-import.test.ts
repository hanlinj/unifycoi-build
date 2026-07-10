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

function bearer(jwt: string) { return { Authorization: `Bearer ${jwt}` }; }

async function postBulkImport(jwt: string, rows: unknown[]) {
  const { POST } = await import('@/app/api/locations/bulk-import/route');
  return POST(new Request('http://t/api/locations/bulk-import', { method: 'POST', headers: { ...bearer(jwt), 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) }));
}

function world() {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db);
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const storeManager = seedTenantUser(db, t.id, { role: 'store_manager' });
  return {
    db,
    tenantId: t.id,
    adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }),
    storeManagerJwt: issueToken({ sub: storeManager.id, tenantId: t.id, role: 'store_manager', type: 'tenant' }),
  };
}

afterEach(() => closeDb());

describe('POST /api/locations/bulk-import', () => {
  test('Admin can create locations + managers', async () => {
    const w = world();
    const res = await postBulkImport(w.adminJwt, [
      { storeName: 'Main St', address: '1 Main St', managerFirstName: 'Bob', managerLastName: 'Jones', managerEmail: 'bob@store.test' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.locationIds).toHaveLength(1);
    expect(body.data.managersCreated).toBe(1);
  });

  test('non-Admin is forbidden', async () => {
    const w = world();
    const res = await postBulkImport(w.storeManagerJwt, [{ storeName: 'Main St', address: '', managerFirstName: '', managerLastName: '', managerEmail: '' }]);
    expect(res.status).toBe(403);
  });

  test('an invalid row (manager name, no email) is rejected server-side, not just client-side', async () => {
    const w = world();
    const res = await postBulkImport(w.adminJwt, [
      { storeName: 'Main St', address: '', managerFirstName: 'Bob', managerLastName: '', managerEmail: '' },
    ]);
    expect(res.status).toBe(400);
    const count = w.db.prepare('SELECT COUNT(*) as n FROM locations WHERE tenant_id = ?').get(w.tenantId) as { n: number };
    expect(count.n).toBe(0); // nothing partially created
  });

  test('an all-blank row set is rejected', async () => {
    const w = world();
    const res = await postBulkImport(w.adminJwt, []);
    expect(res.status).toBe(400);
  });

  test('missing rows field is a 400, not a 500', async () => {
    const w = world();
    const { POST } = await import('@/app/api/locations/bulk-import/route');
    const res = await POST(new Request('http://t/api/locations/bulk-import', { method: 'POST', headers: { ...bearer(w.adminJwt), 'Content-Type': 'application/json' }, body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });
});
