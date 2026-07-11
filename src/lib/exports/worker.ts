// Audit-export worker — the third in-process worker (alongside notification + retention).
// Picks up async exports (region/org/tenant_offboard), generates them, and notifies the
// requester. Same safety model as the notification worker: CLAIM-THEN-GENERATE — already
// claim-guarded (a per-row guarded UPDATE, not leader-election), so it is NOT subject to
// OPS-6's single-instance constraint the way digest/retention are (docs/launch-prep.md; see
// ADR-013-01's Stage 8b entry for the full claim-safety reasoning, same shape here).
//
// 1. Reclaim: rows stuck in 'generating' past the stale window (a crashed worker) → 'queued'.
// 2. Claim: atomic UPDATE 'queued' → 'generating' (claimed_at=now); only one claim wins.
// 3. Generate → store → 'ready' (+storage_key), then queue a "your export is ready"
//    notification to the requesting Admin. On failure → 'failed'.
//
// Idempotency: a 'ready' row is never re-polled. The one double-generate window (crash after
// the blob write but before the 'ready' commit) reclaims and regenerates to the SAME storage
// key, overwriting — so no orphan/duplicate is served. Cross-tenant by design (infrastructure).

import type { Db } from '@/lib/db/client';
import { logAudit } from '@/lib/audit';
import { captureSecurityAlert } from '@/lib/observability';
import { queueNotification } from '@/lib/notifications/queue';
import { generateExportArtifact } from './audit-export';
import { env } from '@/lib/env';

export interface ExportWorkerTickResult {
  reclaimed: number;
  generated: number;
  failed: number;
}

interface QueuedRow { id: string; tenant_id: string; requested_by: string; scope_type: string }

export async function processQueuedExports(
  db: Db,
  now: Date = new Date(),
  opts: { staleSeconds?: number } = {}
): Promise<ExportWorkerTickResult> {
  const staleSeconds = opts.staleSeconds ?? env.notifications.sendingStaleSeconds;
  const staleCutoff = new Date(now.getTime() - staleSeconds * 1000);

  const reclaimRes = await db
    .updateTable('audit_exports')
    .set({ status: 'queued', claimed_at: null })
    .where('status', '=', 'generating')
    .where('claimed_at', 'is not', null)
    .where('claimed_at', '<=', staleCutoff)
    .executeTakeFirst();
  const reclaimed = Number(reclaimRes.numUpdatedRows);

  const due = (await db
    .selectFrom('audit_exports')
    .select(['id', 'tenant_id', 'requested_by', 'scope_type'])
    .where('status', '=', 'queued')
    .orderBy('created_at', 'asc')
    .execute()) as QueuedRow[];

  let generated = 0, failed = 0;
  for (const row of due) {
    const claimRes = await db
      .updateTable('audit_exports')
      .set({ status: 'generating', claimed_at: now })
      .where('id', '=', row.id)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    if (Number(claimRes.numUpdatedRows) === 0) continue; // someone else claimed it

    try {
      const storageKey = await generateExportArtifact(db, row.tenant_id, row.id);
      // Notify the requester (rides the notification rails; the worker sends it next tick).
      await queueNotification(db, row.tenant_id, {
        recipientType: 'user',
        recipientRef: row.requested_by,
        kind: 'exception',
        payload: { type: 'audit_export_ready', export_id: row.id, scope: row.scope_type, storage_key: storageKey },
      });
      await logAudit(db, {
        tenantId: row.tenant_id, actorType: 'system', actorId: 'export-worker',
        eventType: 'export.completed', targetType: 'audit_export', targetId: row.id,
        payload: { scope: row.scope_type },
      });
      generated++;
    } catch (err) {
      await db.updateTable('audit_exports').set({ status: 'failed', claimed_at: null }).where('id', '=', row.id).execute();
      await logAudit(db, {
        tenantId: row.tenant_id, actorType: 'system', actorId: 'export-worker',
        eventType: 'export.failed', targetType: 'audit_export', targetId: row.id,
        payload: { scope: row.scope_type, error: (err as Error).message },
      });
      // OPS-3: surface worker failures to ops alerting. IDs + scope; error message scrubbed.
      captureSecurityAlert('export.failed', {
        tenant_id: row.tenant_id, export_id: row.id, scope: row.scope_type, error: (err as Error).message,
      });
      failed++;
    }
  }

  return { reclaimed, generated, failed };
}

export interface ExportWorkerHandle { stop: () => void }

export function startAuditExportWorker(db: Db, intervalSeconds: number = env.notifications.workerPollSeconds): ExportWorkerHandle {
  const timer = setInterval(() => {
    void processQueuedExports(db).catch((e) => console.error('[export-worker] tick failed:', e));
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
