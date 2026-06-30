// Phase 8, Slice F — consolidated behavioral matrix.
//
// This file adds the integration coverage not already proven in the per-slice suites:
//   A. One Command Center scenario exercising EVERY condition at once — full Tier-1 ordering,
//      Tier-2 ordering, Tier-3 counts, no leakage.
//   B. Sensitive-masking regression on the THREE new surfaces (/command-center, /dashboard,
//      /locations/:id) with a Manager JWT — non-vacuous (real encrypted TIN/ACH present).
//   C. Cross-tenant zero-row on all three surfaces via the real route handlers — non-vacuous.
//
// Per-condition tiering, scope clamps, Manager-Home correctness, Location-Record actions, the
// day-0 flip, imminent alerts, and rule-change→Tier-1 are covered in their own Slice A–E
// suites and run alongside this file in the full suite.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedVendor, seedLocation, seedVendorLocation,
  seedDocument, seedExtraction, seedRequirementSettings,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { encryptField, decryptField } from '@/lib/crypto/field';
import { queueNotification } from '@/lib/notifications/queue';
import { buildCommandCenter } from '@/lib/services/command-center';
import type { FieldValue, ProcessedW9Extraction, ProcessedACHExtraction } from '@/lib/extraction/types';

const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const DAY = 86_400_000;
const ALL = { locationIds: null as string[] | null };

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }

function seedRun(db: Database.Database, tenantId: string, vendorId: string, rec: string): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at) VALUES (?,?,?,'onboarding','1.0.0',?,?)`)
    .run(id, tenantId, vendorId, rec, new Date(NOW - DAY).toISOString());
  return id;
}
function seedDefEval(db: Database.Database, tenantId: string, runId: string, vendorId: string, locId: string, key: string): void {
  db.prepare(`INSERT INTO requirement_evaluations (id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value, extracted_value_ref, comparison_result, confidence_band, outcome, note) VALUES (?,?,?,?,?,?,'1000000','ref','fails','high','deficient',null)`)
    .run(randomUUID(), tenantId, runId, vendorId, locId, key);
}
function seedChase(db: Database.Database, tenantId: string, vendorId: string, expIso: string): void {
  queueNotification(db, tenantId, { recipientType: 'vendor', recipientRef: 'v@x.test', kind: 'exception', scheduledFor: expIso, payload: { type: 'renewal_reminder', vendor_id: vendorId, expiration_date: expIso, days_before: 30 } });
}

// ── A. Full Command Center tier composition + ordering ────────────────────────────────

describe('Command Center — full tier composition (all conditions, one scenario)', () => {
  test('every condition lands in its tier; Tier-1 + Tier-2 ordered; Tier-3 counted; no leakage', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const mk = (name: string, status: string) => { const v = seedVendor(db, t.id, { business_name: name, trade: 'plumbing' }); seedVendorLocation(db, t.id, v.id, loc.id, { status }); return v; };

    // Tier 1 (seed out of order to prove sorting)
    const ready = mk('Ready Co', 'under_review'); seedRun(db, t.id, ready.id, 'approve');
    const expired = mk('Expired Co', 'expired');
    const uncertain = mk('Uncertain Co', 'under_review'); seedRun(db, t.id, uncertain.id, 'uncertain');
    const nc = mk('NonCompliant Co', 'non_compliant'); seedDefEval(db, t.id, seedRun(db, t.id, nc.id, 'deficiencies'), nc.id, loc.id, 'coverage.general_liability.each_occurrence');
    const deficient = mk('Deficient Co', 'under_review'); seedDefEval(db, t.id, seedRun(db, t.id, deficient.id, 'deficiencies'), deficient.id, loc.id, 'endorsement.additional_insured');
    const imminent = mk('Imminent Co', 'approved'); seedChase(db, t.id, imminent.id, new Date(NOW + 5 * DAY).toISOString());

    // Tier 2
    const expiring = mk('Expiring Co', 'approved'); seedChase(db, t.id, expiring.id, new Date(NOW + 30 * DAY).toISOString());
    const correction = mk('Correction Co', 'onboarding');
    db.prepare(`INSERT INTO invites (id, tenant_id, vendor_id, inviter_user_id, token, token_expires_at, purpose, delivery_state, created_at) VALUES (?,?,?,?,?,?,'correction','sent',?)`)
      .run(randomUUID(), t.id, correction.id, admin.id, randomUUID(), new Date(NOW + 14 * DAY).toISOString(), new Date(NOW - 9 * DAY).toISOString());
    const bounced = mk('Bounced Co', 'invited_pending');
    db.prepare(`INSERT INTO invites (id, tenant_id, vendor_id, inviter_user_id, token, token_expires_at, purpose, delivery_state, created_at) VALUES (?,?,?,?,?,?,'onboarding','bounced',?)`)
      .run(randomUUID(), t.id, bounced.id, admin.id, randomUUID(), new Date(NOW + 14 * DAY).toISOString(), new Date(NOW - DAY).toISOString());

    // Tier 3
    mk('Onboarding Co', 'onboarding');
    mk('Pending Co', 'invited_pending');
    mk('OnTrack Co', 'approved'); // approved, no chase

    const cc = buildCommandCenter(db, t.id, ALL, NOW);

    expect(cc.tier1.map((r) => r.condition)).toEqual([
      'expired', 'non_compliant', 'imminent_lapse', 'review_deficiencies', 'review_uncertain', 'review_ready',
    ]);
    expect(cc.tier2.map((r) => r.condition)).toEqual(['expiring_soon', 'correction_aging', 'invite_failed']);
    expect(cc.tier3).toEqual({ onboarding: 1, pending: 1, onTrack: 1 });

    // spot-check specific phrases
    expect(cc.tier1.find((r) => r.condition === 'non_compliant')!.phrase).toContain('General Liability');
    expect(cc.tier1.find((r) => r.condition === 'imminent_lapse')!.daysToExpiry).toBe(5);
    expect(cc.tier2.find((r) => r.condition === 'expiring_soon')!.daysToExpiry).toBe(30);

    // no leakage: each at-risk vendor appears exactly once across tier1+tier2
    const ids = [...cc.tier1, ...cc.tier2].map((r) => r.vendorId);
    expect(new Set(ids).size).toBe(ids.length);
    db.close();
  });
});

// ── B. Sensitive-masking regression on the three new surfaces ─────────────────────────

const TIN = '123-45-6789';
const ROUTING = '021000021';
const ACCOUNT = '9876543210';
const SSN_SHAPED = /\b\d{3}-\d{2}-\d{4}\b/;

function fv<T>(value: T): FieldValue<T> { return { value, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false }; }
function w9(cipher: string): ProcessedW9Extraction {
  return { doc_type: 'w9', document_type_confirmed: 'w9', legal_name: fv<string | null>('Acme LLC'), business_name: fv<string | null>('Acme'), federal_tax_classification: fv<string | null>('llc'), tin_type: fv<string | null>('ein'), tin_value: fv<string | null>(cipher), address: fv<string | null>('1 Main'), signature_present: fv<boolean | null>(true), signature_date: fv<string | null>('2026-01-01') };
}
function ach(routingC: string, acctC: string): ProcessedACHExtraction {
  return { doc_type: 'ach', document_type_confirmed: 'ach', account_holder_name: fv<string | null>('Acme LLC'), bank_name: fv<string | null>('Bank'), routing_number: fv<string | null>(routingC), account_number: fv<string | null>(acctC), account_type: fv<string | null>('checking'), voided_check_present: fv<boolean | null>(true), authorization_signature: fv<boolean | null>(true) };
}

describe('Sensitive masking — Manager on the new surfaces never sees raw TIN/ACH', () => {
  afterEach(() => closeDb());

  test('non-vacuous: data is present (encrypted) and absent from every surface body', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const manager = seedTenantUser(db, t.id, { role: 'store_manager' });
    const loc = seedLocation(db, t.id, { name: 'Store One' });
    // store manager scoped to the location (so they can load /command-center, /dashboard, /locations/:id)
    db.prepare('INSERT INTO user_locations (user_id, location_id, tenant_id) VALUES (?,?,?)').run(manager.id, loc.id, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing', trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    seedRequirementSettings(db, t.id);

    const tinC = encryptField(TIN), rtgC = encryptField(ROUTING), actC = encryptField(ACCOUNT);
    const w9Doc = seedDocument(db, t.id, v.id, { doc_type: 'w9' }); seedExtraction(db, t.id, w9Doc.id, w9(tinC));
    const achDoc = seedDocument(db, t.id, v.id, { doc_type: 'ach' }); seedExtraction(db, t.id, achDoc.id, ach(rtgC, actC));

    // non-vacuous: the plaintext is genuinely recoverable from the store
    expect(decryptField(tinC)).toBe(TIN);
    expect(decryptField(rtgC)).toBe(ROUTING);
    expect(decryptField(actC)).toBe(ACCOUNT);

    const jwt = issueToken({ sub: manager.id, tenantId: t.id, role: 'store_manager', type: 'tenant' });
    const assertClean = (body: string) => {
      expect(body).not.toContain(TIN);
      expect(body).not.toContain(ROUTING);
      expect(body).not.toContain(ACCOUNT);
      expect(body).not.toMatch(SSN_SHAPED);
    };

    const cc = await import('@/app/api/command-center/route');
    assertClean(await (await cc.GET(new Request('http://t/api/command-center', bearer(jwt)))).text());

    const dash = await import('@/app/api/dashboard/route');
    assertClean(await (await dash.GET(new Request('http://t/api/dashboard', bearer(jwt)))).text());

    const locRoute = await import('@/app/api/locations/[locationId]/route');
    const locRes = await locRoute.GET(new Request(`http://t/api/locations/${loc.id}`, bearer(jwt)), { params: { locationId: loc.id } });
    expect(locRes.status).toBe(200); // manager is in scope
    assertClean(await locRes.text());
  });
});

// ── C. Cross-tenant zero-row on all three surfaces (route-level, non-vacuous) ──────────

describe('Cross-tenant isolation on the read surfaces', () => {
  afterEach(() => closeDb());

  test("tenant B's surfaces never expose tenant A's data", async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const tA = seedTenant(db); const tB = seedTenant(db);
    const adminA = seedTenantUser(db, tA.id, { role: 'admin' });
    const adminB = seedTenantUser(db, tB.id, { role: 'admin' });
    const locA = seedLocation(db, tA.id, { name: 'A-Store' });
    const vA = seedVendor(db, tA.id, { business_name: 'Tenant A Vendor', trade: 'plumbing' });
    seedVendorLocation(db, tA.id, vA.id, locA.id, { status: 'expired' });

    const jwtA = issueToken({ sub: adminA.id, tenantId: tA.id, role: 'admin', type: 'tenant' });
    const jwtB = issueToken({ sub: adminB.id, tenantId: tB.id, role: 'admin', type: 'tenant' });

    const cc = await import('@/app/api/command-center/route');
    const dash = await import('@/app/api/dashboard/route');
    const locRoute = await import('@/app/api/locations/[locationId]/route');

    // non-vacuous: tenant A genuinely has the vendor
    expect(await (await cc.GET(new Request('http://t/api/command-center', bearer(jwtA)))).text()).toContain('Tenant A Vendor');

    // tenant B sees nothing of A's
    expect(await (await cc.GET(new Request('http://t/api/command-center', bearer(jwtB)))).text()).not.toContain('Tenant A Vendor');
    expect(await (await dash.GET(new Request('http://t/api/dashboard', bearer(jwtB)))).text()).not.toContain('Tenant A Vendor');
    // B requesting A's location id → 404 (tenant-isolated lookup)
    const locRes = await locRoute.GET(new Request(`http://t/api/locations/${locA.id}`, bearer(jwtB)), { params: { locationId: locA.id } });
    expect(locRes.status).toBe(404);
  });
});
