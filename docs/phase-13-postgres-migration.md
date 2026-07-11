# Phase 13 — SQLite → Postgres + Kysely migration

Staged, module-by-module, never a big-bang rewrite. The 1010-test suite (SQLite baseline) is
the correctness contract — the running pass count against Postgres is the tracking signal
across stages. Decision record: `docs/decisions.md` ADR-013-01 (rationale, fresh-baseline
choice, Kysely choice, and the cross-stage invariants/landmines discovered along the way).

**Running pass count: 440 / 1010** (as of Stage 4, commit `dd8393b`). Every failure not yet
converted has been confirmed to be the same "old code calling the new async/Kysely API
synchronously" shape — no suite has failed for a different, real-behavior reason.

## Stage status

| Stage | Scope | Status | Commit |
|---|---|---|---|
| 0 | Postgres + Kysely foundation, test-isolation harness (per-run ephemeral DB + per-test transaction rollback), fresh baseline schema | ✅ done | `a794b60` |
| 1 | db-core rewrite: `client.ts`, `TenantDB` (async, transaction-nesting via savepoint), `migrate.ts`, `tests/helpers.ts` | ✅ done | `7cef0a8` |
| 2 | `logAudit`, `scope.ts` — tiny, imported everywhere, unblocks downstream conversion | ✅ done | `d70db30` |
| 3 | `auth.ts`, `rate-limit.ts`, `password-reset.ts` (+ `notifications/queue.ts` hard dependency), the 5 auth routes + reset-password page | ✅ done | `d70db30` |
| 4 | `tenants.ts`, `provisioning.ts`, `requirements/templates.ts`, `billing/{quantity-sync,worker,stripe-webhook}.ts` (+ narrow `createUser`/`createLocation` slices) | ✅ done | `dd8393b` |
| 5 | locations/users/dashboards — the biggest tenant-scoped CRUD cluster; finishes Stage 4's partial `users.ts`/`locations.ts` conversions, plus remaining `COLLATE NOCASE`/`INSERT OR IGNORE` spots and the `listUsers` N+1 | 🔜 next | — |
| 6 | vendors + vendor onboarding portal (`/v/[token]`) — vendor lifecycle, invites, FSM; includes its own transaction-boundary rewrites | not started | — |
| 7 | verification/requirements engine — depends on stages 4–6 | not started | — |
| 8 | notifications + retention + audit exports — the cross-tenant worker group, migrated together (claim-then-process pattern); fixes `search.ts`'s `rowid` spot and the `notifications/queue.ts` N+1 (`notifyTenantAdmins`, already fixed in Stage 3) | not started | — |
| 9 | reports/search — last, depends on nearly everything; fixes the two `reports/builders.ts` N+1 spots | not started | — |
| 10 | dev scripts (`dev-seed.ts`, `eval-test-dataset.ts`), cutover cleanup, remove `better-sqlite3` dependency | not started | — |

Stage boundaries and reasoning: see the Phase 13 kickoff investigation report (chat, not
duplicated here) for the full original module map and per-stage rationale.

## What "green" means each stage

Db-core itself doesn't produce a compiling app until every module converts — that's expected,
not a failure signal. Each stage's actual bar:
1. The stage's own converted files are `tsc`-clean.
2. A dedicated `tests/*.pg.test.ts` file for that stage's modules passes 100%, run against real
   Postgres via the Stage 0/1 isolation harness.
3. The full suite's pass count climbs by roughly the new test count; the failure count doesn't
   grow for a NEW reason — every failure is still "old code calling the new API synchronously."
4. Anything that fails for a different, real-behavior reason stops the stage for review — it
   does not get pushed past.

## Cross-stage invariants (read before touching any further module)

See ADR-013-01 in `docs/decisions.md` for the full write-up. Summary:

1. **Never open a Kysely transaction directly.** Always call `withTransaction()`
   (`src/lib/db/transaction.ts`). It detects whether `db` is already inside a transaction and
   takes a `SAVEPOINT` instead of trying to `BEGIN` again, which Kysely's controlled API throws
   on. `TenantDB.transaction()` already delegates to it; every future raw-transaction call site
   (Stage 6+ tenants-adjacent code) must too.
2. **`jsonb` columns come back already parsed.** Never call `JSON.parse()` on a `*_json` column
   read — Kysely/pg deserializes it for you (unlike SQLite's `TEXT`-stored JSON, which needed
   the parse). Applies to every remaining `*_json` column: `flags_json`, `encryption_json`,
   `evidence_json`, and the notification/audit `payload_json` columns Stage 8 will touch.
3. **`bigint`/`bigserial`/`COUNT(*)` results come back as strings**, not numbers (Postgres
   precision safety — a `bigint` can exceed JS's safe integer range). Regular `integer` columns
   come back as real numbers; no cast needed there. Cast explicitly (`Number(...)`) wherever a
   `COUNT(*)` or the `seq` column's value is used as a number, not just for ordering.
4. **`tests/setup.ts`'s `unhandledRejection` listener stays until the migration completes.**
   Node 15+ crashes the whole worker process on an unhandled rejection with no listener
   attached; old test files calling now-async methods synchronously produce exactly that,
   cascading failures onto unrelated tests in the same worker. Don't remove this early.
5. **`COLLATE NOCASE` → `lower(col) = lower($)`**, not a `citext` column — matches the old
   ASCII case-folding behavior exactly, verified explicitly in Stage 3's test suite for every
   email-lookup call site converted so far. Remaining spots: `locations.ts`'s region-name dedupe
   and manager-email lookup, `bulk-onboarding.ts` (Stage 5).
6. **`INSERT OR IGNORE`/`OR REPLACE` → `ON CONFLICT ... DO NOTHING`/`DO UPDATE`.**
   `TenantDB.insert(table, row, { orIgnore: true })` already does this (no conflict target
   specified — matches SQLite's "skip on ANY constraint violation" semantics). Remaining raw
   spots outside `TenantDB`: none currently known outside Stage 5/6's scope.
7. **N+1-in-`.map()` sites need `Promise.all` + async mapper, or `for...of` if the loop body
   has ordering/race sensitivity** (e.g. `provisionTenant`'s location loop — sequential because
   `recordBillingSnapshot`'s read-count-then-insert pattern would race under concurrent writes).
   Fixed so far: `notifications/queue.ts`'s `notifyTenantAdmins` (Stage 3, `Promise.all`),
   `provisionTenant`'s location creation (Stage 4, sequential `for...of`). Remaining: `users.ts`'s
   `listUsers` (Stage 5), `reports/builders.ts` ×2 (Stage 9).
