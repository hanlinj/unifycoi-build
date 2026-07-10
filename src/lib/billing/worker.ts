// Billing quantity-sync worker loop (Slice 5a). Same shape as the notification/digest/
// retention/audit-export workers (src/lib/notifications/worker.ts et al.): a plain setInterval,
// unref'd so it never keeps the process alive on its own, wrapping a pure/testable function
// (syncBillingQuantities) that tests call directly with a frozen clock.

import type Database from 'better-sqlite3';
import { env } from '@/lib/env';
import type { BillingProvider } from './provider';
import { syncBillingQuantities } from './quantity-sync';

export interface BillingSyncWorkerHandle {
  stop: () => void;
}

export function startBillingSyncWorker(
  db: Database.Database,
  billing: BillingProvider,
  intervalSeconds: number = env.billing.syncWorkerPollSeconds
): BillingSyncWorkerHandle {
  const timer = setInterval(() => {
    void syncBillingQuantities(db, billing).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[billing-sync-worker] tick failed:', err);
    });
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
