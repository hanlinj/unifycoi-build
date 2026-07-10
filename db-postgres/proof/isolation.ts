// db-postgres/proof/isolation.ts — Stage 0 test-isolation proof.
// Run: npx tsx db-postgres/proof/isolation.ts
//
// Proves the three properties the migration's correctness depends on:
//   A. Per-test rollback: a test's writes are invisible to a fresh connection once it ends.
//   B. Nested transactions (Stage 1's TenantDB.transaction() called from inside a test's
//      wrapper transaction) compose via savepoints — commit inside, still rolled back outside.
//   C. Concurrent isolation: two "tests" (jest workers) sharing one ephemeral per-run database
//      never see each other's uncommitted writes, even mid-flight.
// Also proves per-run isolation (a second invocation of this file, run concurrently, gets its
// own database and cannot collide with the first) — see the worktree run in the Stage 0 report.

import 'dotenv/config';
import { createEphemeralTestDatabase, dropEphemeralTestDatabase, withTestTransaction } from '../test-isolation';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`   ✓ ${msg}`);
}

async function main() {
  console.log('Setting up one ephemeral per-run database (shared by every "test" below, like one jest invocation)...');
  const { name, db } = await createEphemeralTestDatabase();
  console.log(`   ✓ ephemeral database "${name}" ready (schema inherited from the template clone)\n`);

  try {
    // ── A. Per-test rollback ────────────────────────────────────────────────
    console.log('A. Per-test rollback (mirrors :memory: throwaway semantics)');
    await withTestTransaction(db, async (trx) => {
      await trx.insertInto('tenants').values({ id: 'tenant-a', name: 'Test A', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
      const insideCount = await trx.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', '=', 'tenant-a').executeTakeFirstOrThrow();
      assert(Number(insideCount.n) === 1, 'row is visible INSIDE its own test transaction');
    });
    const afterCount = await db.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', '=', 'tenant-a').executeTakeFirstOrThrow();
    assert(Number(afterCount.n) === 0, 'row is GONE after the test transaction rolled back (read via the shared run-level connection)');
    console.log();

    // ── B. Nested transaction / savepoint compatibility ─────────────────────
    // NOTE: Kysely's simple `.transaction().execute()` callback form does NOT support this —
    // it throws if called again on an already-open Transaction. Real nesting requires the
    // CONTROLLED transaction API (`.savepoint(name).execute()`), which is what Stage 1's
    // TenantDB.transaction() will need to detect-and-use when already inside a transaction.
    console.log('B. Nested transaction (savepoint) compatibility — simulates Stage 1\'s TenantDB.transaction() detecting it\'s already inside a transaction and using a savepoint');
    await withTestTransaction(db, async (trx) => {
      await trx.insertInto('tenants').values({ id: 'tenant-b-outer', name: 'Outer', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
      const nested = await trx.savepoint('nested_tx').execute();
      await nested.insertInto('tenants').values({ id: 'tenant-b-inner', name: 'Inner (nested/savepoint)', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
      await nested.releaseSavepoint('nested_tx').execute(); // the nested "commit" — still just a savepoint release
      const bothVisible = await trx.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', 'in', ['tenant-b-outer', 'tenant-b-inner']).executeTakeFirstOrThrow();
      assert(Number(bothVisible.n) === 2, 'both outer and nested-savepoint rows visible inside the test transaction');
    });
    const bAfter = await db.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', 'in', ['tenant-b-outer', 'tenant-b-inner']).executeTakeFirstOrThrow();
    assert(Number(bAfter.n) === 0, 'BOTH rows gone after outer rollback — the nested savepoint\'s own RELEASE (its "commit") does not survive the outer ROLLBACK');
    console.log();

    // ── C. Concurrent isolation (simulates 2 parallel jest workers) ─────────
    console.log('C. Concurrent isolation — two "tests" run at the same time against the SAME ephemeral database');
    const workerA = withTestTransaction(db, async (trx) => {
      await trx.insertInto('tenants').values({ id: 'tenant-c-worker-a', name: 'Worker A', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
      await new Promise((r) => setTimeout(r, 150)); // hold the transaction open, mid-flight
      const seenByA = await trx.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', 'like', 'tenant-c-worker-%').executeTakeFirstOrThrow();
      return Number(seenByA.n);
    });
    const workerB = withTestTransaction(db, async (trx) => {
      await new Promise((r) => setTimeout(r, 50)); // start slightly after A, while A is still open
      await trx.insertInto('tenants').values({ id: 'tenant-c-worker-b', name: 'Worker B', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
      const seenByB = await trx.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', 'like', 'tenant-c-worker-%').executeTakeFirstOrThrow();
      return Number(seenByB.n);
    });
    const [countSeenByA, countSeenByB] = await Promise.all([workerA, workerB]);
    assert(countSeenByA === 1, `Worker A saw only its own row while Worker B was concurrently mid-transaction (saw ${countSeenByA}, not B's uncommitted insert)`);
    assert(countSeenByB === 1, `Worker B saw only its own row while Worker A was concurrently mid-transaction (saw ${countSeenByB}, not A's uncommitted insert)`);
    const cAfter = await db.selectFrom('tenants').select(({ fn }) => fn.countAll().as('n')).where('id', 'like', 'tenant-c-worker-%').executeTakeFirstOrThrow();
    assert(Number(cAfter.n) === 0, 'both workers\' rows gone after both rolled back');
    console.log();

    console.log('✅ All three isolation properties proven: per-test rollback, nested-transaction/savepoint compatibility, and concurrent-worker isolation.');
  } finally {
    console.log(`\nDropping the ephemeral database "${name}"...`);
    await dropEphemeralTestDatabase(name, db);
    console.log('   ✓ dropped');
  }
}

main().catch((err) => {
  console.error('❌ Isolation proof FAILED:', err);
  process.exit(1);
});
