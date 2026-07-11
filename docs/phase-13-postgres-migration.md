# Phase 13 — SQLite → Postgres + Kysely migration

Staged, module-by-module, never a big-bang rewrite. The SQLite baseline test suite is the
correctness contract — the running pass count against Postgres is the tracking signal across
stages. Decision record: `docs/decisions.md` ADR-013-01 (rationale, fresh-baseline choice,
Kysely choice, and the cross-stage invariants/landmines discovered along the way).

**Running pass count: 488 / 1119** (as of Stage 6a). Every failure not yet converted has been
confirmed to be the same "old code calling the new async/Kysely API synchronously" shape — no
suite has failed for a different, real-behavior reason.

> **Baseline correction:** earlier reports in this doc's history cited "440 / 1010" as of Stage
> 4. That 1010 figure was stale/wrong — re-verified directly against the Stage 4 commit
> (`dd8393b`, stashing all Stage 5 work and running the full suite against it) gives **440 /
> 1071**, not 1010. The extra ~61 tests were pre-existing Phase 12 test files that had already
> landed on disk by the time of that report, not anything Phase 13 added or removed. Stage 5's
> own delta is a clean, exact +25/+29 (test file additions only) on top of the corrected 1071
> baseline — see ADR-013-01 for the reconciliation math.

## Stage status

| Stage | Scope | Status | Commit |
|---|---|---|---|
| 0 | Postgres + Kysely foundation, test-isolation harness (per-run ephemeral DB + per-test transaction rollback), fresh baseline schema | ✅ done | `a794b60` |
| 1 | db-core rewrite: `client.ts`, `TenantDB` (async, transaction-nesting via savepoint), `migrate.ts`, `tests/helpers.ts` | ✅ done | `7cef0a8` |
| 2 | `logAudit`, `scope.ts` — tiny, imported everywhere, unblocks downstream conversion | ✅ done | `d70db30` |
| 3 | `auth.ts`, `rate-limit.ts`, `password-reset.ts` (+ `notifications/queue.ts` hard dependency), the 5 auth routes + reset-password page | ✅ done | `d70db30` |
| 4 | `tenants.ts`, `provisioning.ts`, `requirements/templates.ts`, `billing/{quantity-sync,worker,stripe-webhook}.ts` (+ narrow `createUser`/`createLocation` slices) | ✅ done | `dd8393b` |
| 5 | locations/users/dashboards — the biggest tenant-scoped CRUD cluster; finishes Stage 4's partial `users.ts`/`locations.ts` conversions, plus remaining `COLLATE NOCASE`/`INSERT OR IGNORE` spots and the `listUsers` N+1. Also: the `chase.ts` JSON1→jsonb rewrite, its `MIN()`/ordering type-safety fix (and the `expiryBoundaryMs` DATE_ONLY regression that fix nearly introduced — caught pre-commit), a durable normalize-on-write fix for unpadded expiration dates (`toIsoDateStr`, `earliestExpiration`), and the repo's first ESLint infra (see below) | ✅ done | `c9d9841` |
| 6a | vendors operator-side data access: `vendors.ts`, `resend-invite.ts`, `decision.ts`, the shared `issueInviteToken()` choke point (`src/lib/auth/invite-token.ts`), and 5 of 6 `src/app/api/vendors/**` routes. Lands **revoke-on-issue** for vendor invite tokens — a deliberate security change, see ADR-013-01. `add-to-locations.ts` + its route deferred — see Shortcuts & gaps | ✅ done | `9c06fe2` |
| 6b | vendor onboarding portal (`/v/[token]`): `vendor-token.ts`, `vendor-fsm.ts`, `vendor-onboarding.ts`, the portal routes/page. Must add the `revoked_at IS NULL` check to `validateInviteToken()` — 6a only writes revocation, reading it is 6b's job | not started | — |
| 7 | verification/requirements engine — depends on stages 4–6 | not started | — |
| 8 | notifications + retention + audit exports — the cross-tenant worker group, migrated together (claim-then-process pattern); fixes `search.ts`'s `rowid` spot, the `notifications/queue.ts` N+1 (`notifyTenantAdmins`, already fixed in Stage 3), and the `json_extract` spot in `notifications/renewal.ts` (see the cross-stage invariants below, items 8/9) | not started | — |
| 9 | reports/search — last, depends on nearly everything; fixes the two `reports/builders.ts` N+1 spots AND the `MIN(json_extract(...))` type-safety spot found during Stage 5's post-hoc JSON1 audit (see the cross-stage invariants below, items 8/9) | not started | — |
| 10 | dev scripts (`dev-seed.ts`, `eval-test-dataset.ts`), cutover cleanup, remove `better-sqlite3` dependency | not started | — |

Stage boundaries and reasoning: see the Phase 13 kickoff investigation report (chat, not
duplicated here) for the full original module map and per-stage rationale.

## Shortcuts & gaps

- **`add-to-locations.ts` + `POST /api/vendors/:id/locations` (discovered Stage 6a, not
  converted).** `addVendorToLocations()` calls `runRulesOnlyReeval()` → `runVerification()` →
  `loadExtractionBundle()` (`src/lib/verification/run.ts`) and `resolveRequirements()`
  (`src/lib/requirements/resolver.ts`) — genuinely Stage 7's charter (the whole verification
  pipeline orchestrator), not a narrow slice like prior stages' hard dependencies. These same
  functions are also called from the portal's submit route (Stage 6b) and
  `src/lib/requirements/re-eval.ts` (a third, separate consumer) — converting them now would
  silently do a meaningful chunk of Stage 7's work as an unplanned expansion of Stage 6a, well
  past "the four operator files." Left un-converted this stage; both the service function and
  its route still import the removed `getRawDb` and will not compile until Stage 7 (or a
  dedicated slice of it) lands. Not silently skipped — flagged here and in ADR-013-01.
- **`validateInviteToken()`'s `revoked_at` check is NOT yet wired up.** Stage 6a writes
  `revoked_at` correctly (see ADR-013-01's revoke-on-issue entry) but does not touch the
  portal-side read path — a revoked token still validates successfully until Stage 6b adds the
  `WHERE revoked_at IS NULL` check. This is a real, temporary gap (the column exists and is
  correctly populated; nothing reads it yet), not an oversight — explicitly Stage 6b's opening
  task, not deferred silently.
- **`GET /api/vendors/:id`'s `flags_json`/`evidence_json` re-`JSON.stringify()` (Stage 6a) is a
  temporary shim, tied to one specific file.** `src/app/vendors/[vendorId]/page.tsx` still does
  its own `JSON.parse()` on `flags_json` (not converted this stage). **Remove the
  re-stringify in `src/app/api/vendors/[id]/route.ts` the moment that page converts** — once its
  own `JSON.parse()` call is gone, the re-stringify becomes active double-encoding (a jsonb
  object stringified for no consumer, immediately breaking whatever replaces the old
  `JSON.parse()` call). See ADR-013-01 invariant 9 for the full mechanism.

## Repo infrastructure added mid-migration

**ESLint (`eslint.config.mjs`), added in Stage 5's pre-commit gap-closing pass.** The repo had
no ESLint setup at all before this — no config, no dependency, no lint script. Scoped
deliberately narrow: just `@typescript-eslint/no-floating-promises` and
`@typescript-eslint/no-misused-promises` (both type-aware, via `projectService: true`), the two
rules that catch the highest-risk silent bug class in a sync→async conversion — a dropped
`await` that used to be a no-op on a synchronous call and is now a silently-ignored Promise. Not
a general lint-everything setup; broadening scope (style rules, React rules, etc.) is a separate
decision for whoever owns that later.

Run it with `npx eslint <path>` (no `npm run lint` script added — deliberately, since running it
repo-wide currently fails on pre-existing, out-of-scope violations; see below).

- **Retroactively cleared Stages 1–4:** every file converted in Stages 1–4 (db-core, audit/scope,
  auth/tokens, tenants/provisioning/billing) is 100% clean against both rules — checked directly,
  not assumed.
- **Stage 5's own files are 100% clean.**
- **142 pre-existing violations remain, all in NOT-yet-converted Stage 6–9 modules**
  (`vendors.ts`, `verification/run.ts`, `exports/*`, `reports/*`, the notifications workers,
  `v/[token]/*`, etc.) or in pre-existing React client-component floating promises unrelated to
  this migration entirely. Left untouched — out of scope for Stage 5, flagged here so Stages 6–9
  clear their own portion as they convert, rather than rediscovering this from scratch.

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
   email-lookup call site converted so far. Fixed through Stage 5: `locations.ts`'s region-name
   dedupe and manager-email lookup, `users.ts`'s email lookup, `bulk-onboarding.ts`'s manager
   lookup. No remaining known spots outside Stage 6+'s not-yet-audited modules.
6. **`INSERT OR IGNORE`/`OR REPLACE` → `ON CONFLICT ... DO NOTHING`/`DO UPDATE`.**
   `TenantDB.insert(table, row, { orIgnore: true })` already does this (no conflict target
   specified — matches SQLite's "skip on ANY constraint violation" semantics). No remaining raw
   spots outside `TenantDB` known through Stage 5.
7. **N+1-in-`.map()` sites need `Promise.all` + async mapper, or `for...of` if the loop body
   has ordering/race sensitivity** (e.g. `provisionTenant`'s location loop — sequential because
   `recordBillingSnapshot`'s read-count-then-insert pattern would race under concurrent writes).
   Fixed so far: `notifications/queue.ts`'s `notifyTenantAdmins` (Stage 3, `Promise.all`),
   `provisionTenant`'s location creation (Stage 4, sequential `for...of`), `users.ts`'s
   `listUsers` (Stage 5, `Promise.all`). Remaining: `reports/builders.ts` ×2 (Stage 9).
8. **SQLite's `json_extract()`/JSON1 functions have no Postgres equivalent — rewrite to the `->>`
   jsonb text-extraction operator.** Missed by the Stage 0 investigation (DDL-only audit, not
   application queries). Fixed: `chase.ts` (Stage 5). A post-hoc repo-wide grep found two more
   un-converted spots — `notifications/renewal.ts:76` (Stage 8) and `reports/builders.ts:84-91`
   (Stage 9, same shape as item 9 below). **That grep was not re-run after Stages 6-8 land — Stage
   9 should re-grep before assuming this list is exhaustive.**
9. **`MIN()`/ordering over a jsonb `->>`-extracted value is a lexicographic TEXT comparison, not
   a chronological one**, unless cast to its real type first. Found in `chase.ts` via an unpadded
   date fixture (Stage 5, pre-commit review). The straightforward fix (cast + reformat via
   `to_char`) is a trap: it silently turns a DATE-ONLY value into a full timestamp, which breaks
   any downstream code detecting date-only-ness (here: `expiryBoundaryMs`'s tenant-timezone
   day-boundary math, OPS-7) — caught before commit, not by a test. The real fix never rewrites
   the value: `DISTINCT ON (col) ORDER BY (extracted)::timestamptz` for a SQL-side aggregate,
   `Date.parse()` (not raw string `<`) for a client-side reduction. `reports/builders.ts`'s
   `MIN(json_extract(...))` (item 8) has the identical shape and will need the identical
   treatment when Stage 9 converts it.
10. **Raw upstream string data (e.g. Vision-extracted dates) needs format normalization at its
    write choke point, independent of which SQL engine reads it back.** `expiration_date` had no
    format constraint from Vision's extraction schema, so a genuinely unpadded/non-ISO value could
    reach storage. Beyond the lexicographic-`MIN()` risk (item 9), an un-normalized value creates
    a *second*, subtler seam: `Date.parse()` on a non-conforming string is V8-implementation-
    defined (resolves in the process's local timezone) while Postgres's `::timestamptz` cast
    resolves in the Postgres server's timezone — two different interpretations of the same string
    that can silently disagree near a day boundary if the two processes run under different zone
    configs. Fixed at the source (`earliestExpiration()` in `notifications/renewal.ts`, the single
    choke point every renewal-chase payload's `expiration_date` flows through) via
    `toIsoDateStr()` (extended to also zero-pad unpadded ISO-dash dates, not just US slash format)
    — not a Postgres-specific fix, applies regardless of SQL engine.
