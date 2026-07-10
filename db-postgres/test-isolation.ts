// db-postgres/test-isolation.ts — Stage 0 test-isolation harness (Phase 13 migration).
//
// SQLite's `:memory:` gives every test a throwaway, fully-isolated DB engine instance for
// free (tests/helpers.ts:setupTestDb). Postgres has no equivalent — a real server is shared —
// so this reconstructs the same two guarantees deliberately:
//
//   1. PER-TEST isolation: each test runs inside a transaction that is ALWAYS rolled back,
//      regardless of pass/fail. Nothing a test writes is ever visible to any other test or
//      to a fresh connection, exactly like a thrown-away :memory: instance.
//   2. PER-RUN isolation: each jest invocation (main tree, or a separate isolated worktree
//      run) gets its own throwaway database, cloned from a schema-only template. Concurrent
//      runs against the same Postgres server never share a database, so they can't collide
//      even if two runs pick overlapping fixture values.
//
// Nested "transactions" inside app code (Stage 1's TenantDB.transaction()) compose with #1, but
// NOT automatically — this took a failed proof run to pin down precisely, worth stating plainly:
// Kysely's simple callback form (`db.transaction().execute(async trx => ...)`) explicitly THROWS
// if called again on an already-open `Transaction` ("calling the transaction method for a
// Transaction is not supported"). Savepoint-based nesting only exists on Kysely's CONTROLLED
// transaction API (`db.startTransaction().execute()` → manual `.commit()`/`.rollback()`, plus
// `.savepoint(name).execute()` for a nested scope) — `.savepoint()` isn't even a method on the
// plain callback-style `Transaction` type. Concretely: Stage 1's `TenantDB.transaction()` must
// be built on the controlled API and must itself detect "I'm already inside a transaction" (by
// checking whether the `db` it was constructed with IS a `Transaction`/`ControlledTransaction`)
// and call `.savepoint(uniqueName)` in that case instead of trying to open a new transaction —
// this is real design work for that stage, not a mechanical async-ify. `withTestTransaction`
// below is written on the controlled API for exactly this reason, so it proves the pattern
// Stage 1 actually needs, not a simplification that turns out not to compose.
//
// Proven in db-postgres/proof/isolation.ts — run that file to see the guarantees exercised.

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface PgConnInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

function readConnInfo(): PgConnInfo {
  const host = process.env['PG_HOST'];
  const port = process.env['PG_PORT'];
  const user = process.env['PG_USER'];
  const password = process.env['PG_PASSWORD'];
  if (!host || !port || !user || !password) {
    throw new Error('PG_HOST/PG_PORT/PG_USER/PG_PASSWORD must be set (see .env) to use the Postgres test-isolation harness');
  }
  return { host, port: Number(port), user, password };
}

function connectionStringFor(database: string, conn: PgConnInfo = readConnInfo()): string {
  return `postgresql://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${database}`;
}

/** A Kysely instance over a single Postgres database. Caller owns lifecycle (`destroy()`). */
export function kyselyFor(database: string): Kysely<any> {
  return new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: connectionStringFor(database) }) }),
  });
}

/**
 * Clone a fresh, uniquely-named database from the schema-only template (PG_TEST_TEMPLATE_DATABASE).
 * One call per jest invocation / isolated-worktree run — NOT per test file, since CREATE DATABASE
 * FROM TEMPLATE costs real time (tens-hundreds of ms) and 1010 tests each getting their own would
 * be far slower than SQLite's :memory: instantiation. Per-test isolation instead comes from
 * `withTestTransaction` below, layered on top of this one shared per-run database.
 *
 * Requires the template database to have NO active connections at clone time (a hard Postgres
 * requirement for CREATE DATABASE ... TEMPLATE) — callers must never open a Kysely/pg connection
 * directly to PG_TEST_TEMPLATE_DATABASE outside of applying the baseline schema to it once.
 */
export async function createEphemeralTestDatabase(): Promise<{ name: string; db: Kysely<any> }> {
  const conn = readConnInfo();
  const template = process.env['PG_TEST_TEMPLATE_DATABASE'];
  if (!template) throw new Error('PG_TEST_TEMPLATE_DATABASE must be set (see .env)');

  const name = `test_${randomUUID().replace(/-/g, '')}`;
  const admin = kyselyFor('postgres'); // maintenance DB — CREATE/DROP DATABASE can't run inside a transaction
  try {
    await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE ${sql.id(template)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  return { name, db: kyselyFor(name) };
}

/** Tear down an ephemeral database created by createEphemeralTestDatabase(). */
export async function dropEphemeralTestDatabase(name: string, db: Kysely<any>): Promise<void> {
  await db.destroy(); // close the pool holding a connection to it first — DROP DATABASE requires zero connections
  const admin = kyselyFor('postgres');
  try {
    // Defensive: terminate any lingering backends before dropping (e.g. a connection this
    // process forgot to close) — DROP DATABASE fails outright if anything is still connected.
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`.execute(admin);
    await sql`DROP DATABASE IF EXISTS ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
}

/**
 * Run `fn` inside a transaction that is ALWAYS rolled back afterward, success or failure —
 * the per-test isolation primitive. Built on Kysely's CONTROLLED transaction API (not the
 * simple `.transaction().execute()` callback form) specifically so `fn` receives a `trx` that
 * supports `.savepoint()` — required for proving nested-transaction compatibility (see the
 * module doc comment above). `fn`'s return value is preserved; any error it throws propagates
 * to the caller after rollback has still happened.
 */
export async function withTestTransaction<T>(db: Kysely<any>, fn: (trx: Kysely<any>) => Promise<T>): Promise<T> {
  const trx = await db.startTransaction().execute();
  try {
    return await fn(trx);
  } finally {
    await trx.rollback().execute();
  }
}
