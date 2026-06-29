// Phase 8, Slice A — Command Center taxonomy + resend invite.
//
// Behavioral tests against the real DB. Proves tier composition (each condition lands in the
// right tier, most-severe wins), specific deficiency phrases, chase-derived expiry tiers,
// scope clamping (basic; full District tests in Slice C), and the resend-invite service.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedVendor, seedLocation, seedVendorLocation, seedInvite,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { buildCommandCenter } from '@/lib/services/command-center';
import { queueNotification } from '@/lib/notifications/queue';
import { resendInvite, ResendInviteError } from '@/lib/services/resend-invite';

function migrateRaw(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
  }
}

const NOW = Date.parse('2026-06-29T12:00:00.000Z');
const DAY = 86_400_000;
const ALL = { locationIds: null as string[] | null };

// ── helpers ──────────────────────────────────────────────────────────────────────

function seedRun(db: Database.Database, tenantId: string, vendorId: string, recommendation: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at)
     VALUES (?, ?, ?, 'onboarding', '1.0.0', ?, ?)`
  ).run(id, tenantId, vendorId, recommendation, new Date(NOW - DAY).toISOString());
  return id;
}
function seedDeficientEval(db: Database.Database, tenantId: string, runId: string, vendorId: string, locationId: string, key: string): void {
  db.prepare(
    `INSERT INTO requirement_evaluations
       (id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value, extracted_value_ref, comparison_result, confidence_band, outcome, note)
     VALUES (?, ?, ?, ?, ?, ?, '1000000', 'ref', 'fails', 'high', 'deficient', null)`
  ).run(randomUUID(), tenantId, runId, vendorId, locationId, key);
}
function seedChase(db: Database.Database, tenantId: string, vendorId: string, expirationIso: string): void {
  // document_id omitted — the chase-expiry query reads only the payload; a real documents FK
  // isn't needed to exercise the taxonomy.
  queueNotification(db, tenantId, {
    recipientType: 'vendor', recipientRef: 'v@x.test', kind: 'exception',
    scheduledFor: expirationIso,
    payload: { type: 'renewal_reminder', vendor_id: vendorId, expiration_date: expirationIso, days_before: 30 },
  });
}

// ── Tier composition ───────────────────────────────────────────────────────────────

describe('Command Center — tier composition', () => {
  function base() {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    return { db, t, loc };
  }

  test('expired → Tier 1 (expired)', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'expired' });
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1.map((r) => r.condition)).toEqual(['expired']);
    expect(cc.tier1[0].vendorId).toBe(v.id);
    db.close();
  });

  test('non_compliant → Tier 1 with specific failed requirement in the phrase', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'non_compliant' });
    const run = seedRun(db, t.id, v.id, 'deficiencies');
    seedDeficientEval(db, t.id, run, v.id, loc.id, 'coverage.general_liability.each_occurrence');
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1[0].condition).toBe('non_compliant');
    expect(cc.tier1[0].phrase).toContain('General Liability'); // humanized, not the category
    db.close();
  });

  test('under_review + deficiencies → Tier 1; multi-failure phrase shows the count', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });
    const run = seedRun(db, t.id, v.id, 'deficiencies');
    seedDeficientEval(db, t.id, run, v.id, loc.id, 'coverage.general_liability.each_occurrence');
    seedDeficientEval(db, t.id, run, v.id, loc.id, 'endorsement.additional_insured');
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1[0].condition).toBe('review_deficiencies');
    expect(cc.tier1[0].phrase).toBe('Deficient: 2 failed requirements');
    db.close();
  });

  test('under_review + uncertain → Tier 1 (uncertain)', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });
    seedRun(db, t.id, v.id, 'uncertain');
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1[0].condition).toBe('review_uncertain');
    expect(cc.tier1[0].phrase).toBe('Uncertain — needs your call');
    db.close();
  });

  test('under_review + approve → Tier 1 (ready to approve) [change #1]', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });
    seedRun(db, t.id, v.id, 'approve');
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1[0].condition).toBe('review_ready');
    expect(cc.tier2).toHaveLength(0); // NOT in tier 2 anymore
    db.close();
  });

  test('approved + COI expiring in 5d → Tier 1 imminent lapse', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    seedChase(db, t.id, v.id, new Date(NOW + 5 * DAY).toISOString());
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1[0].condition).toBe('imminent_lapse');
    expect(cc.tier1[0].daysToExpiry).toBe(5);
    db.close();
  });

  test('approved + COI expiring in 30d → Tier 2 expiring soon', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    seedChase(db, t.id, v.id, new Date(NOW + 30 * DAY).toISOString());
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1).toHaveLength(0);
    expect(cc.tier2[0].condition).toBe('expiring_soon');
    expect(cc.tier2[0].daysToExpiry).toBe(30);
    db.close();
  });

  test('bounced invite → Tier 2 with resend action', () => {
    const { db, t, loc } = base();
    const inviter = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'invited_pending' });
    seedInvite(db, t.id, { vendorId: v.id, inviterUserId: inviter.id, deliveryState: 'bounced' });
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier2[0].condition).toBe('invite_failed');
    expect(cc.tier2[0].action).toBe('resend_invite');
    db.close();
  });

  test('onboarding / pending / approved-on-track land in Tier 3 counts (not as rows)', () => {
    const { db, t, loc } = base();
    const vOn = seedVendor(db, t.id); seedVendorLocation(db, t.id, vOn.id, loc.id, { status: 'onboarding' });
    const vPend = seedVendor(db, t.id); seedVendorLocation(db, t.id, vPend.id, loc.id, { status: 'invited_pending' });
    const vAppr = seedVendor(db, t.id); seedVendorLocation(db, t.id, vAppr.id, loc.id, { status: 'approved' }); // no chase → on track
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1).toHaveLength(0);
    expect(cc.tier2).toHaveLength(0);
    expect(cc.tier3).toEqual({ onboarding: 1, pending: 1, onTrack: 1 });
    db.close();
  });

  test('declined-only vendor is not surfaced anywhere', () => {
    const { db, t, loc } = base();
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'declined' });
    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1).toHaveLength(0);
    expect(cc.tier2).toHaveLength(0);
    expect(cc.tier3).toEqual({ onboarding: 0, pending: 0, onTrack: 0 });
    db.close();
  });
});

// ── Most-severe-wins (no leakage) ───────────────────────────────────────────────

describe('Command Center — most-severe condition wins', () => {
  test('vendor expired at one location + under_review at another → one Tier 1 row (expired)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const l1 = seedLocation(db, t.id);
    const l2 = seedLocation(db, t.id);
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, l1.id, { status: 'expired' });
    seedVendorLocation(db, t.id, v.id, l2.id, { status: 'under_review' });
    seedRun(db, t.id, v.id, 'deficiencies');

    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1).toHaveLength(1);
    expect(cc.tier1[0].condition).toBe('expired');
    expect(cc.tier1[0].locationsAffected).toBe(2);
    db.close();
  });

  test('Tier 1 is severity-ordered: expired before non_compliant before ready', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const mk = (status: string, rec?: string) => {
      const v = seedVendor(db, t.id);
      seedVendorLocation(db, t.id, v.id, loc.id, { status });
      if (rec) seedRun(db, t.id, v.id, rec);
      return v.id;
    };
    mk('under_review', 'approve');   // ready
    const expiredV = mk('expired');
    const ncV = mk('non_compliant');

    const cc = buildCommandCenter(db, t.id, ALL, NOW);
    expect(cc.tier1.map((r) => r.condition)).toEqual(['expired', 'non_compliant', 'review_ready']);
    expect(cc.tier1[0].vendorId).toBe(expiredV);
    expect(cc.tier1[1].vendorId).toBe(ncV);
    db.close();
  });
});

// ── Scope clamp (basic; full District/Store coverage in Slice C) ──────────────────

describe('Command Center — scope clamp basics', () => {
  test('locationIds=[] (district with no regions) → empty', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'expired' });
    const cc = buildCommandCenter(db, t.id, { locationIds: [] }, NOW);
    expect(cc.tier1).toHaveLength(0);
    expect(cc.facilitiesInScope).toBe(0);
    db.close();
  });

  test('scoped to L1 only → vendor at L2 does not appear', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const l1 = seedLocation(db, t.id);
    const l2 = seedLocation(db, t.id);
    const vIn = seedVendor(db, t.id); seedVendorLocation(db, t.id, vIn.id, l1.id, { status: 'expired' });
    const vOut = seedVendor(db, t.id); seedVendorLocation(db, t.id, vOut.id, l2.id, { status: 'expired' });

    const cc = buildCommandCenter(db, t.id, { locationIds: [l1.id] }, NOW);
    expect(cc.tier1).toHaveLength(1);
    expect(cc.tier1[0].vendorId).toBe(vIn.id);
    db.close();
  });
});

// ── resend invite ───────────────────────────────────────────────────────────────

describe('resendInvite', () => {
  test('creates a fresh onboarding invite + vendor notification + audit', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id, { contact_email: 'vendor@x.test' });

    const res = resendInvite(db, t.id, v.id, admin.id);
    expect(res.inviteId).toBeTruthy();

    const tdb = new TenantDB(db, t.id);
    const inv = tdb.get<{ purpose: string; delivery_state: string }>(`SELECT purpose, delivery_state FROM invites WHERE tenant_id=? AND id=?`, [res.inviteId]);
    expect(inv).toEqual({ purpose: 'onboarding', delivery_state: 'sent' });

    const notif = tdb.get<{ payload_json: string }>(`SELECT payload_json FROM notifications WHERE tenant_id=? AND recipient_type='vendor' ORDER BY created_at DESC LIMIT 1`);
    const payload = JSON.parse(notif!.payload_json);
    expect(payload.type).toBe('vendor_invite');
    expect(payload.resent).toBe(true);

    const audit = tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='vendor.invite_resent'`);
    expect(audit).toBeDefined();
    db.close();
  });

  test('vendor with no contact email → NO_EMAIL error, no invite created', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id); // no email

    expect(() => resendInvite(db, t.id, v.id, admin.id)).toThrow(expect.objectContaining({ code: 'NO_EMAIL' }));
    const tdb = new TenantDB(db, t.id);
    expect(tdb.all(`SELECT id FROM invites WHERE tenant_id=? AND vendor_id=?`, [v.id])).toHaveLength(0);
    db.close();
  });

  test('unknown vendor → NOT_FOUND', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    expect(() => resendInvite(db, t.id, randomUUID(), admin.id)).toThrow(ResendInviteError);
    db.close();
  });
});

// ── cross-tenant ─────────────────────────────────────────────────────────────────

describe('Command Center — cross-tenant isolation', () => {
  test('tenant B Command Center never shows tenant A vendors (non-vacuous)', () => {
    const db = setupTestDb();
    const tA = seedTenant(db);
    const tB = seedTenant(db);
    const locA = seedLocation(db, tA.id);
    const vA = seedVendor(db, tA.id); seedVendorLocation(db, tA.id, vA.id, locA.id, { status: 'expired' });
    // tenant A clearly HAS an at-risk vendor
    expect(buildCommandCenter(db, tA.id, ALL, NOW).tier1).toHaveLength(1);
    // tenant B sees nothing
    const ccB = buildCommandCenter(db, tB.id, ALL, NOW);
    expect(ccB.tier1).toHaveLength(0);
    expect(ccB.tier2).toHaveLength(0);
    db.close();
  });
});

// ── Page/API wiring smoke (route handler, real getRawDb + Admin JWT) ──────────────
// Proves the data path the /command-center page renders from: auth → resolveScope →
// buildCommandCenter → JSON. Catches "page renders empty due to a key mismatch" by
// asserting a seeded vendor's name appears in the response body. (No render harness.)

describe('GET /api/command-center wiring smoke', () => {
  afterEach(() => closeDb());

  test('authenticated Admin gets a body containing a seeded at-risk vendor name', async () => {
    closeDb();
    const db = getRawDb();
    migrateRaw(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing Smoke-Test LLC' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'expired' });

    const jwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });
    const { GET } = await import('@/app/api/command-center/route');
    const res = await GET(new Request('http://t/api/command-center', { headers: { Authorization: `Bearer ${jwt}` } }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Acme Plumbing Smoke-Test LLC');
    expect(body).toContain('"condition":"expired"');
  });
});
