# Phase 13 — SQLite → Postgres + Kysely migration

Staged, module-by-module, never a big-bang rewrite. The SQLite baseline test suite is the
correctness contract — the running pass count against Postgres is the tracking signal across
stages. Decision record: `docs/decisions.md` ADR-013-01 (rationale, fresh-baseline choice,
Kysely choice, and the cross-stage invariants/landmines discovered along the way).

**Running pass count: 561 / 1192** (as of Stage 8c). Every failure not yet converted has been
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
| 6b | vendor onboarding portal (`/v/[token]`): `vendor-token.ts`, `vendor-fsm.ts`, `vendor-onboarding.ts`, a narrow slice of `notifications/renewal.ts` (`scheduleRenewalReminders`, `supersedeReminders`, `handleCoiUploadChase`), and the portal routes/page except `submit/route.ts` (deferred — see Shortcuts & gaps). Wires up the `revoked_at IS NULL` check in `validateInviteToken()`. **The wrong-vendor authz test passed clean — no leak found.** | ✅ done | `fa476ac` |
| 7 | verification/requirements engine, converted as ONE unit (confirmed no natural seam — `runVerification` interleaves reads/writes with no cut line): `verification/run.ts` (`runVerification`/`loadExtractionBundle`/`runRulesOnlyReeval`), `requirements/resolver.ts`'s `resolveRequirements`. Picks up `add-to-locations.ts` + its route (Stage 6a), `submit/route.ts` (Stage 6b), and the `requirements/*` routes + `services/requirements.ts` + `requirements/re-eval.ts` — 4 of the 5 originally-identified blocked callers. `exports/content.ts` discovered mid-stage to cascade into the whole audit-export subsystem — deferred to Stage 8, see Shortcuts & gaps. Also: `runVerification`'s 4-table write now atomic via `withTransaction()` (deliberate correctness change, not preservation — see ADR-013-01), and date normalization centralized at the Vision extraction boundary (`dateField()` in `extractor.ts`), superseding Stage 6a's per-path fix | ✅ done | `15e5d8b` |
| 8a | retention: `retention/worker.ts` (the only retention file — idempotent full-scan mark, no claim-then-process/`claimed_at`). Plus a flagged pre-existing-bug fix: `workers/bootstrap.ts`'s `db` param was mistyped as `Database.Database` (silently broken since Stage 4) and `instrumentation.ts` called the Stage-1-removed `getRawDb` — both fixed as findings, not bundled into the conversion diff; see ADR-013-01 | ✅ done | `2dfe352` |
| 8b | notifications: `worker.ts`, `digest.ts`, `resend-webhook.ts` (+ its route), `notifications/renewal.ts`'s remaining un-converted function `applyExpirationFlip` (rest of the file converted in Stage 6b as a narrow portal-upload hard dependency), `services/manual-reminder.ts` (+ its route) — mechanical, no architecture change. Checked the claim for a multi-instance concurrency gap and found none (already safe by construction, corroborated by OPS-6 — see ADR-013-01); attached OPS-6's single-instance caveat at the digest/retention worker entry points (was orphaned for retention since Stage 8a) | ✅ done | `0c6c90f` |
| 8c | audit exports: `exports/content.ts` + `exports/audit-export.ts` + `exports/worker.ts` + all three `app/api/exports/**` routes (deferred from Stage 7 — see ADR-013-01 and Shortcuts & gaps). Local `inClausePg` helper (not `reports/index.ts`'s SQLite one) for IN-clauses; caught and fixed a live invariant-2 landmine in `decryptedSensitiveFor`'s Sensitive-decrypt path | ✅ done | `2bfbd3d` |
| 9 | reports/search — last, depends on nearly everything; fixes the two `reports/builders.ts` N+1 spots, the `MIN(json_extract(...))` type-safety spot found during Stage 5's post-hoc JSON1 audit (the one remaining known JSON1 spot as of Stage 6b — see the cross-stage invariants below, items 5/6), and `search.ts`'s `rowid` spot (re-scoped here from the original Stage 8 charter — unrelated to notifications/retention/audit-exports, more naturally reports/search's territory; found during Stage 8's pre-kickoff scoping trace) | not started | — |
| 10 | dev scripts (`dev-seed.ts`, `eval-test-dataset.ts`), cutover cleanup, remove `better-sqlite3` dependency | not started | — |

Stage boundaries and reasoning: see the Phase 13 kickoff investigation report (chat, not
duplicated here) for the full original module map and per-stage rationale.

## Shortcuts & gaps

- ~~`add-to-locations.ts` + `POST /api/vendors/:id/locations` (discovered Stage 6a, not
  converted).~~ **Closed in Stage 7** — converted alongside the verification engine it was
  blocked on.
- ~~`validateInviteToken()`'s `revoked_at` check is NOT yet wired up.`~~ **Closed in Stage 6b** —
  `validateInviteToken()` now rejects `revoked_at IS NOT NULL`, joining the same uniform-null
  path as unknown/expired/bounced. See ADR-013-01's Stage 6b entry for the indistinguishability
  proof.
- **`GET /api/vendors/:id`'s `flags_json`/`evidence_json` re-`JSON.stringify()` (Stage 6a) is a
  temporary shim, tied to one specific file.** `src/app/vendors/[vendorId]/page.tsx` still does
  its own `JSON.parse()` on `flags_json` (not converted through Stage 7). **Remove the
  re-stringify in `src/app/api/vendors/[id]/route.ts` the moment that page converts** — once its
  own `JSON.parse()` call is gone, the re-stringify becomes active double-encoding (a jsonb
  object stringified for no consumer, immediately breaking whatever replaces the old
  `JSON.parse()` call). See ADR-013-01 invariant 9 for the full mechanism.
- ~~`src/app/api/v/[token]/submit/route.ts` (discovered Stage 6b, not converted) — the exact
  Stage 7 seam.~~ **Closed in Stage 7** — converted alongside the verification engine.
- ~~`notifications/renewal.ts`'s `applyExpirationFlip` remains un-converted.~~ **Closed in
  Stage 8b** — converted alongside the rest of the notifications subsystem.
- ~~`src/lib/exports/content.ts` + `src/lib/exports/audit-export.ts` (discovered Stage 7, not
  converted) — cascades into the whole audit-export subsystem.~~ **Closed in Stage 8c** —
  converted alongside `worker.ts` and all three `app/api/exports/**` routes. The cascade the
  Stage 7 discovery predicted was real: `content.ts`, `audit-export.ts`, `worker.ts`, and three
  routes all converted together as one unit, same shape Stage 7 itself was.
- ~~`src/lib/workers/bootstrap.ts`'s one remaining not-yet-converted call site.~~ **Closed in
  Stage 8c** — `startAuditExportWorker` now converted; all five `startAllWorkers` calls wire
  cleanly with zero downstream type errors, for the first time since the bug was introduced
  (Stage 4). See ADR-013-01's Stage 8a entry for the full "did the workers ever run"
  investigation.
- **Discovered in the pre-8c reconciliation sweep, NOT closed by Stage 8c (out of its scope) —
  a genuinely unassigned surface, larger than any single-file finding so far.** 16 files (the
  entire `/platform` UI plus several billing/webhook routes) still call the Stage-1-removed
  `getRawDb()` despite calling already-converted Stage 3/4 service functions underneath — the
  exact bootstrap.ts pattern, just never claimed by any stage because the stage plan was written
  against service-file boundaries, not HTTP-reachability. Full list, mechanism, and a placement
  recommendation in the "Discovered, unassigned surface" section below.
- ~~`src/lib/services/manual-reminder.ts` is undocumented and unassigned to any stage.~~
  **Closed in Stage 8b** — converted alongside notifications (its two DB dependencies,
  `queueNotification` and `chase.ts`'s `vendorExpiry`, were already converted in Stages 3 and 5
  respectively, so it was a cheap pickup, not a scope expansion).
- ~~Tracking-doc drift, flagged for a pre-Stage-10 reconciliation pass, not fixed now.~~
  **A reconciliation pass ran pre-8c (2026-07-11), not pre-10 — see ADR-013-01's "Pre-8c
  reconciliation sweep" entry.** The three previously-surfaced files (`exports/content.ts`,
  `bootstrap.ts`, `manual-reminder.ts`) are all now accounted for. The `Database.Database` sweep
  came back clean (matches the tracking docs exactly). The `getRawDb` sweep did NOT come back
  clean — see the new section immediately below. **This does not retire the obligation for a
  final pass before Stage 10** — it found a bigger gap than expected, which is itself a reason to
  re-run this sweep again once Stage 8c/9 land, not to consider reconciliation "done."

## Discovered, unassigned surface (pre-8c reconciliation, 2026-07-11)

A repo-wide `getRawDb` grep (removed from `src/lib/db/client.ts` since Stage 1) found 21
importing files. 5 belong to already-tracked not-yet-converted stages (`app/api/exports/**` ×3 →
8c; `app/api/reports/[reportKey]`, `app/api/search` → 9) — expected, not new. **The other 16 are
genuinely unassigned in the Phase 13 stage plan** — never claimed by any stage, including Stage 4
even though every one of them calls a function Stage 4 itself converted:

- `src/app/api/billing/setup/confirm/route.ts`
- `src/app/api/platform/provision/route.ts`
- `src/app/api/platform/tenants/route.ts`
- `src/app/api/platform/tenants/check-slug/route.ts`
- `src/app/api/platform/tenants/[tenantId]/route.ts`
- `src/app/api/platform/tenants/[tenantId]/impersonate/route.ts`
- `src/app/api/platform/tenants/[tenantId]/rate/route.ts`
- `src/app/api/platform/tenants/[tenantId]/resend-admin-invite/route.ts`
- `src/app/api/platform/tenants/[tenantId]/resend-billing-link/route.ts`
- `src/app/api/platform/tenants/[tenantId]/retry-billing/route.ts`
- `src/app/api/platform/tenants/[tenantId]/setup-fee/route.ts`
- `src/app/api/webhooks/stripe/route.ts`
- `src/app/billing/setup/page.tsx`
- `src/app/platform/layout.tsx`
- `src/app/platform/page.tsx` (also missing `await` on the now-async call underneath — a second,
  compounding bug)
- `src/app/platform/provisioning/page.tsx` (same missing-`await` compounding bug)

**Why Stage 4 "done" didn't mean these routes/pages work:** Stage 4's charter (see its row above)
lists service files — `tenants.ts`, `provisioning.ts`, `requirements/templates.ts`,
`billing/{quantity-sync,worker,stripe-webhook}.ts` — never their callers. Every file in this list
calls one of those already-converted, already-`async`/`Db`-typed functions through the dead
`getRawDb()`, the exact bootstrap.ts/instrumentation.ts pattern (Stage 8a) at much larger scale:
the entire `/platform` UI and several billing/webhook routes have been non-functional since
Stage 1, and nothing in the stage plan ever claimed ownership of fixing that, because the plan
was written against service-file boundaries, not HTTP-reachability.

**Not fixed in this sweep — reconciliation, not conversion, per instruction.** Recommended
placement, for whoever plans the next stage: these are pure connective-tissue fixes (identical
shape to Stage 8a's `instrumentation.ts` and Stage 8b's two routes — swap `getRawDb`→`getDb`, add
`await`), not new conversion work, since every callee is already done. They don't obviously
belong to Stage 8c (exports) or Stage 9 (reports/search) by subject matter, and grouping them
under either would blur that stage's own scope. Options: (a) a dedicated slice before Stage 10,
(b) folded into Stage 10's cutover pass since Stage 10 already has to sweep the whole repo for
`better-sqlite3` references anyway. Left as an open call, not decided here.

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
- **Stage 6a's, 6b's, 7's, 8a's, 8b's, and 8c's own files are 100% clean** — `vendors.ts`, `resend-invite.ts`,
  `decision.ts`, `invite-token.ts`, `vendor-token.ts`, `vendor-fsm.ts`, `vendor-onboarding.ts`,
  `notifications/renewal.ts` (now converted in full, including `applyExpirationFlip`),
  `verification/run.ts`, `requirements/resolver.ts`, `requirements/re-eval.ts`,
  `services/requirements.ts`, `add-to-locations.ts`, `extractor.ts`, `retention/worker.ts`,
  `instrumentation.ts`, `notifications/{worker,digest,resend-webhook}.ts`,
  `services/manual-reminder.ts`, `exports/{content,audit-export,worker}.ts`,
  `workers/bootstrap.ts`, and every converted route/page checked directly.
- **44 pre-existing violations remain** (down from 142 after Stage 5, 101 after Stage 6b, 73
  after Stage 7, 70 after Stage 8a, 60 after Stage 8b, as each stage clears its own portion), all
  in NOT-yet-converted modules — `reports/*`, `search/search.ts` — or in pre-existing React
  client-component floating promises unrelated to this migration entirely.
  Left untouched — out of scope until those modules' own stages, flagged here so each stage
  clears its own portion rather than rediscovering this from scratch.

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
   application queries). Fixed: `chase.ts` (Stage 5), `notifications/renewal.ts`'s
   `scheduleRenewalReminders` (Stage 6b). **One remaining known spot** — `reports/builders.ts:84-91`
   (Stage 9, same shape as item 9 below). **The Stage 5 grep was not re-run after Stage 7/8 land —
   Stage 9 should re-grep before assuming this list is exhaustive.**
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
11. **`TenantDB.update()` can only express `col = val` equality WHERE predicates.** Anything
    needing `IS NULL`/`>`/`<` drops to the Kysely builder directly, manually re-adding the same
    tenant_id scoping `TenantDB` enforces internally. Found in Stage 6a's `issueInviteToken()`
    revoke query — likely to recur wherever a future stage needs a conditional bulk UPDATE.
12. **A jsonb column's WIRE shape can silently diverge from what a not-yet-converted consumer
    still expects.** `GET /api/vendors/:id` (Stage 6a) re-`JSON.stringify()`s `flags_json`/
    `evidence_json` at the response boundary specifically to preserve the string shape
    `src/app/vendors/[vendorId]/page.tsx` still `JSON.parse()`s — a temporary shim, remove it the
    moment that page converts (see Shortcuts & gaps).
13. **Inside `withTransaction()`, every nested DB call must take `trx`, never the outer
    `db`/`getDb()` handle.** SQLite's single connection made this an accidental non-issue;
    Kysely's separate connections make a stray outer-`db` call commit independently and survive
    a surrounding rollback — a correctness bug, not style. Caught in `confirmPasswordReset`
    (Stage 3) and `createVendorInvite`'s audit-log call (Stage 6a). Audited exhaustively across
    every `withTransaction(` call site through Stage 6a before that stage's commit — clean, one
    instance found and fixed, no others.
