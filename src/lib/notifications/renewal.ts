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

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { queueNotification, notifyTenantAdmins } from './queue';
import { logAudit } from '@/lib/audit';
import { expiryBoundaryMs } from '@/lib/time/zone';
import { toIsoDateStr } from '@/lib/extraction/extractor';
import type { ProcessedCOIExtraction } from '@/lib/extraction/types';

export const LADDER_DAYS = [60, 30, 14, 7, 1] as const;
const IMMINENT_RUNGS = new Set([7, 1]); // rungs that also alert Admins internally
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Earliest valid (parseable, future-or-any) expiration date across a COI's policies. This is the
 * SINGLE point where a raw Vision-extracted date string becomes the `expiration_date` written
 * into every renewal-chase notification payload (scheduleRenewalReminders' three payload
 * literals, and manual-reminder.ts's re-write of whatever chase.ts reads back) — so it's also
 * the single durable place to normalize. Vision's tool schema puts no format constraint on this
 * field, so a genuinely non-zero-padded value ("2026-9-5") is a real possibility, not a
 * synthetic edge case. Left un-normalized, downstream date-ordering code (chase.ts's
 * chronological comparisons) has no reliable way to distinguish "September 5" from an ambiguous
 * partial string, and — more subtly — an unpadded, non-ISO string's meaning under `Date.parse()`
 * (V8's legacy non-standard parser, which resolves in the *process's local* timezone) can
 * disagree with the same string's meaning under Postgres's `::timestamptz` cast (which resolves
 * in the *Postgres server's* timezone) whenever those two run under different zone configs —
 * two different, silently-diverging interpretations of one string. Normalizing here means every
 * value that reaches storage is either zero-padded ISO (unambiguous under both) or left as
 * whatever the un-normalizable original was (unchanged fallback behavior, same as today).
 */
export function earliestExpiration(coi: ProcessedCOIExtraction): string | null {
  let earliest: number | null = null;
  let earliestStr: string | null = null;
  for (const p of coi.policies ?? []) {
    const raw = p.expiration_date?.value;
    if (!raw) continue;
    const normalized = toIsoDateStr(raw) ?? raw;
    const t = Date.parse(normalized);
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) {
      earliest = t;
      earliestStr = normalized;
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
export async function scheduleRenewalReminders(
  db: Db,
  input: {
    tenantId: string;
    vendorId: string;
    documentId: string;
    expirationDate: string;   // ISO or parseable
  },
  now: Date = new Date()
): Promise<ScheduleResult> {
  const { tenantId, vendorId, documentId, expirationDate } = input;
  const tdb = new TenantDB(db, tenantId);

  // Idempotency guard — never double-schedule for the same COI.
  // json_extract() -> ->> (Stage 0's catalogued JSON1 rework spot; see ADR-013-01 invariant 8).
  const existing = await tdb.get<{ n: string }>(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE tenant_id = $1 AND document_id = $2
       AND payload_json->>'type' = 'renewal_reminder'`,
    [documentId]
  );
  if (existing && Number(existing.n) > 0) {
    return { scheduled: 0, skippedPast: 0, alreadyScheduled: true, reminderDates: [], expirationJobScheduled: false, adminAlerts: 0 };
  }

  // OPS-7: resolve the expiry boundary in the TENANT's timezone (start-of-day local for a
  // date-only expiry), not UTC. Null tz → UTC (no-op vs the old Date.parse behavior).
  const tenantRow = await db.selectFrom('tenants').select('timezone').where('id', '=', tenantId).executeTakeFirst();
  const tz = tenantRow?.timezone ?? null;
  const expMs = expiryBoundaryMs(expirationDate, tz);
  if (Number.isNaN(expMs)) {
    return { scheduled: 0, skippedPast: 0, alreadyScheduled: false, reminderDates: [], expirationJobScheduled: false, adminAlerts: 0 };
  }

  // Resolve vendor name + email for a payload-complete reminder.
  const vendor = await tdb.get<{ business_name: string; contact_email: string | null }>(
    'SELECT business_name, contact_email FROM vendors WHERE tenant_id = $1 AND id = $2',
    [vendorId]
  );
  const vendorEmail = vendor?.contact_email ?? null;
  const vendorName = vendor?.business_name ?? null;

  // The vendor's locations + the tenant's admins (for the imminent-lapse internal alerts).
  const locationIds = (await tdb
    .all<{ location_id: string }>('SELECT location_id FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2', [vendorId]))
    .map((r) => r.location_id);
  const adminIds = (await tdb
    .all<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND status != 'disabled'`))
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
      await queueNotification(db, tenantId, {
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
        await queueNotification(db, tenantId, {
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
    await queueNotification(db, tenantId, {
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
export async function supersedeReminders(db: Db, tenantId: string, documentId: string): Promise<number> {
  const res = await db
    .updateTable('notifications')
    .set({ status: 'superseded' })
    .where('tenant_id', '=', tenantId)
    .where('document_id', '=', documentId)
    .where('status', '=', 'queued')
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
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
export async function handleCoiUploadChase(
  db: Db,
  input: { tenantId: string; vendorId: string; newDocumentId: string; expirationDate: string },
  now: Date = new Date()
): Promise<CoiUploadResult> {
  const { tenantId, vendorId, newDocumentId, expirationDate } = input;
  const tdb = new TenantDB(db, tenantId);

  // Prior active, non-superseded COI for this vendor — STRICTLY OLDER than the new doc. The
  // uploaded_at guard prevents a concurrency cycle: COI upload does an async Vision extraction
  // between the document insert and this supersession, so two overlapping COI uploads can both
  // be present here. Without the guard each would supersede the other (A↔B), leaving NO active
  // COI and bricking submit. Only superseding strictly-older COIs makes the newest always win.
  const prior = await tdb.get<{ id: string }>(
    `SELECT id FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND doc_type = 'coi'
       AND id != $3 AND superseded_by IS NULL AND state = 'active'
       AND uploaded_at < (SELECT uploaded_at FROM documents WHERE id = $4)
     ORDER BY uploaded_at DESC LIMIT 1`,
    [vendorId, newDocumentId, newDocumentId]
  );

  let supersededDocumentId: string | null = null;
  let supersededReminders = 0;

  if (prior) {
    // superseded_at is the retention anchor for the old COI (Slice D): the 7-year clock
    // starts when a renewal makes it inactive.
    await tdb.update(
      'documents',
      { superseded_by: newDocumentId, superseded_at: now },
      { id: prior.id }
    );
    supersededReminders = await supersedeReminders(db, tenantId, prior.id);
    supersededDocumentId = prior.id;
  }

  const schedule = await scheduleRenewalReminders(
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
export async function applyExpirationFlip(
  db: Db,
  input: { tenantId: string; vendorId: string; documentId: string | null },
  now: Date = new Date()
): Promise<ExpirationFlipResult> {
  const { tenantId, vendorId, documentId } = input;
  const tdb = new TenantDB(db, tenantId);

  if (documentId) {
    const doc = await tdb.get<{ superseded_by: string | null }>(
      'SELECT superseded_by FROM documents WHERE tenant_id = $1 AND id = $2',
      [documentId]
    );
    if (doc?.superseded_by) return { flippedLocationIds: [] }; // renewed — nothing to expire
  }

  const locs = await tdb.all<{ location_id: string }>(
    `SELECT location_id FROM vendor_locations
     WHERE tenant_id = $1 AND vendor_id = $2 AND status IN ('approved', 'under_review')`,
    [vendorId]
  );
  if (locs.length === 0) return { flippedLocationIds: [] };

  const flipped: string[] = [];
  for (const l of locs) {
    await tdb.update('vendor_locations', { status: 'expired' }, { vendor_id: vendorId, location_id: l.location_id });
    flipped.push(l.location_id);
  }

  await logAudit(db, {
    tenantId,
    actorType: 'system',
    actorId: 'expiration-worker',
    eventType: 'vendor.expired',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { document_id: documentId, location_ids: flipped, expired_at: now.toISOString() },
  });

  // Exception (immediate) alert to Admins — coverage lapsed, vendor pulled from hireable.
  await notifyTenantAdmins(db, tenantId, {
    type: 'vendor_expired',
    vendor_id: vendorId,
    location_ids: flipped,
  });

  return { flippedLocationIds: flipped };
}
