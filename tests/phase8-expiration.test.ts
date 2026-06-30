// Phase 8, Slice E — day-0 Expired flip + imminent-lapse internal alerts.
//
// Clock-frozen. Proves: the 6th (coi_expiration) job is eager-scheduled; the worker fires it
// at the expiration date and flips status→expired + audit + Admin notification; imminent-lapse
// admin alerts land at the 7d and 1d rungs; rule-change non-compliance shows in Command Center
// Tier 1.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedVendor, seedLocation, seedVendorLocation,
  seedDocument, seedRequirementSettings, seedRequirementRule,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { NoOpMailer } from '@/lib/notifications/mailer';
import { scheduleRenewalReminders, applyExpirationFlip } from '@/lib/notifications/renewal';
import { processDueNotifications } from '@/lib/notifications/worker';
import { buildCommandCenter } from '@/lib/services/command-center';
import { triggerRuleChangeReeval } from '@/lib/requirements/re-eval';

const NOW = new Date('2026-06-30T12:00:00.000Z');
const DAY = 86_400_000;
const ALL = { locationIds: null as string[] | null };

function approvedVendorWithChase(db: Database.Database, tenantId: string, locId: string, expIso: string, opts: { email?: string | null } = {}) {
  const noEmail = opts.email === null;
  const v = noEmail
    ? seedVendor(db, tenantId, { business_name: 'Acme' }) // contact_email defaults to null
    : seedVendor(db, tenantId, { business_name: 'Acme', contact_email: opts.email ?? 'a@x.test' });
  seedVendorLocation(db, tenantId, v.id, locId, { status: 'approved' });
  const doc = seedDocument(db, tenantId, v.id, { doc_type: 'coi' }); // real FK target for notifications.document_id
  scheduleRenewalReminders(db, { tenantId, vendorId: v.id, documentId: doc.id, expirationDate: expIso }, NOW);
  return { vendorId: v.id, docId: doc.id };
}

// ── Eager day-0 job ──────────────────────────────────────────────────────────────────

describe('day-0 expiration job — scheduling', () => {
  test('a coi_expiration job is queued at the expiration date itself', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const exp = new Date(NOW.getTime() + 100 * DAY).toISOString();
    const { docId } = approvedVendorWithChase(db, t.id, loc.id, exp);

    const tdb = new TenantDB(db, t.id);
    const job = tdb.get<{ scheduled_for: string; document_id: string }>(
      `SELECT scheduled_for, document_id FROM notifications
       WHERE tenant_id=? AND json_extract(payload_json,'$.type')='coi_expiration'`
    );
    expect(job).toBeDefined();
    expect(job!.scheduled_for).toBe(exp);
    expect(job!.document_id).toBe(docId);
    db.close();
  });
});

// ── Imminent-lapse admin alerts at 7d and 1d ──────────────────────────────────────────

describe('imminent-lapse internal alerts', () => {
  test('admin alerts are queued at the 7d and 1d rungs (one per admin), in addition to vendor reminders', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const a1 = seedTenantUser(db, t.id, { role: 'admin' });
    const a2 = seedTenantUser(db, t.id, { role: 'admin' });
    seedTenantUser(db, t.id, { role: 'store_manager' }); // must NOT receive
    const loc = seedLocation(db, t.id);
    const exp = new Date(NOW.getTime() + 100 * DAY).toISOString();
    approvedVendorWithChase(db, t.id, loc.id, exp);

    const tdb = new TenantDB(db, t.id);
    const alerts = tdb.all<{ recipient_ref: string; scheduled_for: string; payload_json: string }>(
      `SELECT recipient_ref, scheduled_for, payload_json FROM notifications
       WHERE tenant_id=? AND json_extract(payload_json,'$.type')='imminent_lapse_admin' ORDER BY scheduled_for`
    );
    // 2 rungs (7d, 1d) × 2 admins = 4
    expect(alerts).toHaveLength(4);
    const recipients = new Set(alerts.map((a) => a.recipient_ref));
    expect(recipients).toEqual(new Set([a1.id, a2.id]));
    const rungs = new Set(alerts.map((a) => JSON.parse(a.payload_json).days_before));
    expect(rungs).toEqual(new Set([7, 1]));
    // scheduled at the correct dates
    const dates = new Set(alerts.map((a) => a.scheduled_for));
    expect(dates).toContain(new Date(NOW.getTime() + 93 * DAY).toISOString()); // 7d before
    expect(dates).toContain(new Date(NOW.getTime() + 99 * DAY).toISOString()); // 1d before
    db.close();
  });
});

// ── Worker fires the day-0 flip ───────────────────────────────────────────────────────

describe('day-0 flip — worker', () => {
  test('at the expiration date the worker flips approved→expired, audits, and alerts Admins', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const exp = new Date(NOW.getTime() + 30 * DAY).toISOString();
    const { vendorId } = approvedVendorWithChase(db, t.id, loc.id, exp);

    const mailer = new NoOpMailer();
    // Before expiry: nothing flips.
    await processDueNotifications(mailer, db, new Date(NOW.getTime() + 10 * DAY));
    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ status: string }>(`SELECT status FROM vendor_locations WHERE tenant_id=? AND vendor_id=?`, [vendorId])!.status).toBe('approved');

    // At/after expiry: the day-0 job fires.
    await processDueNotifications(mailer, db, new Date(Date.parse(exp) + 60_000));

    expect(tdb.get<{ status: string }>(`SELECT status FROM vendor_locations WHERE tenant_id=? AND vendor_id=?`, [vendorId])!.status).toBe('expired');
    const audit = tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='vendor.expired' AND target_id=?`, [vendorId]);
    expect(audit).toBeDefined();
    const adminNotif = tdb.get(
      `SELECT id FROM notifications WHERE tenant_id=? AND json_extract(payload_json,'$.type')='vendor_expired' AND json_extract(payload_json,'$.vendor_id')=?`, [vendorId]
    );
    expect(adminNotif).toBeDefined();
    db.close();
  });

  test('the day-0 job fires even when the vendor has no email (status change, not an email)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const exp = new Date(NOW.getTime() + 30 * DAY).toISOString();
    const { vendorId } = approvedVendorWithChase(db, t.id, loc.id, exp, { email: null });

    await processDueNotifications(new NoOpMailer(), db, new Date(Date.parse(exp) + 60_000));
    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ status: string }>(`SELECT status FROM vendor_locations WHERE tenant_id=? AND vendor_id=?`, [vendorId])!.status).toBe('expired');
    db.close();
  });

  test('applyExpirationFlip is idempotent and skips a renewed (superseded) COI', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { contact_email: 'a@x.test' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });

    // First flip → expired.
    const r1 = applyExpirationFlip(db, { tenantId: t.id, vendorId: v.id, documentId: null }, NOW);
    expect(r1.flippedLocationIds).toHaveLength(1);
    // Second flip → no-op (already expired).
    const r2 = applyExpirationFlip(db, { tenantId: t.id, vendorId: v.id, documentId: null }, NOW);
    expect(r2.flippedLocationIds).toHaveLength(0);
    db.close();
  });
});

// ── Rule-change non-compliance → Command Center Tier 1 ────────────────────────────────

describe('rule-change non-compliance surfaces in Command Center Tier 1', () => {
  test('triggerRuleChangeReeval flips a vendor to non_compliant and it appears in Tier 1', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    seedRequirementSettings(db, t.id);
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Drift Co', trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    // Tighten a rule the vendor (no stored extractions) cannot satisfy → non_compliant.
    seedRequirementRule(db, t.id, admin.id, { requirement_key: 'coverage.general_liability.each_occurrence', required_value: '5000000' });

    await triggerRuleChangeReeval(db, t.id, 'coverage.general_liability.each_occurrence');

    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ status: string }>(`SELECT status FROM vendor_locations WHERE tenant_id=? AND vendor_id=?`, [v.id])!.status).toBe('non_compliant');

    const cc = buildCommandCenter(db, t.id, ALL, NOW.getTime());
    const t1 = cc.tier1.find((r) => r.vendorId === v.id);
    expect(t1).toBeDefined();
    expect(t1!.condition).toBe('non_compliant');
    db.close();
  });
});
