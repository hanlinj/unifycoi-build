// tests/worker-bootstrap.pg.test.ts — Phase 13 migration, Stage 8a: smoke test for the
// bootstrap.ts pre-existing-bug fix (ADR-013-01, Stage 8a finding). bootstrap.ts's `db` param
// was mistyped as better-sqlite3's `Database.Database` while `startBillingSyncWorker` had
// required Kysely's `Db` since Stage 4 — a type-level lie, latent because nothing ever called
// startAllWorkers() with a real handle under test.
//
// Scope of what this test CAN honestly prove: startAllWorkers() itself never touches `db`
// synchronously — every start*Worker() just closes over `db` inside a setInterval callback
// (processDueNotifications/runDigestCycle/processQueuedExports/syncBillingQuantities/
// runRetentionSweep all fire later, on tick, never at start-call time). So this test proves
// bootstrap wires a REAL Kysely Db through all five workers with zero coercion, all handles
// come back stoppable, and stopping is clean.
//
// What this test deliberately does NOT do: advance timers to fire a tick. Three of the five
// workers (notification/digest/audit-export) are still Stage 8b/8c work and still expect
// `Database.Database` internally — firing their tick against a real Kysely Db would throw
// `db.prepare is not a function`, which is already-known, already-tracked, expected breakage
// (see bootstrap.ts's own doc comment and ADR-013-01), not something this test needs to
// re-prove. Only retention and billing-sync are converted so far; those two are safe to fire.
import 'dotenv/config';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { startAllWorkers, stopAllWorkers } from '@/lib/workers/bootstrap';
import { NoOpMailer } from '@/lib/notifications/mailer';
import { NoOpBillingProvider } from '@/lib/billing/provider';
import type { Db } from '@/lib/db/client';

describe('db-core (Stage 8a): workers/bootstrap.ts wiring', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('wires a real Kysely Db through all five workers with no coercion, returns stoppable handles', () => {
    const handles = startAllWorkers(new NoOpMailer(), db, new NoOpBillingProvider());
    expect(typeof handles.notification.stop).toBe('function');
    expect(typeof handles.digest.stop).toBe('function');
    expect(typeof handles.retention.stop).toBe('function');
    expect(typeof handles.auditExport.stop).toBe('function');
    expect(typeof handles.billingSync.stop).toBe('function');

    expect(() => stopAllWorkers(handles)).not.toThrow();
  });
});
