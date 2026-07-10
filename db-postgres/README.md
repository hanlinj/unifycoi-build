# db-postgres/ — Phase 13 migration, Stage 0

Infrastructure only. Nothing in `src/` reads or writes any of this yet — Stage 1 wires
`TenantDB`/`getRawDb()` over to this. Kept outside `src/` deliberately so this stage stays
inert with respect to the app.

## What's here

- `migrations/001_baseline.ts` — the fresh Postgres schema baseline (Kysely migration, `up`/`down`).
  Not a one-for-one port of `src/migrations/001-017.sql` — see ADR-013-01 for why. Verified
  column-by-column against all 17 SQLite migration files directly.
- `test-isolation.ts` — the reusable per-run + per-test isolation harness Stage 1's
  `tests/helpers.ts` rewrite will build on: `createEphemeralTestDatabase()` /
  `dropEphemeralTestDatabase()` (per-run) and `withTestTransaction()` (per-test).
- `apply-baseline.ts` — one-off CLI to apply the baseline to a *named* database (used once
  against the dev DB and once against the test template — never against an ephemeral test DB,
  those inherit the schema for free via `CREATE DATABASE ... TEMPLATE`).
- `proof/hello-world.ts` — proves the whole toolchain connects (pg → Kysely → baseline → a
  real query) against a throwaway database.
- `proof/isolation.ts` — proves the three isolation properties test-isolation.ts provides
  (per-test rollback, nested-transaction/savepoint compatibility, concurrent-worker isolation).

Run either proof: `npx tsx db-postgres/proof/hello-world.ts` / `.../isolation.ts`.

## Dev database (local, standing in for Railway)

No Docker or Railway CLI available in this environment during Stage 0 (checked: no `docker`
binary/socket, no `railway` CLI, no existing Railway credentials anywhere in `.env`). Per the
owner's call, Railway-for-dev is deferred to a later stage rather than blocking foundation
work — Postgres 16 was installed locally instead (`sudo apt-get install -y postgresql`) and
plays the same role:

```
Host:     127.0.0.1:5432
User:     postgres
Password: localdevpg          (local dev only — real secrets never go in this file)
Databases:
  unifycoi_dev             — the "dev" database (baseline applied)
  unifycoi_test_template   — schema-only template; NEVER connect to this directly except to
                              (re)apply migrations. Ephemeral per-run test databases are
                              cloned FROM it.
```

Connection details live in `.env` (gitignored) — see `DATABASE_URL`/`PG_*` there.
`.env.example` documents the shape with placeholders, same convention as every other secret
in this repo.

**Cutting over to Railway later** is just re-pointing `.env`'s `DATABASE_URL`/`PG_*` at
Railway's connection string and re-running `apply-baseline.ts` against it — nothing in this
directory is local-Postgres-specific.

## Test isolation — the core Stage 0 deliverable

SQLite's `:memory:` gives every test a throwaway, fully-isolated DB engine instance for free.
Postgres has no equivalent (a real server is shared), so this reconstructs the same two
guarantees deliberately, as a two-layer scheme:

1. **Per-run isolation** — `createEphemeralTestDatabase()` clones a uniquely-named database
   from `unifycoi_test_template` (`CREATE DATABASE ... TEMPLATE`) once per jest invocation
   (not per test — cloning costs real time, too slow to do 1010 times). Concurrent runs
   (parallel worktrees, or two people running tests at once) each get their own database and
   cannot collide, even if their fixtures use identical values.
2. **Per-test isolation** — `withTestTransaction(db, fn)` runs `fn` inside a transaction that
   is *always* rolled back afterward, success or failure. Nothing a test writes survives past
   it — the same throwaway property `:memory:` gives for free.

**Proven, not just designed** (`proof/isolation.ts`):
- A: a row inserted inside `withTestTransaction` is visible inside, gone after (read via a
  separate connection to the same run-level database).
- B: a *nested* transaction (simulating Stage 1's `TenantDB.transaction()` being called from
  inside a test's wrapper transaction) composes via a real Postgres `SAVEPOINT` — and rolling
  back the outer transaction discards the savepoint's effects too, even though the savepoint
  itself was "released" (its own commit) first.
- C: two concurrent `withTestTransaction` blocks sharing the same ephemeral database (one
  holding its transaction open while the other starts, simulating two parallel jest workers)
  never see each other's uncommitted writes.
- Worktree-safety: two isolation proofs launched *simultaneously*, one from the main tree and
  one from a separate `git worktree`, both against the same Postgres server — each got its
  own ephemeral database, neither saw the other's data, both cleaned up independently.

### The one real design finding from proving this (not just infra)

Kysely's simple callback-style transaction (`db.transaction().execute(async trx => ...)`)
**does not auto-nest via savepoints** — calling it again on an already-open `Transaction`
throws (`"calling the transaction method for a Transaction is not supported"`). Savepoints
only exist on the *controlled* transaction API: `const trx = await db.startTransaction().execute()`,
then `trx.savepoint(name).execute()` for a nested scope, with manual `.commit()`/`.rollback()`.

This means Stage 1's `TenantDB.transaction()` can't be a thin async wrapper around the simple
callback form — it needs to be built on the controlled API, and it needs to detect "am I
already inside a transaction?" (e.g. by checking whether the `db` it holds is already a
`Transaction`/`ControlledTransaction` instance) to decide whether to open a new transaction or
take a savepoint. `withTestTransaction` in `test-isolation.ts` is written this way specifically
so it proves the pattern Stage 1 actually needs, not a simplification that turns out not to
compose. Flagged here so Stage 1 doesn't have to rediscover it.

## Deferred, deliberately

- Native `citext`/enum types for the several TEXT columns SQLite never validated either
  (`documents.state`, `notifications.status`, etc.) — an opportunity, not exercised here, to
  keep this a faithful port-with-proper-types rather than a schema redesign.
- Native Postgres `uuid` column type for the UUID-shaped `text` primary keys — kept as `text`
  to match current app behavior (JS strings in, JS strings out) exactly; switching types is a
  separate, deliberate call for a later stage.
- Railway itself — local Postgres stands in for now; re-pointing the connection string is the
  entire migration when that happens.
