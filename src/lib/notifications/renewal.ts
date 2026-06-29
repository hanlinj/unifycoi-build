// Renewal & expiration chase — eager scheduling (Renewal_and_Expiration_Chase.md).
//
// When a COI is extracted with an expiration date, we IMMEDIATELY queue the five ladder
// reminders (60/30/14/7/1 days before expiry) as vendor-facing notifications with
// scheduled_for populated and a payload complete enough to render without re-reading state.
// The worker sends each when due. Reminders are tied to the COI's document_id so a renewal
// upload can supersede the unfired ones.
//
// Phase 7 scope (per kickoff): the 5 vendor reminders + supersession. The day-0 Expired
// status flip and lapse/imminent-lapse internal alerts are deferred to Phase 8 (where the
// risk-queue dashboards that surface them are built).

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { queueNotification } from './queue';
import type { ProcessedCOIExtraction } from '@/lib/extraction/types';

export const LADDER_DAYS = [60, 30, 14, 7, 1] as const;
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
  scheduled: number;
  skippedPast: number;
  alreadyScheduled: boolean;
  reminderDates: string[];
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
    return { scheduled: 0, skippedPast: 0, alreadyScheduled: true, reminderDates: [] };
  }

  const expMs = Date.parse(expirationDate);
  if (Number.isNaN(expMs)) {
    return { scheduled: 0, skippedPast: 0, alreadyScheduled: false, reminderDates: [] };
  }

  // Resolve vendor name + email for a payload-complete reminder.
  const vendor = tdb.get<{ business_name: string; contact_email: string | null }>(
    'SELECT business_name, contact_email FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  const vendorEmail = vendor?.contact_email ?? null;
  const vendorName = vendor?.business_name ?? null;

  let scheduled = 0;
  let skippedPast = 0;
  const reminderDates: string[] = [];

  for (const days of LADDER_DAYS) {
    const reminderMs = expMs - days * DAY_MS;
    if (reminderMs <= now.getTime()) {
      skippedPast++;
      continue;
    }
    const reminderIso = new Date(reminderMs).toISOString();
    reminderDates.push(reminderIso);

    if (!vendorEmail) {
      // No deliverable address — skip the send but record nothing stuck.
      // (Invite-time bounce handling already surfaces a missing email to the inviter.)
      skippedPast++;
      continue;
    }

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
  }

  return { scheduled, skippedPast, alreadyScheduled: false, reminderDates };
}

/**
 * Mark all UNFIRED (status='queued') renewal reminders for a document as 'superseded'.
 * Fired reminders (status='sent') are left as the historical record (Audit_Trail.md). Returns
 * the number superseded.
 */
export function supersedeReminders(db: Database.Database, tenantId: string, documentId: string): number {
  const res = db
    .prepare(
      `UPDATE notifications SET status = 'superseded'
       WHERE tenant_id = ? AND document_id = ? AND status = 'queued'
         AND json_extract(payload_json, '$.type') = 'renewal_reminder'`
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
    tdb.update('documents', { superseded_by: newDocumentId }, { id: prior.id });
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
