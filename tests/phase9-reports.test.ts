// Phase 9, Slice B — report builders + on-demand API.
//
// Behavioral tests against the real DB. Each report: seeded domain data → expected shape/rows.
// Scope clamping (District/Store) and Store-403 via the route handler. Clock-frozen.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedRegion, seedLocation, seedVendor, seedVendorLocation,
  seedDocument, seedExtraction, assignUserToLocation, assignUserToRegion,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { queueNotification } from '@/lib/notifications/queue';
import { runReport } from '@/lib/reports/builders';
import type { FieldValue, ProcessedCOIExtraction } from '@/lib/extraction/types';

const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const DAY = 86_400_000;
const ORG = { locationIds: null as string[] | null };

function aevt(db: Database.Database, tenantId: string, vendorId: string, type: string, at: number): void {
  db.prepare(`INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, payload_json, created_at) VALUES (?,?,'user','u',?,'vendor',?,'{}',?)`)
    .run(randomUUID(), tenantId, type, vendorId, new Date(at).toISOString());
}
function chase(db: Database.Database, tenantId: string, vendorId: string, expMs: number, rung = 30): void {
  queueNotification(db, tenantId, { recipientType: 'vendor', recipientRef: 'v@x.test', kind: 'exception', scheduledFor: new Date(expMs).toISOString(), payload: { type: 'renewal_reminder', vendor_id: vendorId, expiration_date: new Date(expMs).toISOString(), days_before: rung } });
}
function fv<T>(v: T): FieldValue<T> { return { value: v, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false }; }
function coi(glEach: number): ProcessedCOIExtraction {
  return {
    doc_type: 'coi', document_type_confirmed: 'coi', certificate_date: fv<string | null>(null), producer: fv<string | null>(null),
    named_insured: fv<string | null>(null), insured_address: fv<string | null>(null), insurers: [],
    policies: [{ coverage_type: fv<string | null>('general_liability'), insurer_letter: fv<string | null>(null), policy_number: fv<string | null>(null), effective_date: fv<string | null>(null), expiration_date: fv<string | null>('2027-01-01'), limits: { each_occurrence: fv<number | null>(glEach) }, additional_insured: fv<boolean | null>(true), additional_insured_scope: fv<string | null>(null), waiver_of_subrogation: fv<boolean | null>(false), primary_noncontributory: fv<boolean | null>(null) }],
    additional_insured_entities: fv<string | null>(null), description_of_operations: fv<string | null>(null), certificate_holder: fv<string | null>(null),
  };
}
function seedRun(db: Database.Database, tenantId: string, vendorId: string, rec: string, at = NOW - DAY): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at) VALUES (?,?,?,'onboarding','1.0.0',?,?)`).run(id, tenantId, vendorId, rec, new Date(at).toISOString());
  return id;
}
function seedDef(db: Database.Database, tenantId: string, runId: string, vendorId: string, locId: string, key: string): void {
  db.prepare(`INSERT INTO requirement_evaluations (id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value, extracted_value_ref, comparison_result, confidence_band, outcome, note) VALUES (?,?,?,?,?,?,'x','x','fails','high','deficient',null)`).run(randomUUID(), tenantId, runId, vendorId, locId, key);
}

// ── #1 Compliance posture ────────────────────────────────────────────────────────────

describe('report: compliance-posture (Option A)', () => {
  test('current snapshot counts + compliant%, monthly transition trend', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const a = seedVendor(db, t.id); seedVendorLocation(db, t.id, a.id, loc.id, { status: 'approved' });
    const b = seedVendor(db, t.id); seedVendorLocation(db, t.id, b.id, loc.id, { status: 'expired' });
    aevt(db, t.id, a.id, 'vendor.approved', NOW - 40 * DAY);
    aevt(db, t.id, b.id, 'vendor.expired', NOW - 10 * DAY);

    const r = runReport(db, t.id, ORG, 'compliance-posture', {}, NOW).data as any;
    expect(r.snapshot.total).toBe(2);
    expect(r.snapshot.approved).toBe(1);
    expect(r.snapshot.compliantPct).toBe(50);
    expect(r.trend.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

// ── #2 Renewal forecast ──────────────────────────────────────────────────────────────

describe('report: renewal-forecast', () => {
  test('buckets by 30/60/90/beyond, soonest first', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const v1 = seedVendor(db, t.id, { business_name: 'Soon' }); seedVendorLocation(db, t.id, v1.id, loc.id, { status: 'approved' }); chase(db, t.id, v1.id, NOW + 20 * DAY);
    const v2 = seedVendor(db, t.id, { business_name: 'Later' }); seedVendorLocation(db, t.id, v2.id, loc.id, { status: 'approved' }); chase(db, t.id, v2.id, NOW + 75 * DAY);

    const r = runReport(db, t.id, ORG, 'renewal-forecast', {}, NOW).data as any;
    expect(r.buckets.d30).toBe(1);
    expect(r.buckets.d90).toBe(1);
    expect(r.rows[0].vendorName).toBe('Soon'); // soonest first
    expect(r.rows[0].daysOut).toBe(20);
    db.close();
  });
});

// ── #3 Vendor roster ─────────────────────────────────────────────────────────────────

describe('report: vendor-roster', () => {
  test('one row per vendor with Standard coverage facts', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id, { name: 'Main' });
    const v = seedVendor(db, t.id, { business_name: 'Acme', trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    seedExtraction(db, t.id, doc.id, coi(1_000_000));

    const r = runReport(db, t.id, ORG, 'vendor-roster', {}, NOW).data as any;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].vendorName).toBe('Acme');
    expect(r.rows[0].coverage.glEachOccurrence).toBe(1_000_000);
    expect(r.rows[0].coverage.additionalInsured).toBe(true);
    expect(r.rows[0].locations).toEqual(['Main']);
    db.close();
  });
});

// ── #4 Onboarding funnel ─────────────────────────────────────────────────────────────

describe('report: onboarding-funnel', () => {
  test('reached counts, conversion, median days-in-stage, N-of-M caveat', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    // v1 goes all the way; v2 stalls at onboarding
    const v1 = seedVendor(db, t.id); seedVendorLocation(db, t.id, v1.id, loc.id, { status: 'approved' });
    aevt(db, t.id, v1.id, 'vendor.invited', NOW - 30 * DAY);
    aevt(db, t.id, v1.id, 'vendor.onboarding_started', NOW - 28 * DAY);
    aevt(db, t.id, v1.id, 'vendor.submitted', NOW - 26 * DAY);
    aevt(db, t.id, v1.id, 'vendor.approved', NOW - 25 * DAY);
    const v2 = seedVendor(db, t.id); seedVendorLocation(db, t.id, v2.id, loc.id, { status: 'onboarding' });
    aevt(db, t.id, v2.id, 'vendor.invited', NOW - 5 * DAY);
    aevt(db, t.id, v2.id, 'vendor.onboarding_started', NOW - 4 * DAY);

    const r = runReport(db, t.id, ORG, 'onboarding-funnel', {}, NOW).data as any;
    expect(r.reached).toEqual({ invited: 2, onboarding: 2, underReview: 1, approved: 1 });
    expect(r.conversion.invited_to_onboarding).toBe(100);
    expect(r.conversion.onboarding_to_review).toBe(50);
    expect(r.medianDaysInStage.invited_to_onboarding).toBe(1.5); // (2d + 1d)/2
    expect(r.coverage).toEqual({ complete: 2, total: 2 });
    expect(r.note).toContain('2 of 2');
    db.close();
  });
});

// ── #5 Deficiency analysis ───────────────────────────────────────────────────────────

describe('report: deficiency-analysis', () => {
  test('ranks deficiency requirement_keys, slices by trade', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { trade: 'roofing' }); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });
    const run = seedRun(db, t.id, v.id, 'deficiencies');
    seedDef(db, t.id, run, v.id, loc.id, 'endorsement.waiver_of_subrogation');
    seedDef(db, t.id, run, v.id, loc.id, 'endorsement.waiver_of_subrogation');
    seedDef(db, t.id, run, v.id, loc.id, 'coverage.general_liability.each_occurrence');

    const r = runReport(db, t.id, ORG, 'deficiency-analysis', {}, NOW).data as any;
    expect(r.ranked[0].requirement_key).toBe('endorsement.waiver_of_subrogation');
    expect(r.ranked[0].deficient).toBe(2);
    expect(r.byTrade[0]).toEqual({ trade: 'roofing', deficient: 3 });
    db.close();
  });
});

// ── #6 Audit readiness ───────────────────────────────────────────────────────────────

describe('report: audit-readiness', () => {
  test('summary rolls up posture, open exceptions, renewal exposure', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const a = seedVendor(db, t.id); seedVendorLocation(db, t.id, a.id, loc.id, { status: 'approved' }); chase(db, t.id, a.id, NOW + 20 * DAY);
    const b = seedVendor(db, t.id); seedVendorLocation(db, t.id, b.id, loc.id, { status: 'expired' });

    const r = runReport(db, t.id, ORG, 'audit-readiness', {}, NOW).data as any;
    expect(r.posture.total).toBe(2);
    expect(r.openExceptions).toBe(1); // the expired one
    expect(r.renewalExposure90d).toBe(1);
    expect(r.linksToAuditExport).toBe(true);
    db.close();
  });
});

// ── Scope clamping ───────────────────────────────────────────────────────────────────

describe('reports — scope clamp', () => {
  test('District scope (L1 only) excludes a vendor at L2', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const l1 = seedLocation(db, t.id); const l2 = seedLocation(db, t.id);
    const vIn = seedVendor(db, t.id, { business_name: 'In' }); seedVendorLocation(db, t.id, vIn.id, l1.id, { status: 'approved' });
    const vOut = seedVendor(db, t.id, { business_name: 'Out' }); seedVendorLocation(db, t.id, vOut.id, l2.id, { status: 'approved' });

    const r = runReport(db, t.id, { locationIds: [l1.id] }, 'vendor-roster', {}, NOW).data as any;
    const names = r.rows.map((x: any) => x.vendorName);
    expect(names).toContain('In');
    expect(names).not.toContain('Out');
    db.close();
  });

  test('empty scope → empty report', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id); seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    const r = runReport(db, t.id, { locationIds: [] }, 'vendor-roster', {}, NOW).data as any;
    expect(r.rows).toHaveLength(0);
    db.close();
  });
});

// ── Route: Store=403, District scope, catalog ─────────────────────────────────────────

describe('reports API routes', () => {
  function rawWorld() {
    closeDb();
    const db = getRawDb();
    const dir = path.join(process.cwd(), 'src', 'migrations');
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const store = seedTenantUser(db, t.id, { role: 'store_manager' });
    const r1 = seedRegion(db, t.id, 'R1');
    const district = seedTenantUser(db, t.id, { role: 'district_manager' });
    assignUserToRegion(db, district.id, r1.id, t.id);
    const l1 = seedLocation(db, t.id, { regionId: r1.id });
    const l2 = seedLocation(db, t.id);
    assignUserToLocation(db, store.id, l1.id, t.id);
    const vIn = seedVendor(db, t.id, { business_name: 'R1 Vendor' }); seedVendorLocation(db, t.id, vIn.id, l1.id, { status: 'approved' });
    const vOut = seedVendor(db, t.id, { business_name: 'Other Vendor' }); seedVendorLocation(db, t.id, vOut.id, l2.id, { status: 'approved' });
    const tok = (u: { id: string }, role: string) => issueToken({ sub: u.id, tenantId: t.id, role, type: 'tenant' });
    return { db, adminJwt: tok(admin, 'admin'), storeJwt: tok(store, 'store_manager'), districtJwt: tok(district, 'district_manager') };
  }
  afterEach(() => closeDb());

  test('GET /api/reports — Admin gets the six; Store gets 403', async () => {
    const w = rawWorld();
    const { GET } = await import('@/app/api/reports/route');
    const adminRes = await GET(new Request('http://t/api/reports', { headers: { Authorization: `Bearer ${w.adminJwt}` } }));
    expect(adminRes.status).toBe(200);
    expect((await adminRes.json()).data.reports).toHaveLength(6);
    const storeRes = await GET(new Request('http://t/api/reports', { headers: { Authorization: `Bearer ${w.storeJwt}` } }));
    expect(storeRes.status).toBe(403);
  });

  test('GET /api/reports/vendor-roster — District sees only R1; Store 403', async () => {
    const w = rawWorld();
    const { GET } = await import('@/app/api/reports/[reportKey]/route');
    const dRes = await GET(new Request('http://t/api/reports/vendor-roster', { headers: { Authorization: `Bearer ${w.districtJwt}` } }), { params: { reportKey: 'vendor-roster' } });
    expect(dRes.status).toBe(200);
    const body = await dRes.text();
    expect(body).toContain('R1 Vendor');
    expect(body).not.toContain('Other Vendor');
    const sRes = await GET(new Request('http://t/api/reports/vendor-roster', { headers: { Authorization: `Bearer ${w.storeJwt}` } }), { params: { reportKey: 'vendor-roster' } });
    expect(sRes.status).toBe(403);
  });

  test('unknown report key → 404', async () => {
    const w = rawWorld();
    const { GET } = await import('@/app/api/reports/[reportKey]/route');
    const res = await GET(new Request('http://t/api/reports/nope', { headers: { Authorization: `Bearer ${w.adminJwt}` } }), { params: { reportKey: 'nope' } });
    expect(res.status).toBe(404);
  });
});
