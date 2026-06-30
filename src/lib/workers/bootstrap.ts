// Worker bootstrap — composes the three in-process background loops so the server boot
// path (instrumentation.ts) and the smoke test start the exact same wiring.
//
//   • notification worker — sends due/exception notifications (poll: NOTIFICATION_WORKER_POLL_SECONDS)
//   • digest worker       — hourly tz-aware daily-digest cycle (DIGEST_HOUR_LOCAL per tenant)
//   • retention worker    — daily 7-year purge-eligibility sweep
//
// All three timers are unref'd, so they never keep the process alive on their own.

import type Database from 'better-sqlite3';
import type { Mailer } from '@/lib/notifications/mailer';
import { startNotificationWorker } from '@/lib/notifications/worker';
import { startDigestWorker } from '@/lib/notifications/digest';
import { startRetentionWorker } from '@/lib/retention/worker';
import { startAuditExportWorker } from '@/lib/exports/worker';

export interface WorkerHandles {
  notification: { stop: () => void };
  digest: { stop: () => void };
  retention: { stop: () => void };
  auditExport: { stop: () => void };
}

/** Start all background workers. Returns handles so callers (and tests) can stop them. */
export function startAllWorkers(mailer: Mailer, db: Database.Database): WorkerHandles {
  return {
    notification: startNotificationWorker(mailer, db),
    digest: startDigestWorker(mailer, db),
    retention: startRetentionWorker(db),
    auditExport: startAuditExportWorker(db),
  };
}

/** Stop all workers (symmetry helper; mainly for tests/graceful shutdown). */
export function stopAllWorkers(handles: WorkerHandles): void {
  handles.notification.stop();
  handles.digest.stop();
  handles.retention.stop();
  handles.auditExport.stop();
}
