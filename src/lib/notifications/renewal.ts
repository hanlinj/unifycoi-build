// Renewal & expiration chase — eager scheduling (Renewal_and_Expiration_Chase.md).
//
// When a COI is extracted with an expiration date, we IMMEDIATELY queue the five ladder
// reminders (60/30/14/7/1 days before expiry) as vendor-facing notifications with
// scheduled_for populated and a payload complete enough to render without re-reading state.
// The worker sends each when due. Reminders are tied to the COI's document_id so a renewal
// upload can supersede the unfired ones.
//
// Phase 8 (Slice E) adds, on the same eager schedule:
//   - a 6th job at the expiration date itself (type 'coi_expiration') — the worker flips the
//     vendor's locations to 'expired' when it fires (no email; an internal action).
//   - internal imminent-lapse alerts to Admins at the 7d and 1d rungs (type
//     'imminent_lapse_admin'), alongside the vendor reminder.
// All chase artifacts share the COI's document_id, so a renewal supersedes every one of them.

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { queueNotification, notifyTenantAdmins } from './queue';
import { logAudit } from '@/lib/audit';
import type { ProcessedCOIExtraction } from '@/lib/extraction/types';

export const LADDER_DAYS = [60, 30, 14, 7, 1] as const;
const IMMINENT_RUNGS = new Set([7, 1]); // rungs that also alert Admins internally
const DAY_MS = 24 * 60 * 60 * 1000;

/** Earliest valid (parseable, future-or-any) expiration date across a COI's policies. */
export function earliestExpiration(coi: ProcessedCOIExtraction): string | null {
  let earliest: number | null = null;
  let earliestStr: string | null = null;
  for (const p of coi.policies ?? []) {
    const raw = p.expiration_date?.value;
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) {
      earliest = t;
      earliestStr = raw;
    }
  }
  return earliestStr;
}

export interface ScheduleResult {
  scheduled: number;            // vendor renewal_reminder rows queued (the 5-rung ladder)
  skippedPast: number;
  alreadyScheduled: boolean;
  reminderDates: string[];
  expirationJobScheduled: boolean; // the day-0 coi_expiration job
  adminAlerts: number;             // imminent-lapse admin alert rows queued (7d/1d × admins)
}

/**
 * Eager-schedule the 5 ladder reminders for a COI. Idempotent per document_id: if reminders
 * already exist for this document, does nothing. Past ladder rungs (reminder date already
 * elapsed at upload time) are skipped — e.g. a COI uploaded 10 days before expiry only gets
 * the 7- and 1-day reminders.
 */
export function scheduleRenewalReminders(
  db: Database.Database,
  input: {
    tenantId: string;
    vendorId: string;
    documentId: string;
    expirationDate: string;   // ISO or parseable
  },
  now: Date = new Date()
): ScheduleResult {
  const { tenantId, vendorId, documentId, expirationDate } = input;
  const tdb = new TenantDB(db, tenantId);

  // Idempotency guard — never double-schedule for the same COI.
  const existing = tdb.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE tenant_id = ? AND document_id = ?
       AND json_extract(payload_json, '$.type') = 'renewal_reminder'`,
    [documentId]
  );
  if (existing && existing.n > 0) {
    return { scheduled: 0, skippedPast: 0, alreadyScheduled: true, reminderDates: [], expirationJobScheduled: false, adminAlerts: 0 };
  }

  const expMs = Date.parse(expirationDate);
  if (Number.isNaN(expMs)) {
    return { scheduled: 0, skippedPast: 0, alreadyScheduled: false, reminderDates: [], expirationJobScheduled: false, adminAlerts: 0 };
  }

  // Resolve vendor name + email for a payload-complete reminder.
  const vendor = tdb.get<{ business_name: string; contact_email: string | null }>(
    'SELECT business_name, contact_email FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  const vendorEmail = vendor?.contact_email ?? null;
  const vendorName = vendor?.business_name ?? null;

  // The vendor's locations + the tenant's admins (for the imminent-lapse internal alerts).
  const locationIds = tdb
    .all<{ location_id: string }>('SELECT location_id FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ?', [vendorId])
    .map((r) => r.location_id);
  const adminIds = tdb
    .all<{ id: string }>(`SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' AND status != 'disabled'`)
    .map((r) => r.id);

  let scheduled = 0;
  let skippedPast = 0;
  let adminAlerts = 0;
  const reminderDates: string[] = [];

  for (const days of LADDER_DAYS) {
    const reminderMs = expMs - days * DAY_MS;
    if (reminderMs <= now.getTime()) {
      skippedPast++;
      continue;
    }
    const reminderIso = new Date(reminderMs).toISOString();
    reminderDates.push(reminderIso);

    if (vendorEmail) {
      queueNotification(db, tenantId, {
        recipientType: 'vendor',
        recipientRef: vendorEmail,
        kind: 'exception',          // vendor-facing, immediate-tier — never batched into a digest
        scheduledFor: reminderIso,
        documentId,
        payload: {
          type: 'renewal_reminder',
          days_before: days,
          vendor_id: vendorId,
          vendor_name: vendorName,
          document_id: documentId,
          expiration_date: expirationDate,
        },
      });
      scheduled++;
    } else {
      // No deliverable address — skip the vendor send; the day-0 flip below still happens.
      skippedPast++;
    }

    // Imminent-lapse internal alert to Admins at the 7d and 1d rungs (in addition to the
    // vendor reminder). One row per admin, scheduled for the rung date, superseded on renewal.
    if (IMMINENT_RUNGS.has(days)) {
      for (const adminId of adminIds) {
        queueNotification(db, tenantId, {
          recipientType: 'user',
          recipientRef: adminId,
          kind: 'exception',
          scheduledFor: reminderIso,
          documentId,
          payload: {
            type: 'imminent_lapse_admin',
            days_before: days,
            vendor_id: vendorId,
            vendor_name: vendorName,
            location_ids: locationIds,
            expiration_date: expirationDate,
          },
        });
        adminAlerts++;
      }
    }
  }

  // 6th job — the day-0 expiration flip. Queued regardless of vendor email (a status change,
  // not an email). The worker special-cases type='coi_expiration' to flip status to expired.
  let expirationJobScheduled = false;
  if (expMs > now.getTime()) {
    queueNotification(db, tenantId, {
      recipientType: 'user',
      recipientRef: 'system', // internal action; the worker never emails this row
      kind: 'exception',
      scheduledFor: new Date(expMs).toISOString(),
      documentId,
      payload: {
        type: 'coi_expiration',
        vendor_id: vendorId,
        vendor_name: vendorName,
        document_id: documentId,
        expiration_date: expirationDate,
      },
    });
    expirationJobScheduled = true;
  }

  return { scheduled, skippedPast, alreadyScheduled: false, reminderDates, expirationJobScheduled, adminAlerts };
}

/**
 * Mark all UNFIRED (status='queued') chase artifacts for a document as 'superseded' — the
 * vendor reminders, the day-0 expiration job, and the imminent-lapse admin alerts. A renewal
 * cancels the entire chase for the old COI. Fired rows (status='sent') are left as the
 * historical record (Audit_Trail.md). Returns the number superseded.
 *
 * document_id is only ever set on these chase artifacts, so no type filter is needed.
 */
export function supersedeReminders(db: Database.Database, tenantId: string, documentId: string): number {
  const res = db
    .prepare(
      `UPDATE notifications SET status = 'superseded'
       WHERE tenant_id = ? AND document_id = ? AND status = 'queued'`
    )
    .run(tenantId, documentId);
  return res.changes;
}

export interface CoiUploadResult {
  supersededDocumentId: string | null;
  supersededReminders: number;
  schedule: ScheduleResult;
}

/**
 * Handle a COI upload's chase bookkeeping:
 *  1. If a prior active COI exists, mark it superseded by the new one and cancel its
 *     unfired reminders (the renewal upload is the supersession trigger).
 *  2. Eager-schedule the new COI's ladder.
 * No-op-safe: onboarding's first COI has no prior, so step 1 is skipped.
 */
export function handleCoiUploadChase(
  db: Database.Database,
  input: { tenantId: string; vendorId: string; newDocumentId: string; expirationDate: string },
  now: Date = new Date()
): CoiUploadResult {
  const { tenantId, vendorId, newDocumentId, expirationDate } = input;
  const tdb = new TenantDB(db, tenantId);

  // Prior active, non-superseded COI for this vendor (excluding the just-inserted doc).
  const prior = tdb.get<{ id: string }>(
    `SELECT id FROM documents
     WHERE tenant_id = ? AND vendor_id = ? AND doc_type = 'coi'
       AND id != ? AND superseded_by IS NULL AND state = 'active'
     ORDER BY uploaded_at DESC LIMIT 1`,
    [vendorId, newDocumentId]
  );

  let supersededDocumentId: string | null = null;
  let supersededReminders = 0;

  if (prior) {
    // superseded_at is the retention anchor for the old COI (Slice D): the 7-year clock
    // starts when a renewal makes it inactive.
    tdb.update(
      'documents',
      { superseded_by: newDocumentId, superseded_at: now.toISOString() },
      { id: prior.id }
    );
    supersededReminders = supersedeReminders(db, tenantId, prior.id);
    supersededDocumentId = prior.id;
  }

  const schedule = scheduleRenewalReminders(
    db,
    { tenantId, vendorId, documentId: newDocumentId, expirationDate },
    now
  );

  return { supersededDocumentId, supersededReminders, schedule };
}

// ── Day-0 expiration flip (Slice E) ───────────────────────────────────────────────

export interface ExpirationFlipResult {
  flippedLocationIds: string[];
}

/**
 * Apply the day-0 expiration: flip the vendor's currently-satisfied locations (status
 * 'approved' or 'under_review') to 'expired', write a vendor.expired audit event, and queue
 * an exception notification to Admins. Called by the notification worker when a 'coi_expiration'
 * job fires. Idempotent: if no satisfied locations remain (already expired / renewed), no-op.
 *
 * Defensive: if the COI was renewed (superseded), the chase — including this job — was
 * superseded, so this should not run; we double-check and skip if so.
 */
export function applyExpirationFlip(
  db: Database.Database,
  input: { tenantId: string; vendorId: string; documentId: string | null },
  now: Date = new Date()
): ExpirationFlipResult {
  const { tenantId, vendorId, documentId } = input;
  const tdb = new TenantDB(db, tenantId);

  if (documentId) {
    const doc = tdb.get<{ superseded_by: string | null }>(
      'SELECT superseded_by FROM documents WHERE tenant_id = ? AND id = ?',
      [documentId]
    );
    if (doc?.superseded_by) return { flippedLocationIds: [] }; // renewed — nothing to expire
  }

  const locs = tdb.all<{ location_id: string }>(
    `SELECT location_id FROM vendor_locations
     WHERE tenant_id = ? AND vendor_id = ? AND status IN ('approved', 'under_review')`,
    [vendorId]
  );
  if (locs.length === 0) return { flippedLocationIds: [] };

  const flipped: string[] = [];
  for (const l of locs) {
    tdb.update('vendor_locations', { status: 'expired' }, { vendor_id: vendorId, location_id: l.location_id });
    flipped.push(l.location_id);
  }

  logAudit(db, {
    tenantId,
    actorType: 'system',
    actorId: 'expiration-worker',
    eventType: 'vendor.expired',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { document_id: documentId, location_ids: flipped, expired_at: now.toISOString() },
  });

  // Exception (immediate) alert to Admins — coverage lapsed, vendor pulled from hireable.
  notifyTenantAdmins(db, tenantId, {
    type: 'vendor_expired',
    vendor_id: vendorId,
    location_ids: flipped,
  });

  return { flippedLocationIds: flipped };
}
