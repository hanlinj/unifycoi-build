// Phase 10, Slice C — report download wiring contract.
//
// The download buttons are plain same-origin links; they trigger a browser download ONLY because
// the API responds with Content-Disposition: attachment. This locks that contract (a regression
// to 'inline' would silently break the buttons) for both formats, with a non-empty body.
// (The invite modal is client UI wiring of POST /api/vendors/invite — its scope clamp is covered
// by the Phase 8 vendor-invite suite; Slice D adds the consolidated invite integration test.)

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { seedTenant, seedTenantUser, seedLocation, seedVendor, seedVendorLocation } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

describe('report download contract', () => {
  afterEach(() => closeDb());

  test.each(['csv', 'pdf'])('format=%s → Content-Disposition: attachment with filename, non-empty body', async (fmt) => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Acme' }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    const jwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const { GET } = await import('@/app/api/reports/[reportKey]/route');
    const res = await GET(new Request(`http://t/api/reports/vendor-roster?format=${fmt}`, { headers: { Authorization: `Bearer ${jwt}` } }), { params: { reportKey: 'vendor-roster' } });

    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain(`vendor-roster-`);
    expect(cd).toContain(`.${fmt}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
  });
});
