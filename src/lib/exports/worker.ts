// Audit-export worker — the third in-process worker (alongside notification + retention).
// Picks up async exports (region/org/tenant_offboard), generates them, and notifies the
// requester. Same safety model as the notification worker: CLAIM-THEN-GENERATE.
//
// 1. Reclaim: rows stuck in 'generating' past the stale window (a crashed worker) → 'queued'.
// 2. Claim: atomic UPDATE 'queued' → 'generating' (claimed_at=now); only one claim wins.
// 3. Generate → store → 'ready' (+storage_key), then queue a "your export is ready"
//    notification to the requesting Admin. On failure → 'failed'.
//
// Idempotency: a 'ready' row is never re-polled. The one double-generate window (crash after
// the blob write but before the 'ready' commit) reclaims and regenerates to the SAME storage
// key, overwriting — so no orphan/duplicate is served. Cross-tenant by design (infrastructure).

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';
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
  db: Database.Database,
  now: Date = new Date(),
  opts: { staleSeconds?: number } = {}
): Promise<ExportWorkerTickResult> {
  const staleSeconds = opts.staleSeconds ?? env.notifications.sendingStaleSeconds;
  const nowIso = now.toISOString();
  const staleCutoff = new Date(now.getTime() - staleSeconds * 1000).toISOString();

  const reclaimed = db
    .prepare(`UPDATE audit_exports SET status = 'queued', claimed_at = NULL WHERE status = 'generating' AND claimed_at IS NOT NULL AND claimed_at <= ?`)
    .run(staleCutoff).changes;

  const due = db.prepare(`SELECT id, tenant_id, requested_by, scope_type FROM audit_exports WHERE status = 'queued' ORDER BY created_at ASC`).all() as QueuedRow[];
  const claim = db.prepare(`UPDATE audit_exports SET status = 'generating', claimed_at = ? WHERE id = ? AND status = 'queued'`);

  let generated = 0, failed = 0;
  for (const row of due) {
    if (claim.run(nowIso, row.id).changes === 0) continue; // someone else claimed it

    try {
      const storageKey = await generateExportArtifact(db, row.tenant_id, row.id);
      // Notify the requester (rides the notification rails; the worker sends it next tick).
      queueNotification(db, row.tenant_id, {
        recipientType: 'user',
        recipientRef: row.requested_by,
        kind: 'exception',
        payload: { type: 'audit_export_ready', export_id: row.id, scope: row.scope_type, storage_key: storageKey },
      });
      logAudit(db, {
        tenantId: row.tenant_id, actorType: 'system', actorId: 'export-worker',
        eventType: 'export.completed', targetType: 'audit_export', targetId: row.id,
        payload: { scope: row.scope_type },
      });
      generated++;
    } catch (err) {
      db.prepare(`UPDATE audit_exports SET status = 'failed', claimed_at = NULL WHERE id = ?`).run(row.id);
      logAudit(db, {
        tenantId: row.tenant_id, actorType: 'system', actorId: 'export-worker',
        eventType: 'export.failed', targetType: 'audit_export', targetId: row.id,
        payload: { scope: row.scope_type, error: (err as Error).message },
      });
      failed++;
    }
  }

  return { reclaimed, generated, failed };
}

export interface ExportWorkerHandle { stop: () => void }

export function startAuditExportWorker(db: Database.Database, intervalSeconds: number = env.notifications.workerPollSeconds): ExportWorkerHandle {
  const timer = setInterval(() => {
    void processQueuedExports(db).catch((e) => console.error('[export-worker] tick failed:', e));
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
