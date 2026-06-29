// Retention worker — marks records past the 7-year retention horizon as purge-eligible.
// Separate from the notification worker (different cadence: daily; different concern).
//
// v1 MARKS ONLY. Actual hard deletion (purge) is a deliberate, separately-logged step —
// this worker never deletes (Document_Storage_and_Security.md, invariant #11). Each marked
// row gets a retention.purge_eligible audit event (system actor, no Sensitive payload).
//
// Cross-tenant infrastructure process (like the notification worker / migration runner):
// it scans all tenants' rows and logs each mark under that row's own tenant_id.

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';

export const RETENTION_YEARS = 7;

/** ISO timestamp `years` before `now` — the cutoff: anchors at/before this are past retention. */
export function retentionHorizon(now: Date, years: number = RETENTION_YEARS): string {
  const h = new Date(now.getTime());
  h.setUTCFullYear(h.getUTCFullYear() - years);
  return h.toISOString();
}

export interface RetentionSweepResult {
  documentsMarked: number;
  auditEventsMarked: number;
}

/**
 * One retention sweep. Deterministic with injected `now`.
 *  - Documents: inactive (superseded_at set) AND superseded_at ≤ horizon AND not already marked.
 *  - Audit events: created_at ≤ horizon AND not already marked.
 * Idempotent: the `purge_eligible = 0` guard prevents double-marking and duplicate audit rows.
 */
export function runRetentionSweep(
  db: Database.Database,
  now: Date = new Date(),
  years: number = RETENTION_YEARS
): RetentionSweepResult {
  const horizon = retentionHorizon(now, years);
  const nowIso = now.toISOString();

  const documentsMarked = markDocuments(db, horizon, nowIso);
  const auditEventsMarked = markAuditEvents(db, horizon, nowIso);

  return { documentsMarked, auditEventsMarked };
}

function markDocuments(db: Database.Database, horizon: string, nowIso: string): number {
  const rows = db
    .prepare(
      `SELECT id, tenant_id FROM documents
       WHERE purge_eligible = 0 AND superseded_at IS NOT NULL AND superseded_at <= ?`
    )
    .all(horizon) as { id: string; tenant_id: string }[];

  const mark = db.prepare(
    `UPDATE documents SET purge_eligible = 1, purge_eligible_at = ? WHERE id = ? AND purge_eligible = 0`
  );

  let count = 0;
  for (const row of rows) {
    const changed = mark.run(nowIso, row.id).changes;
    if (changed === 0) continue; // already marked by a concurrent pass
    logAudit(db, {
      tenantId: row.tenant_id,
      actorType: 'system',
      actorId: 'retention-worker',
      eventType: 'retention.purge_eligible',
      targetType: 'document',
      targetId: row.id,
      payload: { retention_years: RETENTION_YEARS },
    });
    count++;
  }
  return count;
}

function markAuditEvents(db: Database.Database, horizon: string, nowIso: string): number {
  // Snapshot the ids first: marking logs NEW audit events (created now), which must never be
  // swept in the same pass — selecting up-front by created_at ≤ horizon excludes them anyway,
  // but snapshotting also avoids iterating a growing set.
  const rows = db
    .prepare(
      `SELECT id, tenant_id FROM audit_events
       WHERE purge_eligible = 0 AND created_at <= ?`
    )
    .all(horizon) as { id: string; tenant_id: string }[];

  const mark = db.prepare(
    `UPDATE audit_events SET purge_eligible = 1, purge_eligible_at = ? WHERE id = ? AND purge_eligible = 0`
  );

  let count = 0;
  for (const row of rows) {
    const changed = mark.run(nowIso, row.id).changes;
    if (changed === 0) continue;
    logAudit(db, {
      tenantId: row.tenant_id,
      actorType: 'system',
      actorId: 'retention-worker',
      eventType: 'retention.purge_eligible',
      targetType: 'audit_event',
      targetId: row.id,
      payload: { retention_years: RETENTION_YEARS },
    });
    count++;
  }
  return count;
}

// ── Daily loop wrapper ───────────────────────────────────────────────────────────

export interface RetentionWorkerHandle {
  stop: () => void;
}

/** Start the daily retention worker. Logic lives in runRetentionSweep (tested with a frozen clock). */
export function startRetentionWorker(
  db: Database.Database,
  intervalSeconds: number = 24 * 60 * 60
): RetentionWorkerHandle {
  const timer = setInterval(() => {
    try {
      runRetentionSweep(db);
    } catch (err) {
      console.error('[retention-worker] sweep failed:', err);
    }
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
