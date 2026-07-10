// src/lib/db/test-isolation.ts — Postgres test-isolation harness (Phase 13 migration).
// Moved here from db-postgres/ (Stage 0 scaffolding) now that db-core is wired for real
// (Stage 1) — this is tests/helpers.ts's foundation, not a standalone proof anymore.
//
// SQLite's `:memory:` gives every test a throwaway, fully-isolated DB engine instance for
// free. Postgres has no equivalent — a real server is shared — so this reconstructs the same
// two guarantees deliberately:
//
//   1. PER-RUN isolation: one jest invocation (main tree, or a separate isolated worktree
//      run) gets its own throwaway database, cloned from a schema-only template. Concurrent
//      runs against the same Postgres server never share a database, so they can't collide.
//   2. PER-TEST isolation: each test runs inside a transaction that is ALWAYS rolled back,
//      regardless of pass/fail. Nothing a test writes is ever visible to any other test or
//      to a fresh connection, exactly like a thrown-away :memory: instance.
//
// Nested "transactions" inside app code (TenantDB.transaction(), src/lib/db/tenant.ts)
// compose with #2 via a real Postgres SAVEPOINT — see tenant.ts's docstring for why this
// requires the CONTROLLED transaction API (startTransaction()/savepoint()), not the simple
// callback form, and why withTestTransaction below is built the same way for exactly that
// reason (proven under concurrent worktree runs in Stage 0 — see docs/decisions.md ADR-013-01).

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { env } from '@/lib/env';
import type { Db } from './client';

function connectionStringFor(database: string): string {
  const { host, port, user, password } = env.postgres;
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

/** A Kysely instance over a single Postgres database. Caller owns lifecycle (`destroy()`). */
export function kyselyFor(database: string): Db {
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
 * directly to PG_TEST_TEMPLATE_DATABASE outside of applying migrations to it.
 */
export async function createEphemeralTestDatabase(): Promise<{ name: string; db: Db }> {
  const template = env.postgres.testTemplateDatabase;
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
export async function dropEphemeralTestDatabase(name: string, db: Db): Promise<void> {
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
 * supports `.savepoint()` — required for TenantDB.transaction()'s nesting to work when called
 * from inside a test (see tenant.ts's docstring). `fn`'s return value is preserved; any error
 * it throws propagates to the caller after rollback has still happened.
 */
export async function withTestTransaction<T>(db: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
  const trx = await db.startTransaction().execute();
  try {
    return await fn(trx);
  } finally {
    await trx.rollback().execute();
  }
}
