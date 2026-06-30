// Phase 10, Slice A — global command-palette search.
//
// Behavioral. Proves scope clamping (non-vacuous), recent-viewed from the audit trail,
// no-results, the 10-per-type cap, by-type grouping, and Admin/District-only user search,
// plus the vendor.viewed/location.viewed events that feed recent-viewed.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedRegion, seedLocation, seedVendor, seedVendorLocation, assignUserToLocation,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { searchEntities } from '@/lib/search/search';
import { simpleLocationNameMatcher } from '@/lib/search/location-name';

const ORG = { locationIds: null as string[] | null };

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function viewEvent(db: Database.Database, tenantId: string, actorId: string, type: string, targetId: string, at: number): void {
  db.prepare(`INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, payload_json, created_at) VALUES (?,?,'user',?,?,?,?,'{}',?)`)
    .run(randomUUID(), tenantId, actorId, type, type.startsWith('vendor') ? 'vendor' : 'location', targetId, new Date(at).toISOString());
}

// ── location matcher (the new swappable seam) ─────────────────────────────────────────

describe('simpleLocationNameMatcher', () => {
  test('case + punctuation insensitive substring', () => {
    expect(simpleLocationNameMatcher.matches('Spokane Store #3', 'spokane')).toBe(true);
    expect(simpleLocationNameMatcher.matches('Spokane', 'tacoma')).toBe(false);
    expect(simpleLocationNameMatcher.matches('Anything', '')).toBe(true);
  });
});

// ── results: matching, grouping, cap, no-results ──────────────────────────────────────

describe('search — results', () => {
  test('matches vendors and locations by name, grouped', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id, { name: 'Acme Storage Spokane' });
    const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing', trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });

    const r = searchEntities(db, t.id, { scope: ORG, role: 'admin', actorId: 'a', query: 'acme' });
    expect(r.vendors.map((x) => x.name)).toEqual(['Acme Plumbing']);
    expect(r.locations.map((x) => x.name)).toEqual(['Acme Storage Spokane']);
    expect(r.recent).toBe(false);
    db.close();
  });

  test('no matches → empty groups', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id, { name: 'North' });
    const v = seedVendor(db, t.id, { business_name: 'Bolt Electric' }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    const r = searchEntities(db, t.id, { scope: ORG, role: 'admin', actorId: 'a', query: 'zzz' });
    expect(r.vendors).toHaveLength(0);
    expect(r.locations).toHaveLength(0);
    db.close();
  });

  test('caps at 10 per type', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id, { name: 'L0' });
    for (let i = 0; i < 15; i++) { const v = seedVendor(db, t.id, { business_name: `Match Vendor ${i}` }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' }); }
    const r = searchEntities(db, t.id, { scope: ORG, role: 'admin', actorId: 'a', query: 'match' });
    expect(r.vendors).toHaveLength(10);
    db.close();
  });
});

// ── scope clamp (non-vacuous) ──────────────────────────────────────────────────────────

describe('search — scope clamp', () => {
  test('Store scope (L1) sees L1 vendor/location only; the L2 ones exist for Admin', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const l1 = seedLocation(db, t.id, { name: 'Match Store One' });
    const l2 = seedLocation(db, t.id, { name: 'Match Store Two' });
    const v1 = seedVendor(db, t.id, { business_name: 'Match Vendor In' }); seedVendorLocation(db, t.id, v1.id, l1.id, { status: 'approved' });
    const v2 = seedVendor(db, t.id, { business_name: 'Match Vendor Out' }); seedVendorLocation(db, t.id, v2.id, l2.id, { status: 'approved' });

    // Admin (non-vacuous): both exist
    const admin = searchEntities(db, t.id, { scope: ORG, role: 'admin', actorId: 'a', query: 'match' });
    expect(admin.vendors.map((x) => x.name).sort()).toEqual(['Match Vendor In', 'Match Vendor Out']);
    expect(admin.locations.map((x) => x.name).sort()).toEqual(['Match Store One', 'Match Store Two']);

    // Store scoped to L1: only L1
    const store = searchEntities(db, t.id, { scope: { locationIds: [l1.id] }, role: 'store_manager', actorId: 's', query: 'match' });
    expect(store.vendors.map((x) => x.name)).toEqual(['Match Vendor In']);
    expect(store.locations.map((x) => x.name)).toEqual(['Match Store One']);
    db.close();
  });

  test('empty scope → nothing', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id, { name: 'Match Store' });
    const v = seedVendor(db, t.id, { business_name: 'Match Vendor' }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    const r = searchEntities(db, t.id, { scope: { locationIds: [] }, role: 'store_manager', actorId: 's', query: 'match' });
    expect(r.vendors).toHaveLength(0);
    expect(r.locations).toHaveLength(0);
    db.close();
  });
});

// ── users: Admin/District only ─────────────────────────────────────────────────────────

describe('search — users', () => {
  test('Admin sees matching users; Store Manager gets none', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'store_manager', name: 'Match Mary', email: 'mary@x.test' });
    const admin = searchEntities(db, t.id, { scope: ORG, role: 'admin', actorId: 'a', query: 'match' });
    expect(admin.users.some((u) => u.name === 'Match Mary')).toBe(true);
    const store = searchEntities(db, t.id, { scope: { locationIds: [] }, role: 'store_manager', actorId: 's', query: 'match' });
    expect(store.users).toHaveLength(0);
    db.close();
  });
});

// ── recent-viewed from the audit trail ─────────────────────────────────────────────────

describe('search — recent-viewed (empty query)', () => {
  test('empty query returns the actor’s recently-viewed entities, newest-first, scope-clamped', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id, { name: 'Viewed Store' });
    const vA = seedVendor(db, t.id, { business_name: 'Viewed Vendor A' }); seedVendorLocation(db, t.id, vA.id, loc.id, { status: 'approved' });
    const vB = seedVendor(db, t.id, { business_name: 'Viewed Vendor B' }); seedVendorLocation(db, t.id, vB.id, loc.id, { status: 'approved' });
    // Views: A (older), then B (newer)
    viewEvent(db, t.id, u.id, 'vendor.viewed', vA.id, 1000);
    viewEvent(db, t.id, u.id, 'vendor.viewed', vB.id, 2000);
    viewEvent(db, t.id, u.id, 'location.viewed', loc.id, 1500);
    // a different user's view must not appear
    const other = seedTenantUser(db, t.id, { role: 'admin' });
    const vC = seedVendor(db, t.id, { business_name: 'Other Viewed' }); seedVendorLocation(db, t.id, vC.id, loc.id, { status: 'approved' });
    viewEvent(db, t.id, other.id, 'vendor.viewed', vC.id, 3000);

    const r = searchEntities(db, t.id, { scope: ORG, role: 'admin', actorId: u.id, query: '' });
    expect(r.recent).toBe(true);
    expect(r.vendors.map((x) => x.name)).toEqual(['Viewed Vendor B', 'Viewed Vendor A']); // newest-first
    expect(r.locations.map((x) => x.name)).toEqual(['Viewed Store']);
    expect(r.vendors.map((x) => x.name)).not.toContain('Other Viewed');
    db.close();
  });

  test('recent-viewed is scope-clamped: a Store user does not see an out-of-scope viewed vendor', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const u = seedTenantUser(db, t.id, { role: 'store_manager' });
    const l1 = seedLocation(db, t.id); const l2 = seedLocation(db, t.id);
    assignUserToLocation(db, u.id, l1.id, t.id);
    const vIn = seedVendor(db, t.id, { business_name: 'In Scope' }); seedVendorLocation(db, t.id, vIn.id, l1.id, { status: 'approved' });
    const vOut = seedVendor(db, t.id, { business_name: 'Out Scope' }); seedVendorLocation(db, t.id, vOut.id, l2.id, { status: 'approved' });
    viewEvent(db, t.id, u.id, 'vendor.viewed', vIn.id, 1000);
    viewEvent(db, t.id, u.id, 'vendor.viewed', vOut.id, 2000); // viewed but now out of scope

    const r = searchEntities(db, t.id, { scope: { locationIds: [l1.id] }, role: 'store_manager', actorId: u.id, query: '' });
    expect(r.vendors.map((x) => x.name)).toEqual(['In Scope']);
    db.close();
  });
});

// ── route + view events ────────────────────────────────────────────────────────────────

describe('search — route + view-event wiring', () => {
  afterEach(() => closeDb());

  test('GET /api/vendors/:id logs vendor.viewed; GET /api/search?q= returns scoped results', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing' }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    const jwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const vendorGet = await import('@/app/api/vendors/[id]/route');
    await vendorGet.GET(new Request(`http://t/api/vendors/${v.id}`, { headers: { Authorization: `Bearer ${jwt}` } }), { params: { id: v.id } });
    const viewed = db.prepare(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='vendor.viewed' AND target_id=?`).get(t.id, v.id);
    expect(viewed).toBeDefined();

    const search = await import('@/app/api/search/route');
    const res = await search.GET(new Request('http://t/api/search?q=acme', { headers: { Authorization: `Bearer ${jwt}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.vendors[0].name).toBe('Acme Plumbing');
  });
});
