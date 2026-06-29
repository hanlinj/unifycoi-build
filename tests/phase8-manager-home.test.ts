// Phase 8, Slice B — Manager Home Dashboard ("who can I hire").
//
// Behavioral tests against the real DB. Proves: only approved vendors at active locations
// appear; trade grouping; trade facet + name search; expiry urgency; scope clamp; cross-tenant.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedVendor, seedLocation, seedVendorLocation,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { buildManagerHome } from '@/lib/services/manager-home';
import { queueNotification } from '@/lib/notifications/queue';
import { normalizeForSearch, simpleVendorNameMatcher } from '@/lib/search/vendor-name';

const NOW = Date.parse('2026-06-29T12:00:00.000Z');
const DAY = 86_400_000;
const ALL = { locationIds: null as string[] | null };

function approvedVendor(db: Database.Database, tenantId: string, locId: string, opts: { name?: string; trade?: string } = {}) {
  const v = seedVendor(db, tenantId, { business_name: opts.name, trade: opts.trade ?? 'plumbing' });
  seedVendorLocation(db, tenantId, v.id, locId, { status: 'approved' });
  return v;
}
function seedChase(db: Database.Database, tenantId: string, vendorId: string, expirationIso: string) {
  queueNotification(db, tenantId, {
    recipientType: 'vendor', recipientRef: 'v@x.test', kind: 'exception', scheduledFor: expirationIso,
    payload: { type: 'renewal_reminder', vendor_id: vendorId, expiration_date: expirationIso, days_before: 30 },
  });
}

// ── name matcher ───────────────────────────────────────────────────────────────────

describe('simpleVendorNameMatcher', () => {
  test('case + punctuation insensitive substring', () => {
    expect(simpleVendorNameMatcher.matches('Acme, Inc.', 'acme')).toBe(true);
    expect(simpleVendorNameMatcher.matches('Acme Plumbing', 'plumb')).toBe(true);
    expect(simpleVendorNameMatcher.matches('Acme Plumbing', 'xyz')).toBe(false);
  });
  test('empty query matches everything', () => {
    expect(simpleVendorNameMatcher.matches('Anything', '')).toBe(true);
  });
  test('normalizeForSearch strips punctuation + case', () => {
    expect(normalizeForSearch('Acme, Inc.')).toBe('acmeinc');
  });
});

// ── inclusion rules ─────────────────────────────────────────────────────────────────

describe('Manager Home — who appears', () => {
  test('only approved vendors appear; under_review / expired / declined do not', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const appr = approvedVendor(db, t.id, loc.id, { name: 'Approved Co' });
    for (const s of ['under_review', 'expired', 'declined', 'non_compliant', 'onboarding', 'invited_pending']) {
      const v = seedVendor(db, t.id, { business_name: `${s} Co` });
      seedVendorLocation(db, t.id, v.id, loc.id, { status: s });
    }
    const mh = buildManagerHome(db, t.id, ALL, {}, NOW);
    const names = mh.groups.flatMap((g) => g.vendors.map((v) => v.name));
    expect(names).toEqual(['Approved Co']);
    expect(mh.totalApproved).toBe(1);
    void appr;
    db.close();
  });

  test('vendor approved only at an ARCHIVED location does not appear (not hireable)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const active = seedLocation(db, t.id, { status: 'active' });
    const archived = seedLocation(db, t.id, { status: 'archived' });
    const vArch = seedVendor(db, t.id, { business_name: 'Archived-Only Co' });
    seedVendorLocation(db, t.id, vArch.id, archived.id, { status: 'approved' });
    approvedVendor(db, t.id, active.id, { name: 'Active Co' });

    const mh = buildManagerHome(db, t.id, ALL, {}, NOW);
    const names = mh.groups.flatMap((g) => g.vendors.map((v) => v.name));
    expect(names).toContain('Active Co');
    expect(names).not.toContain('Archived-Only Co');
    db.close();
  });
});

// ── grouping + filters ──────────────────────────────────────────────────────────────

describe('Manager Home — grouping and filters', () => {
  function seeded() {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    approvedVendor(db, t.id, loc.id, { name: 'Anchor Plumbing', trade: 'plumbing' });
    approvedVendor(db, t.id, loc.id, { name: 'Bolt Electric', trade: 'electrical' });
    approvedVendor(db, t.id, loc.id, { name: 'Acme Plumbing', trade: 'plumbing' });
    return { db, t };
  }

  test('vendors grouped by trade, alpha within group, trades alpha', () => {
    const { db, t } = seeded();
    const mh = buildManagerHome(db, t.id, ALL, {}, NOW);
    expect(mh.groups.map((g) => g.trade)).toEqual(['electrical', 'plumbing']);
    expect(mh.groups[1].vendors.map((v) => v.name)).toEqual(['Acme Plumbing', 'Anchor Plumbing']);
    db.close();
  });

  test('trade facet filters to one group; trades list still shows all', () => {
    const { db, t } = seeded();
    const mh = buildManagerHome(db, t.id, ALL, { trade: 'electrical' }, NOW);
    expect(mh.groups.map((g) => g.trade)).toEqual(['electrical']);
    expect(mh.trades).toEqual(['electrical', 'plumbing']); // chips unaffected by the active filter
    db.close();
  });

  test('name search matches case/punctuation-insensitively', () => {
    const { db, t } = seeded();
    const mh = buildManagerHome(db, t.id, ALL, { q: 'acme' }, NOW);
    const names = mh.groups.flatMap((g) => g.vendors.map((v) => v.name));
    expect(names).toEqual(['Acme Plumbing']);
    db.close();
  });

  test('no matches → empty groups, filters echoed', () => {
    const { db, t } = seeded();
    const mh = buildManagerHome(db, t.id, ALL, { q: 'zzz' }, NOW);
    expect(mh.groups).toHaveLength(0);
    expect(mh.activeFilters.q).toBe('zzz');
    db.close();
  });
});

// ── expiry urgency ──────────────────────────────────────────────────────────────────

describe('Manager Home — expiry urgency', () => {
  test('<30d expiry → expiringSoon true; >30d → false; urgent sorts first', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const soon = approvedVendor(db, t.id, loc.id, { name: 'Zeta Soon', trade: 'plumbing' });
    seedChase(db, t.id, soon.id, new Date(NOW + 10 * DAY).toISOString());
    const far = approvedVendor(db, t.id, loc.id, { name: 'Alpha Far', trade: 'plumbing' });
    seedChase(db, t.id, far.id, new Date(NOW + 200 * DAY).toISOString());

    const mh = buildManagerHome(db, t.id, ALL, {}, NOW);
    const plumbers = mh.groups[0].vendors;
    // urgent first despite alphabetical Z > A
    expect(plumbers[0].name).toBe('Zeta Soon');
    expect(plumbers[0].expiringSoon).toBe(true);
    expect(plumbers[0].daysToExpiry).toBe(10);
    expect(plumbers[1].expiringSoon).toBe(false);
    db.close();
  });

  test('no chase rows → expiresAt null, not urgent', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    approvedVendor(db, t.id, loc.id, { name: 'No Expiry Co' });
    const mh = buildManagerHome(db, t.id, ALL, {}, NOW);
    expect(mh.groups[0].vendors[0].expiresAt).toBeNull();
    expect(mh.groups[0].vendors[0].expiringSoon).toBe(false);
    db.close();
  });
});

// ── scope + cross-tenant ────────────────────────────────────────────────────────────

describe('Manager Home — scope', () => {
  test('scoped to L1 → vendor approved only at L2 does not appear; vendor at both shows only L1', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const l1 = seedLocation(db, t.id, { name: 'Store One' });
    const l2 = seedLocation(db, t.id, { name: 'Store Two' });
    const onlyL2 = approvedVendor(db, t.id, l2.id, { name: 'L2 Only' });
    const both = seedVendor(db, t.id, { business_name: 'Both Stores' });
    seedVendorLocation(db, t.id, both.id, l1.id, { status: 'approved' });
    seedVendorLocation(db, t.id, both.id, l2.id, { status: 'approved' });

    const mh = buildManagerHome(db, t.id, { locationIds: [l1.id] }, {}, NOW);
    const names = mh.groups.flatMap((g) => g.vendors.map((v) => v.name));
    expect(names).toContain('Both Stores');
    expect(names).not.toContain('L2 Only');
    // the "Both Stores" row shows only the in-scope location
    const row = mh.groups.flatMap((g) => g.vendors).find((v) => v.name === 'Both Stores')!;
    expect(row.locations.map((l) => l.name)).toEqual(['Store One']);
    void onlyL2;
    db.close();
  });

  test('empty scope → empty result', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    approvedVendor(db, t.id, loc.id);
    const mh = buildManagerHome(db, t.id, { locationIds: [] }, {}, NOW);
    expect(mh.groups).toHaveLength(0);
    expect(mh.facilitiesInScope).toBe(0);
    db.close();
  });

  test('cross-tenant: tenant B dashboard never shows tenant A vendors (non-vacuous)', () => {
    const db = setupTestDb();
    const tA = seedTenant(db);
    const tB = seedTenant(db);
    const locA = seedLocation(db, tA.id);
    approvedVendor(db, tA.id, locA.id, { name: 'Tenant A Vendor' });
    expect(buildManagerHome(db, tA.id, ALL, {}, NOW).totalApproved).toBe(1);
    expect(buildManagerHome(db, tB.id, ALL, {}, NOW).totalApproved).toBe(0);
    db.close();
  });
});

// ── API wiring smoke ────────────────────────────────────────────────────────────────

describe('GET /api/dashboard wiring smoke', () => {
  afterEach(() => closeDb());
  test('authenticated Admin gets a body containing a seeded approved vendor name', async () => {
    closeDb();
    const db = getRawDb();
    const dir = path.join(process.cwd(), 'src', 'migrations');
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));

    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    approvedVendor(db, t.id, loc.id, { name: 'Hireable Smoke Co', trade: 'plumbing' });

    const jwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });
    const { GET } = await import('@/app/api/dashboard/route');
    const res = await GET(new Request('http://t/api/dashboard', { headers: { Authorization: `Bearer ${jwt}` } }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Hireable Smoke Co');
    expect(body).toContain('"trade":"plumbing"');
  });
});
