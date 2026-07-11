// Retention worker — marks records past the 7-year retention horizon as purge-eligible.
// Separate from the notification worker (different cadence: daily; different concern).
//
// v1 MARKS ONLY. Actual hard deletion (purge) is a deliberate, separately-logged step —
// this worker never deletes (Document_Storage_and_Security.md, invariant #11). Each marked
// row gets a retention.purge_eligible audit event (system actor, no Sensitive payload).
//
// Cross-tenant infrastructure process (like the notification worker / migration runner):
// it scans all tenants' rows and logs each mark under that row's own tenant_id. No TenantDB
// (there is no single tenant to scope by) — raw db.selectFrom/updateTable, same shape as
// billing/quantity-sync.ts's cross-tenant scan.

import type { Db } from '@/lib/db/client';
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
 * Idempotent: the `purge_eligible = false` guard prevents double-marking and duplicate audit rows.
 */
export async function runRetentionSweep(
  db: Db,
  now: Date = new Date(),
  years: number = RETENTION_YEARS
): Promise<RetentionSweepResult> {
  const horizon = new Date(retentionHorizon(now, years));

  const documentsMarked = await markDocuments(db, horizon, now);
  const auditEventsMarked = await markAuditEvents(db, horizon, now);

  return { documentsMarked, auditEventsMarked };
}

async function markDocuments(db: Db, horizon: Date, now: Date): Promise<number> {
  const rows = await db
    .selectFrom('documents')
    .select(['id', 'tenant_id'])
    .where('purge_eligible', '=', false)
    .where('superseded_at', 'is not', null)
    .where('superseded_at', '<=', horizon)
    .execute();

  let count = 0;
  for (const row of rows as { id: string; tenant_id: string }[]) {
    const res = await db
      .updateTable('documents')
      .set({ purge_eligible: true, purge_eligible_at: now })
      .where('id', '=', row.id)
      .where('purge_eligible', '=', false)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) continue; // already marked by a concurrent pass

    await logAudit(db, {
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

async function markAuditEvents(db: Db, horizon: Date, now: Date): Promise<number> {
  // Snapshot the ids first: marking logs NEW audit events (created now), which must never be
  // swept in the same pass — selecting up-front by created_at ≤ horizon excludes them anyway,
  // but snapshotting also avoids iterating a growing set.
  const rows = await db
    .selectFrom('audit_events')
    .select(['id', 'tenant_id'])
    .where('purge_eligible', '=', false)
    .where('created_at', '<=', horizon)
    .execute();

  let count = 0;
  for (const row of rows as { id: string; tenant_id: string }[]) {
    const res = await db
      .updateTable('audit_events')
      .set({ purge_eligible: true, purge_eligible_at: now })
      .where('id', '=', row.id)
      .where('purge_eligible', '=', false)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) continue;

    await logAudit(db, {
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
  db: Db,
  intervalSeconds: number = 24 * 60 * 60
): RetentionWorkerHandle {
  const timer = setInterval(() => {
    void runRetentionSweep(db).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[retention-worker] sweep failed:', err);
    });
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
