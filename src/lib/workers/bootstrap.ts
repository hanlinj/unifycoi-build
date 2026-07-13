// Worker bootstrap — composes the in-process background loops so the server boot
// path (instrumentation.ts) and the smoke test start the exact same wiring.
//
//   • notification worker  — sends due/exception notifications (poll: NOTIFICATION_WORKER_POLL_SECONDS)
//   • digest worker        — hourly tz-aware daily-digest cycle (DIGEST_HOUR_LOCAL per tenant)
//   • retention worker     — daily 7-year purge-eligibility sweep
//   • billing sync worker  — pushes location-count changes to Stripe subscription quantities
//                            (poll: BILLING_SYNC_WORKER_POLL_SECONDS; Slice 5a, ADR-012-05)
//   • verification worker  — extracts uploaded documents + runs runVerification() in the
//                            background after vendor submit (poll: NOTIFICATION_WORKER_POLL_SECONDS,
//                            shared with the notification/audit-export workers' default)
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
import { startVerificationWorker } from '@/lib/verification/worker';
import { env } from '@/lib/env';

export interface WorkerHandles {
  notification: { stop: () => void };
  digest: { stop: () => void };
  retention: { stop: () => void };
  auditExport: { stop: () => void };
  billingSync: { stop: () => void };
  verification: { stop: () => void };
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
  const handles = {
    notification: startNotificationWorker(mailer, db),
    digest: startDigestWorker(mailer, db),
    retention: startRetentionWorker(db),
    auditExport: startAuditExportWorker(db),
    billingSync: startBillingSyncWorker(db, billing),
    verification: startVerificationWorker(db),
  };

  // Positive boot confirmation (not just silence-on-success): mirrors each start*Worker's own
  // default interval, since bootstrap doesn't override any of them. Digest (hourly) and
  // retention (daily) defaults live in their own files (digest.ts / retention/worker.ts) —
  // keep this in sync if those change.
  const notificationIntervalSeconds = env.notifications.workerPollSeconds;
  const digestIntervalSeconds = 60 * 60;
  const retentionIntervalSeconds = 24 * 60 * 60;
  const auditExportIntervalSeconds = env.notifications.workerPollSeconds;
  const billingSyncIntervalSeconds = env.billing.syncWorkerPollSeconds;
  const verificationIntervalSeconds = env.notifications.workerPollSeconds;
  console.log(
    `[workers] started: notification (interval ${notificationIntervalSeconds * 1000}ms), ` +
      `digest (interval ${digestIntervalSeconds * 1000}ms), ` +
      `retention (interval ${retentionIntervalSeconds * 1000}ms), ` +
      `auditExport (interval ${auditExportIntervalSeconds * 1000}ms), ` +
      `billingSync (interval ${billingSyncIntervalSeconds * 1000}ms), ` +
      `verification (interval ${verificationIntervalSeconds * 1000}ms)`
  );

  return handles;
}

/** Stop all workers (symmetry helper; mainly for tests/graceful shutdown). */
export function stopAllWorkers(handles: WorkerHandles): void {
  handles.notification.stop();
  handles.digest.stop();
  handles.retention.stop();
  handles.auditExport.stop();
  handles.billingSync.stop();
  handles.verification.stop();
}
