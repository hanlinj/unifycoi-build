// Phase 10, Slice D — consolidated integration sweep.
//
// Items: search scope-clamp (non-vacuous), landing role-routing (real RootPage + JWT verify),
// six-report download contract, global-invite scope-clamp (+ violation logging), middleware
// route guard. Item 3 (no-chrome-leak render) lives in phase10-chrome-render.test.ts.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  seedTenant, seedTenantUser, seedRegion, seedLocation, seedVendor, seedVendorLocation,
  seedRequirementSettings, assignUserToRegion, assignUserToLocation,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { REPORTS } from '@/lib/reports';

// next/headers is mocked so the root page can read a cookie outside a request scope.
let mockToken: string | undefined;
jest.mock('next/headers', () => ({
  cookies: () => ({ get: (_n: string) => (mockToken ? { value: mockToken } : undefined) }),
}));

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
const tok = (sub: string, tenantId: string | null, role: string, type: 'tenant' | 'platform' = 'tenant') => issueToken({ sub, tenantId, role, type });
const bearer = (jwt: string) => ({ headers: { Authorization: `Bearer ${jwt}` } });

afterEach(() => closeDb());

// ── 1. Search scope-clamp (non-vacuous, via the route) ─────────────────────────────────

describe('integration — search scope clamp', () => {
  test('Admin sees all matching; District[R1,R2] sees R1/R2; Store[L1] sees L1 only', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const district = seedTenantUser(db, t.id, { role: 'district_manager' });
    const store = seedTenantUser(db, t.id, { role: 'store_manager' });
    const r1 = seedRegion(db, t.id, 'R1'); const r2 = seedRegion(db, t.id, 'R2'); const r3 = seedRegion(db, t.id, 'R3');
    assignUserToRegion(db, district.id, r1.id, t.id); assignUserToRegion(db, district.id, r2.id, t.id);
    const l1 = seedLocation(db, t.id, { name: 'Match One', regionId: r1.id });
    const l2 = seedLocation(db, t.id, { name: 'Match Two', regionId: r2.id });
    const l3 = seedLocation(db, t.id, { name: 'Match Three', regionId: r3.id });
    assignUserToLocation(db, store.id, l1.id, t.id);
    for (const [n, l] of [['Match V1', l1], ['Match V2', l2], ['Match V3', l3]] as const) {
      const v = seedVendor(db, t.id, { business_name: n }); seedVendorLocation(db, t.id, v.id, l.id, { status: 'approved' });
    }
    const { GET } = await import('@/app/api/search/route');
    const names = async (jwt: string) => ((await (await GET(new Request('http://t/api/search?q=match', bearer(jwt)))).json()).data.vendors as { name: string }[]).map((v) => v.name).sort();

    expect(await names(tok(admin.id, t.id, 'admin'))).toEqual(['Match V1', 'Match V2', 'Match V3']); // non-vacuous
    expect(await names(tok(district.id, t.id, 'district_manager'))).toEqual(['Match V1', 'Match V2']); // R1+R2, not R3
    expect(await names(tok(store.id, t.id, 'store_manager'))).toEqual(['Match V1']); // L1 only
  });
});

// ── 2. Landing role-routing (real RootPage + JWT verify) ────────────────────────────────

describe('integration — landing routing', () => {
  async function landingFor(token: string | undefined): Promise<string> {
    mockToken = token;
    const RootPage = (await import('@/app/page')).default;
    try { RootPage(); return 'NO_REDIRECT'; }
    catch (e: unknown) { return String((e as { digest?: string }).digest ?? (e as Error).message); }
  }
  test('Admin/District → /command-center, Store → /dashboard, Platform → /platform, none/garbage → /login', async () => {
    expect(await landingFor(tok('a', 't1', 'admin'))).toContain('/command-center');
    expect(await landingFor(tok('d', 't1', 'district_manager'))).toContain('/command-center');
    expect(await landingFor(tok('s', 't1', 'store_manager'))).toContain('/dashboard');
    expect(await landingFor(tok('p', null, 'owner', 'platform'))).toContain('/platform');
    expect(await landingFor(undefined)).toContain('/login');
    expect(await landingFor('not-a-jwt')).toContain('/login');
  });
});

// ── 4. Six-report download contract ──────────────────────────────────────────────────────

describe('integration — every report download', () => {
  test.each(REPORTS.flatMap((r) => [['csv', r.key], ['pdf', r.key]] as const))(
    '%s of %s → attachment + non-empty', async (fmt, key) => {
      closeDb();
      const db = getRawDb();
      migrate(db);
      const t = seedTenant(db);
      const admin = seedTenantUser(db, t.id, { role: 'admin' });
      seedRequirementSettings(db, t.id);
      const loc = seedLocation(db, t.id);
      const v = seedVendor(db, t.id, { business_name: 'Acme' }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
      const { GET } = await import('@/app/api/reports/[reportKey]/route');
      const res = await GET(new Request(`http://t/api/reports/${key}?format=${fmt}`, bearer(tok(admin.id, t.id, 'admin'))), { params: { reportKey: key } });
      expect(res.status).toBe(200);
      const cd = res.headers.get('content-disposition') ?? '';
      expect(cd).toContain('attachment');
      expect(cd).toContain(`${key}-`);
      expect(cd).toContain(`.${fmt}`);
      expect(Buffer.from(await res.arrayBuffer()).length).toBeGreaterThan(0);
    }
  );
});

// ── 5. Global-invite scope clamp (+ violation logging) ──────────────────────────────────

describe('integration — invite scope clamp', () => {
  function world() {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const district = seedTenantUser(db, t.id, { role: 'district_manager' });
    const store = seedTenantUser(db, t.id, { role: 'store_manager' });
    const r1 = seedRegion(db, t.id, 'R1'); const r2 = seedRegion(db, t.id, 'R2');
    assignUserToRegion(db, district.id, r1.id, t.id);
    const lIn = seedLocation(db, t.id, { regionId: r1.id }); const lOut = seedLocation(db, t.id, { regionId: r2.id });
    assignUserToLocation(db, store.id, lIn.id, t.id);
    return { db, t, admin, district, store, lIn, lOut };
  }
  async function invite(jwt: string, locationIds: string[]) {
    const body = { businessName: `Biz ${randomUUID().slice(0, 6)}`, contactFirstName: 'A', contactLastName: 'B', email: `${randomUUID().slice(0, 8)}@x.test`, companyPhone: '555-0100', trade: 'plumbing', locationIds };
    return (await import('@/app/api/vendors/invite/route')).POST(new Request('http://t/api/vendors/invite', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  const violations = (db: Database.Database, tid: string) => (db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE tenant_id=? AND event_type='security.scope_violation'`).get(tid) as { n: number }).n;

  test('District out-of-region → 403 + violation logged', async () => {
    const w = world();
    expect((await invite(tok(w.district.id, w.t.id, 'district_manager'), [w.lOut.id])).status).toBe(403);
    expect(violations(w.db, w.t.id)).toBe(1);
  });
  test('Store non-assigned location → 403 + violation logged', async () => {
    const w = world();
    expect((await invite(tok(w.store.id, w.t.id, 'store_manager'), [w.lOut.id])).status).toBe(403);
    expect(violations(w.db, w.t.id)).toBe(1);
  });
  test('Admin any in-tenant location → success', async () => {
    const w = world();
    expect((await invite(tok(w.admin.id, w.t.id, 'admin'), [w.lOut.id])).status).toBe(201);
    expect(violations(w.db, w.t.id)).toBe(0);
  });
});

// ── 6. Middleware route guard ────────────────────────────────────────────────────────────

describe('integration — middleware route guard', () => {
  test('no cookie → redirect /login; cookie present → next()', async () => {
    const { middleware } = await import('@/middleware');
    const { NextRequest } = await import('next/server');
    const noCookie = middleware(new NextRequest('http://t/dashboard'));
    expect(noCookie.status).toBe(307); // redirect
    expect(noCookie.headers.get('location')).toContain('/login');

    const withCookie = middleware(new NextRequest('http://t/dashboard', { headers: { cookie: 'uc_session=abc' } }));
    expect(withCookie.headers.get('location')).toBeNull(); // next(), no redirect
  });

  test('matcher excludes /login, /v/*, /api/*; includes /dashboard', async () => {
    const cfg = (await import('@/middleware')).config;
    const re = new RegExp(`^${cfg.matcher[0]}$`);
    expect(re.test('/dashboard')).toBe(true);
    expect(re.test('/v/sometoken')).toBe(false); // vendor surface never guarded
    expect(re.test('/login')).toBe(false);
    expect(re.test('/api/search')).toBe(false);
  });
});
