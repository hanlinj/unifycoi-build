// Worker bootstrap — composes the in-process background loops so the server boot
// path (instrumentation.ts) and the smoke test start the exact same wiring.
//
//   • notification worker  — sends due/exception notifications (poll: NOTIFICATION_WORKER_POLL_SECONDS)
//   • digest worker        — hourly tz-aware daily-digest cycle (DIGEST_HOUR_LOCAL per tenant)
//   • retention worker     — daily 7-year purge-eligibility sweep
//   • billing sync worker  — pushes location-count changes to Stripe subscription quantities
//                            (poll: BILLING_SYNC_WORKER_POLL_SECONDS; Slice 5a, ADR-012-05)
//
// All timers are unref'd, so they never keep the process alive on their own.

import type { Db } from '@/lib/db/client';
import type { Mailer } from '@/lib/notifications/mailer';
import type { BillingProvider } from '@/lib/billing/provider';
import { startNotificationWorker } from '@/lib/notifications/worker';
import { startDigestWorker } from '@/lib/notifications/digest';
import { startRetentionWorker } from '@/lib/retention/worker';
import { startAuditExportWorker } from '@/lib/exports/worker';
import { startBillingSyncWorker } from '@/lib/billing/worker';

export interface WorkerHandles {
  notification: { stop: () => void };
  digest: { stop: () => void };
  retention: { stop: () => void };
  auditExport: { stop: () => void };
  billingSync: { stop: () => void };
}

/**
 * Start all background workers. Returns handles so callers (and tests) can stop them.
 *
 * Phase 13 Stage 8a: `db` is now correctly typed as Kysely `Db` (see ADR-013-01 Stage 8a —
 * this was previously mistyped as `Database.Database`, a latent bug since Stage 4). Stages
 * 8a/8b/8c converted retention/billing-sync, notification/digest, and audit-export
 * respectively — all five workers now wire cleanly with no downstream type errors, for the
 * first time since this file's bug was introduced.
 */
export function startAllWorkers(mailer: Mailer, db: Db, billing: BillingProvider): WorkerHandles {
  return {
    notification: startNotificationWorker(mailer, db),
    digest: startDigestWorker(mailer, db),
    retention: startRetentionWorker(db),
    auditExport: startAuditExportWorker(db),
    billingSync: startBillingSyncWorker(db, billing),
  };
}

/** Stop all workers (symmetry helper; mainly for tests/graceful shutdown). */
export function stopAllWorkers(handles: WorkerHandles): void {
  handles.notification.stop();
  handles.digest.stop();
  handles.retention.stop();
  handles.auditExport.stop();
  handles.billingSync.stop();
}
