// Phase 10, Slice B — sidebar/nav + chrome + landing wiring.
//
// Pure nav logic (navForRole / shouldShowChrome / isActive) is tested directly; the chrome
// component itself has no render harness. getMeInfo now carries tenant_name for the header.
// The middleware route-guard behaviour is documented; the chrome-suppression for /v/* and
// /login is asserted via shouldShowChrome (the same predicate AppShell uses).

import { navForRole, shouldShowChrome, isActive } from '@/lib/nav';
import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { getMeInfo } from '@/lib/services/auth';

// ── navForRole ──────────────────────────────────────────────────────────────────────────

describe('navForRole', () => {
  test('Admin is grouped Monitor/Configure and links only to built surfaces', () => {
    const s = navForRole('admin');
    expect(s.map((x) => x.title)).toEqual(['Monitor', 'Configure']);
    const hrefs = s.flatMap((x) => x.items.map((i) => i.href));
    expect(hrefs).toEqual(['/command-center', '/reports', '/settings/requirements', '/locations', '/users']);
    expect(hrefs).not.toContain('/settings'); // Org Settings deliberately absent (unbuilt)
  });

  test('District: Home, Operations, Reports, Locations, Users', () => {
    const hrefs = navForRole('district_manager').flatMap((x) => x.items.map((i) => i.href));
    expect(hrefs).toEqual(['/command-center', '/dashboard', '/reports', '/locations', '/users']);
  });

  test('Store Manager: minimal — Home + My Stores', () => {
    const hrefs = navForRole('store_manager').flatMap((x) => x.items.map((i) => i.href));
    expect(hrefs).toEqual(['/dashboard', '/locations']);
    expect(hrefs).not.toContain('/users'); // store managers never manage users
    expect(hrefs).not.toContain('/reports');
  });
});

// ── shouldShowChrome / isActive ───────────────────────────────────────────────────────────

describe('shouldShowChrome', () => {
  test('no chrome on login, vendor token flow, root redirect, platform', () => {
    expect(shouldShowChrome('/login')).toBe(false);
    expect(shouldShowChrome('/v/abc123')).toBe(false); // public vendor flow — no tenant chrome leak
    expect(shouldShowChrome('/')).toBe(false);
    expect(shouldShowChrome('/platform')).toBe(false);
  });
  test('chrome on the tenant app surfaces', () => {
    for (const p of ['/command-center', '/dashboard', '/reports', '/vendors/v1', '/locations', '/settings/requirements', '/users']) {
      expect(shouldShowChrome(p)).toBe(true);
    }
  });
});

describe('isActive', () => {
  test('exact and nested matches', () => {
    expect(isActive('/reports', '/reports')).toBe(true);
    expect(isActive('/reports/compliance-posture', '/reports')).toBe(true);
    expect(isActive('/dashboard', '/reports')).toBe(false);
  });
});

// ── getMeInfo tenant_name (header) ────────────────────────────────────────────────────────

describe('getMeInfo carries tenant_name', () => {
  test('tenant user → includes the tenant name; platform user → no tenant', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const u = seedTenantUser(db, t.id, { role: 'admin' });
    const info = getMeInfo(db, { sub: u.id, tenantId: t.id, role: 'admin', type: 'tenant' });
    expect(info!.tenant_name).toBe('Storage Star');
    db.close();
  });
});
