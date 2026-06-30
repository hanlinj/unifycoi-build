// Phase 10, Slice F — Requirements Configuration UI backend touches.
//
// Covers the new read-only resolve endpoint (matrix + provenance), the precedence-reason
// enforcement (audit invariant #10), and Admin-only access. Rule add/edit via PUT
// /api/requirements is already covered by the Phase 3 suite.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { seedTenant, seedTenantUser, seedLocation, seedRequirementSettings, seedRequirementRule } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { issueToken } from '@/lib/auth/jwt';

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }

function world() {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db);
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const store = seedTenantUser(db, t.id, { role: 'store_manager' });
  const loc = seedLocation(db, t.id, { name: 'Spokane' });
  seedRequirementSettings(db, t.id);
  // org base GL 1M, trade override (plumbing) GL 2M
  seedRequirementRule(db, t.id, admin.id, { scope_type: 'org', scope_ref: null, requirement_key: 'coverage.general_liability.each_occurrence', required_value: '1000000' });
  seedRequirementRule(db, t.id, admin.id, { scope_type: 'trade', scope_ref: 'plumbing', requirement_key: 'coverage.general_liability.each_occurrence', required_value: '2000000' });
  return { db, t, loc: loc.id, adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }), storeJwt: issueToken({ sub: store.id, tenantId: t.id, role: 'store_manager', type: 'tenant' }) };
}

afterEach(() => closeDb());

describe('GET /api/requirements/resolve', () => {
  test('returns the effective matrix with source provenance (trade override wins under strictest)', async () => {
    const w = world();
    const { GET } = await import('@/app/api/requirements/resolve/route');
    const res = await GET(new Request(`http://t/api/requirements/resolve?trade=plumbing&location=${w.loc}`, bearer(w.adminJwt)));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const gl = data.entries.find((e: { requirement_key: string }) => e.requirement_key === 'coverage.general_liability.each_occurrence');
    expect(gl.required_value).toBe('2000000'); // trade override (2M) beats org base (1M) under strictest
    expect(gl.source).toBe('trade');
  });

  test('requires trade and location (400)', async () => {
    const w = world();
    const { GET } = await import('@/app/api/requirements/resolve/route');
    expect((await GET(new Request('http://t/api/requirements/resolve?trade=plumbing', bearer(w.adminJwt)))).status).toBe(400);
  });

  test('non-admin → 403', async () => {
    const w = world();
    const { GET } = await import('@/app/api/requirements/resolve/route');
    expect((await GET(new Request(`http://t/api/requirements/resolve?trade=plumbing&location=${w.loc}`, bearer(w.storeJwt)))).status).toBe(403);
  });
});

describe('PUT /api/requirements/precedence — reason required', () => {
  async function put(jwt: string, body: unknown) {
    return (await import('@/app/api/requirements/precedence/route')).PUT(new Request('http://t/api/requirements/precedence', { method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  test('missing/short reason → 400; valid reason → 200 + reason in audit', async () => {
    const w = world();
    expect((await put(w.adminJwt, { policy: 'location' })).status).toBe(400);
    expect((await put(w.adminJwt, { policy: 'location', reason: 'short' })).status).toBe(400);
    const ok = await put(w.adminJwt, { policy: 'location', reason: 'Spokane insurer requires location precedence.' });
    expect(ok.status).toBe(200);
    const tdb = new TenantDB(w.db, w.t.id);
    const ev = tdb.get<{ payload_json: string }>(`SELECT payload_json FROM audit_events WHERE tenant_id=? AND event_type='requirement.precedence_changed' ORDER BY created_at DESC LIMIT 1`);
    expect(JSON.parse(ev!.payload_json).reason).toContain('Spokane insurer');
  });
  test('non-admin → 403', async () => {
    const w = world();
    expect((await put(w.storeJwt, { policy: 'trade', reason: 'should be blocked anyway' })).status).toBe(403);
  });
});

describe('GET /api/requirements — page data, Admin-only', () => {
  test('Admin gets rules grouped + precedence + floor; Store 403', async () => {
    const w = world();
    const { GET } = await import('@/app/api/requirements/route');
    const res = await GET(new Request('http://t/api/requirements', bearer(w.adminJwt)));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.rules.org.length).toBe(1);
    expect(data.rules.trade.length).toBe(1);
    expect(['strictest', 'location', 'trade']).toContain(data.precedence);
    expect((await GET(new Request('http://t/api/requirements', bearer(w.storeJwt)))).status).toBe(403);
  });
});
