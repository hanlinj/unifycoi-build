# UnifyCOI — Launch-Prep Audit

> Working document. Converts the honestly-disclosed-but-scattered set of known gaps (across
> Phases 1–10 checkpoints, commit messages, and code) into one actionable inventory. Written for
> future-me and a contractor, not for sales. **Underreporting is the failure mode — this errs long.**
>
> Generated end of Phase 10 (commit `0a3d418`, 677 tests green). Each item: **What · Source ·
> Current state · Trigger · Effort · Recommended approach.** Trigger vocabulary: *before first
> customer · before 5 · before 50 · if perf surfaces · customer-signal-only (never if not validated).*
> Effort: *trivial / small / medium / large.*

---

## Executive summary

**Item count by category**

| Category | Items |
|---|---:|
| Security & defensibility | 16 |
| Performance & scale | 10 |
| Operational | 13 |
| Feature completeness | 16 |
| Testing infrastructure | 6 |
| Patterns observed (meta) | 6 |
| **Total** | **67** |

**Top 5 priorities (all before first real customer)**

1. **No real email (ESP).** The Mailer is a logged no-op — *no vendor or admin email is ever actually sent.* The entire chase/notification/invite value proposition is invisible to real users until this lands. (SEC-1 / OPS-1)
2. **No password reset, no rate-limiting, no lockout.** Login is verify-only. A user who forgets a password cannot recover; the login endpoint has no brute-force protection. (SEC-8, SEC-9)
3. **No provisioning path for non-engineers.** The platform shell is API-only — a tenant, its locations, and its first Admin must be created via raw API calls/scripts. Fine for an engineer-run design partner; a blocker otherwise. (OPS-8)
4. **Retention marks only; no purge, no legal-hold, no offboard anchors.** 7-year marking works, but hard-delete, legal-hold override, and vendor-removal/tenant-offboard retention anchors are unbuilt — a problem the first time a customer (or regulator) asks to delete or preserve data. (SEC-3, SEC-4, SEC-5)
5. **Operational blind spots: single-instance workers, secrets in env, no error monitoring.** Running >1 app instance double-runs the digest/retention workers; keys live in env; nothing alerts on failures (including `export.sensitive_decrypt_failed`). (OPS-6, OPS-12, OPS-13, SEC-13)

**What the build IS ready for**

A **single design partner / pilot, engineer-provisioned, single app instance, modest scale** (tens of locations, hundreds of vendors). The core loop is complete and trustworthy end to end: invite → tokenized vendor upload (save-and-resume, image→PDF) → AI verification (Vision, forced structured output, deterministic rules engine, 9/9 eval) → Admin approve/reject/correct with required reasoning → exception-first Command Center + Manager Home → eager renewal/expiration chase → six reports (CSV/PDF) → defensible audit export (Sensitive opt-in, decrypt-proven). **Tenant isolation is structural, Sensitive data is encrypted at rest and never leaks in any surface/report/export by default (decrypt-proven, non-vacuous), and the audit trail is append-only and attributed.**

**What the build is NOT ready for**

Self-serve SaaS signup; horizontal/multi-instance scale; real email at volume; tenants needing data purge or legal hold; large orgs (1000s of locations — IN-list scope queries, single-file SQLite); mobile-field-heavy Store Manager usage (desktop-first, no responsive collapse despite MISSION's mobile-first intent for field roles); platform-staff self-service (no platform UI); multi-policy vendors (single COI track per vendor).

---

## Security & defensibility

### SEC-1 — No real ESP / email is never sent
- **What:** The Mailer is a logged no-op; notification rows are processed but no email leaves the system.
- **Source:** Phase 7 B/C (`51bcffb`, `2ea4347`), `src/lib/notifications/mailer.ts` (NoOpMailer).
- **Current state:** `queueNotification` writes rows; the worker "sends" via NoOpMailer which records what it *would* send. `notification.sent` audit fires. Branding/from-domain resolved but unused.
- **Trigger:** before first customer.
- **Effort:** medium.
- **Approach:** implement an ESP-backed Mailer (Postmark/SES) behind the existing `Mailer` interface; add SPF/DKIM + per-operator from-domain.

### SEC-2 — ESP idempotency key for the worker double-send window
- **What:** The send worker has a documented at-least-once window (crash between ESP send and the `sent` commit) that could double-send.
- **Source:** Phase 7 C (`2ea4347`), `src/lib/notifications/worker.ts`.
- **Current state:** claim-then-send makes it at-most-once in steady state; `notificationId` is already passed on send specifically to become the ESP idempotency key.
- **Trigger:** with SEC-1 / before 5.
- **Effort:** small.
- **Approach:** pass `notificationId` as the ESP idempotency key when SEC-1 lands.

### SEC-3 — Hard delete / purge not built
- **What:** Retention marks rows `purge_eligible` but never deletes them.
- **Source:** Phase 7 D (`d8f0839`), `src/lib/retention/worker.ts` ("v1 MARKS ONLY"), invariant #11.
- **Current state:** daily worker sets `purge_eligible`/`purge_eligible_at` + logs `retention.purge_eligible` past the 7-year horizon. No deletion job exists.
- **Trigger:** before 50 / first regulatory/customer deletion request.
- **Effort:** medium.
- **Approach:** a separate, deliberately-invoked, per-row-logged purge job consuming `purge_eligible` rows (keep it distinct and gated, per invariant #11).

### SEC-4 — Vendor-removal & tenant-offboard retention anchors not modeled
- **What:** No removal action / `offboarded_at`, so those inactive-point anchors never start the retention clock.
- **Source:** Phase 7 D (`d8f0839`, "DEFERRED").
- **Current state:** only `documents.superseded_at` and `audit_events.created_at` anchor retention.
- **Trigger:** before offboarding any tenant.
- **Effort:** medium.
- **Approach:** add removal/offboard lifecycle timestamps and wire them as retention anchors. (Note: the audit *export* already supports `tenant_offboard` from-inception — this is the retention side.)

### SEC-5 — Legal-hold / purge override not built
- **What:** No way to suppress purge-eligibility for data under legal hold.
- **Source:** Phase 7 D (brief deferral).
- **Trigger:** before 50 / first legal hold.
- **Effort:** medium.
- **Approach:** a hold flag (tenant/vendor/document grain) that excludes rows from purge marking + an audited place/release action.

### SEC-6 — Per-jurisdiction + shorter Sensitive-field retention deferred
- **What:** One flat 7-year horizon; no shorter Sensitive-field schedule or per-jurisdiction variation.
- **Source:** Phase 7 D (brief deferral).
- **Trigger:** before 50.
- **Effort:** medium.

### SEC-7 — Downloads stream through the app server (no presigned URLs)
- **What:** Report/export/document downloads are read from BlobStore and streamed by the app, not via short-lived presigned B2 URLs.
- **Source:** Phase 9 C/D download routes; kickoff example list.
- **Current state:** `getBlobStore().get()` → decrypt → stream in the request handler.
- **Trigger:** if perf surfaces / before 50.
- **Effort:** small–medium.
- **Approach:** issue short-lived presigned URLs (note: app-side envelope encryption means the app must still decrypt — either decrypt-then-presign a temp object or keep streaming for Sensitive artifacts).

### SEC-8 — No password reset / signup / account recovery
- **What:** Login is verify-only; no self-service password reset or recovery.
- **Source:** Phase 10 A-prime (`b975dbe`), banked.
- **Trigger:** before first customer (operational necessity).
- **Effort:** medium.
- **Approach:** emailed reset-token flow (depends on SEC-1).

### SEC-9 — No login rate-limiting / lockout / brute-force protection
- **What:** The login endpoint accepts unlimited attempts.
- **Source:** Phase 10 A-prime, banked.
- **Trigger:** before first customer / any public exposure.
- **Effort:** small–medium.
- **Approach:** per-IP + per-email attempt throttle with backoff/lockout.

### SEC-10 — Middleware route guard is presence-only
- **What:** The edge guard checks only that the session cookie *exists*, not that the JWT is valid.
- **Source:** Phase 10 B (`3a46501`), `src/middleware.ts`.
- **Current state:** full verification happens at `getAuth` (page/API), so an expired/forged cookie passes the guard but is rejected downstream (page redirects to `/`).
- **Trigger:** acceptable v1; revisit before 50.
- **Effort:** small.
- **Approach:** verify with an edge-compatible JWT lib (`jose`) in middleware.

### SEC-11 — Multi-tenant email ambiguity at login
- **What:** If the same email+password existed in two tenants, the first match wins.
- **Source:** Phase 10 A-prime, `loginResolvingTenant`.
- **Trigger:** before a user legitimately belongs to two tenants.
- **Effort:** small.
- **Approach:** tenant chooser when an email resolves to multiple tenant users.

### SEC-12 — No CSRF protection on cookie-authed mutations *(discovered during audit)*
- **What:** State-changing POSTs/PATCHes authenticate via the `uc_session` cookie; protection relies solely on `SameSite=Lax`.
- **Source:** discovered; Phase 10 A-prime cookie design.
- **Current state:** `SameSite=Lax` blocks cross-site form POSTs in modern browsers, but there is no anti-CSRF token or explicit `Origin` check.
- **Trigger:** before first customer / public exposure.
- **Effort:** small.
- **Approach:** double-submit CSRF token or server-side `Origin`/`Sec-Fetch-Site` verification on mutations.

### SEC-13 — No key rotation; keys in env *(discovered during audit)*
- **What:** `MASTER_KEK` and `FIELD_ENCRYPTION_KEY` are single static env values with no versioning/rotation.
- **Source:** Phase 1 (`c7a33e9`), envelope + field encryption.
- **Trigger:** before 50 / security review.
- **Effort:** medium.
- **Approach:** key-version tags on encrypted blobs/fields + a rotation procedure; move keys to a secret manager (see OPS-13).

### SEC-14 — No Admin Sensitive-reveal path in UI *(documented, by design — not a gap)*
- **What:** Full TIN/ACH are never shown in any UI; retrieval requires an audit export with `includes_sensitive=true` + reason.
- **Source:** invariant #8; Phase 6/7/9.
- **Note:** intentional. Flag for security reviewers so the absence reads as design, not omission.

### SEC-15 — Per-evaluation audit at parent grain *(documented, accepted — not a gap)*
- **What:** Per-requirement findings live in the immutable `requirement_evaluations` table with a run-level `ai.recommendation` event, rather than one audit row per finding.
- **Source:** Phase 7 A (`f65e54f`), Q2 decision.
- **Note:** accepted as final; mention only if a defensibility review expects per-finding audit rows.

### SEC-16 — Sensitive decrypt-failure is logged but not alerted
- **What:** `export.sensitive_decrypt_failed` records that ciphertext was unreadable, but nothing notifies an operator.
- **Source:** Phase 9 F (`5bbb95e`).
- **Trigger:** before 5 (an unreadable Sensitive value means key/data corruption — you want to know immediately).
- **Effort:** small.
- **Approach:** route the event to ops alerting (also OPS-5).

---

## Performance & scale

### PERF-1 — CSV built as a single in-memory string (no streaming)
- **What:** Reports and audit exports serialize the whole CSV in memory.
- **Source:** Phase 9 C/E, `src/lib/reports/csv.ts` ("Built as a single string for v1").
- **Trigger:** if a report/export exceeds ~10K rows / before 50.
- **Effort:** small.
- **Approach:** stream rows to the response/blob.

### PERF-2 — Name search is in-process substring (no FTS5)
- **What:** Vendor/location search normalizes + substring-matches in JS.
- **Source:** Phase 8 B / Phase 10 A; `vendor-name.ts`, `location-name.ts` (swappable interfaces).
- **Trigger:** if search is slow at scale / before 50.
- **Effort:** medium.
- **Approach:** SQLite FTS5 behind the existing `VendorNameMatcher`/`LocationNameMatcher` seam (the interface was built for exactly this swap).

### PERF-3 — Compliance-posture trend is Option A (no historical reconstruction)
- **What:** Report #1's trend is event-activity per month + a current snapshot, not a true historical posture curve.
- **Source:** Phase 9 B (`30d3fe5`), `builders.ts`.
- **Trigger:** customer wants a real historical compliance-over-time curve.
- **Effort:** medium.
- **Approach:** a daily posture-snapshot table (Option B) appended over time.

### PERF-4 — IN-list scope queries
- **What:** Scope-clamped queries build `IN (?, ?, …)` placeholder lists from the caller's location set.
- **Source:** `lib/reports`, `lib/services/locations.ts`, `lib/services/users.ts`.
- **Current state:** fine at v1 store counts; a 1000+-location org risks SQLite parameter limits and slow plans.
- **Trigger:** before 50 / large org.
- **Effort:** small–medium.
- **Approach:** temp-table join or chunked IN-lists.

### PERF-5 — recentlyViewed does N per-entity lookups
- **What:** Empty-query search resolves each recently-viewed id with its own query.
- **Source:** Phase 10 A, `search.ts`.
- **Current state:** bounded to ≤8 entries; negligible.
- **Trigger:** never unless the cap is raised.
- **Effort:** trivial.

### PERF-6 — Per-row enrichment in user management
- **What:** `usersForManagement` and the requirements "set by" name map resolve per-row (and the latter via a client `/api/users` fetch).
- **Source:** Phase 10 F/G.
- **Trigger:** large user lists.
- **Effort:** small.
- **Approach:** batch joins.

### PERF-7 — AppShell fetches `/api/auth/me` per navigation
- **What:** The chrome re-fetches identity/role on each chrome route, uncached.
- **Source:** Phase 10 B, `AppShell.tsx`.
- **Trigger:** minor; before-50 polish.
- **Effort:** small.
- **Approach:** server-resolved shell via a `(app)` route-group layout, or cache `me`.

### PERF-8 — Single-file SQLite (single writer, no horizontal scale)
- **What:** better-sqlite3 on one file; one writer, no replication.
- **Source:** Phase 1 (`c7a33e9`).
- **Trigger:** before 50 / multi-instance.
- **Effort:** large.
- **Approach:** migrate to Postgres — the raw-SQL + `TenantDB` injection seam eases this, but it is a real port.

### PERF-9 — In-process workers tie throughput to one node
- **What:** Notification/digest/retention/export workers run inside the app process.
- **Source:** Phase 7 closing (`5b73a84`); see OPS-6.
- **Trigger:** before scaling horizontally.
- **Effort:** medium (covered in OPS-6).

### PERF-10 — Generated report/export blobs accumulate with no cleanup *(discovered during audit)*
- **What:** Every on-demand report/export generation persists an encrypted blob; nothing prunes them.
- **Source:** Phase 9 C/D, report + export routes.
- **Current state:** files are self-describing + regenerable + audited, but storage grows unbounded.
- **Trigger:** storage growth / before 50.
- **Effort:** small.
- **Approach:** a retention sweep for stale generated report/export blobs (the report ones especially are ephemeral).

---

## Operational

### OPS-1 — Real ESP integration (see SEC-1)
- Cross-listed: operationally, nothing actually emails until this lands. **before first customer / medium.**

### OPS-2 — Scheduled / recurring report + export delivery
- **What:** Reports/exports are on-demand only; no scheduled digest delivery of them.
- **Source:** Phase 9 deferrals.
- **Trigger:** customer-signal. **Effort:** medium.

### OPS-3 — No alerting on worker/system failures
- **What:** Worker failures (`notification.failed`, `export.failed`, `export.sensitive_decrypt_failed`) and digest misfires are logged but not surfaced to an operator.
- **Source:** Phase 7/9.
- **Trigger:** before 5. **Effort:** small–medium.
- **Approach:** route failure events to ops alerting + a minimal queue-health view.

### OPS-4 — Retention sweep for stale generated blobs (see PERF-10)
- **before 50 / small.**

### OPS-5 — No worker observability (queue depth, throughput, digest firing)
- **Source:** Phase 7. **Trigger:** before 5. **Effort:** medium.
- **Approach:** metrics on queue depth, send/failure counts, last-digest-per-tenant.

### OPS-6 — Single-instance worker model
- **What:** `instrumentation.register()` starts all workers in-process; running >1 app instance double-runs the **digest** and **retention** cycles (the notification + export workers are claim-guarded, but digest/retention are not leader-elected).
- **Source:** Phase 7 closing (`5b73a84`), `src/lib/workers/bootstrap.ts`.
- **Trigger:** before any horizontal scaling.
- **Effort:** medium.
- **Approach:** leader election or extract workers to a single dedicated process / real queue.

### OPS-7 — Timezone must be set at provisioning
- **What:** Digest fires on tenant-local hour; null/invalid `timezone` falls back to UTC (logged).
- **Source:** Phase 7 B (`51bcffb`), Phase 7 closing.
- **Trigger:** before first customer (set tz at provisioning). **Effort:** trivial.

### OPS-8 — No provisioning / platform admin UI
- **What:** The platform shell (fleet/tenants, provisioning, bulk import, billing, support/impersonation) is API-only; `/platform` is a placeholder.
- **Source:** Phase 10 B (`3a46501`), `src/app/platform/page.tsx`.
- **Current state:** platform APIs (`/api/platform/*`) exist and work; no UI.
- **Trigger:** before first customer (someone must provision; an engineer can via API for a design partner).
- **Effort:** large (full shell) / small (rely on API + scripts for a pilot).
- **Approach:** build the platform shell when moving beyond engineer-run provisioning.

### OPS-9 — Org Settings UI not built
- **What:** Admins can't edit org name/branding/approval routing/notification defaults via UI.
- **Source:** Phase 10 (Path C deferral), `Client_Org_Settings.md`.
- **Current state:** tenant name/billing-rate editable via API (`tenant.settings_changed` audited); no UI.
- **Trigger:** before 5. **Effort:** medium.

### OPS-10 — Billing is manual
- **What:** Location-count × $90 is computed/snapshotted but billing is a manual reference.
- **Source:** Platform Systems & Tenancy spec; billing snapshots (Phase 2/7).
- **Trigger:** before 5. **Effort:** medium.

### OPS-11 — Impersonation flow has no UI
- **What:** The token model carries `impersonatedBy` and `getMeInfo` handles it, but there's no platform "impersonate" action or the persistent banner the spec requires.
- **Source:** Phase 2 / Phase 10; Navigation + Platform Systems specs.
- **Trigger:** before support needs to enter a tenant. **Effort:** medium.

### OPS-12 — No error monitoring / structured logging *(discovered during audit)*
- **What:** Beyond `/api/health` and `console`-level logging, there is no error tracking or structured logs.
- **Source:** Phase 1.
- **Trigger:** before first customer. **Effort:** small–medium.
- **Approach:** Sentry-style error capture + structured request logging.

### OPS-13 — Secrets in env, no secret manager *(discovered during audit)*
- **What:** KEKs, field key, JWT secret, B2 creds all from env vars.
- **Source:** Phase 1.
- **Trigger:** before first customer. **Effort:** small.
- **Approach:** secret manager (and pair with SEC-13 rotation).

---

## Feature completeness

### FEAT-1 — Requirement rule removal not built (tombstone, not DELETE)
- **What:** Requirements are supersede-only; an Admin can change a value but cannot revert a scope back to its parent (e.g., remove a trade override so org base applies again).
- **Source:** Phase 10 F (`5e7ea5d`), spec deviation; Phase 3 supersede model.
- **Current state:** `setRequirementRule` appends; the resolver reads latest-per-key. No DELETE / `requirement.removed`.
- **Trigger:** customer-signal.
- **Effort:** medium.
- **Approach:** **tombstone pattern** — a "deferral marker" rule row that the resolver treats as "fall through to parent," keeping the append-only model intact. Do *not* hard-DELETE rows (would break the audit/resolver history). (Phase 11+.)

### FEAT-2 — Role change in user edit not built
- **What:** `UpdateUserInput` has no `role`; edit covers status + scope only.
- **Source:** Phase 10 G (`f568c59`), banked.
- **Trigger:** customer-signal. **Effort:** small.
- **Approach:** add `role` to `UpdateUserInput` + a confirm flow; re-check the last-Admin guard on role demotion.

### FEAT-3 — User Title field not built
- **What:** Spec lists an optional Title (e.g., "Assistant Manager"); `createUser` has no such field.
- **Source:** Phase 10 G; `User_Management.md`.
- **Trigger:** customer-signal. **Effort:** trivial.

### FEAT-4 — No reason field on user mutations
- **What:** Create/update/invite user write no reason.
- **Source:** Phase 10 G, banked. **Framing:** `Audit_Trail` does *not* require reason for user mutations; the kickoff over-specified it by reflex from the requirements-change pattern.
- **Trigger:** if a defensibility review asks. **Effort:** small.

### FEAT-5 — Single COI track per vendor (no multi-policy chase)
- **What:** Chase + roster track the earliest expiry per vendor, not per-policy.
- **Source:** Phase 7 / Phase 9 B (#2).
- **Trigger:** vendors with multiple policies expiring on different dates.
- **Effort:** large.
- **Approach:** per-policy expiry tracks + per-track ladders.

### FEAT-6 — No structured lapse-recovery flow
- **What:** Day-0 expired flip + imminent alerts exist, but there's no guided "vendor lapsed → recovery" workflow.
- **Source:** Phase 8 E scope.
- **Trigger:** customer-signal. **Effort:** medium.

### FEAT-7 — No Vendors directory page
- **What:** Vendors are reachable only via Search + drill-in (and from Command Center/Reports/Location records).
- **Source:** Phase 10 B (per Navigation.md — no Vendors sidebar entry by design, but no directory page exists either).
- **Trigger:** customer-signal. **Effort:** small.

### FEAT-8 — Six fixed reports, no custom report builder
- **Source:** Phase 9. **Trigger:** customer-signal (likely never for v1 segment). **Effort:** large.

### FEAT-9 — Email-only notifications (no SMS)
- **Source:** invariant #9. **Trigger:** customer-signal. **Effort:** medium.

### FEAT-10 — Desktop-first; no responsive/mobile layouts
- **What:** Fixed 220px sidebar, no drawer/collapse; tables not mobile-optimized.
- **Source:** Phase 10 B (banked).
- **Note:** **tension with MISSION** — which calls for mobile-first for the field roles (Store Managers, vendors). The *vendor* token flow is mobile-first (Phase 5); the internal Store Manager surfaces are not.
- **Trigger:** before field-heavy Store Manager usage. **Effort:** medium.

### FEAT-11 — Approval routing options not built
- **What:** All Admins share one approval queue; no route-by-region/assignee.
- **Source:** `Client_Org_Settings.md` (default-confirmed). **Trigger:** customer-signal. **Effort:** medium.

### FEAT-12 — Per-user notification opt-outs not built
- **Source:** `Client_Org_Settings.md` open question. **Trigger:** customer-signal. **Effort:** small.

### FEAT-13 — Branding scope limited to operator name
- **What:** Vendor-facing email From uses the operator name; no logo/portal branding.
- **Source:** Phase 7; `Client_Org_Settings.md` open question. **Trigger:** customer-signal. **Effort:** small.

### FEAT-14 — Platform template updates don't auto-push to tenants
- **What:** Default (confirmed) no auto-push; platform applies deliberately.
- **Source:** `Requirements_Configuration.md`. **Trigger:** customer-signal. **Effort:** medium.

### FEAT-15 — Client mutations full-page reload instead of router invalidation *(discovered during audit)*
- **What:** DecisionPanel and several Phase 10 client forms call `window.location.reload()` / full navigation on success.
- **Source:** Phase 6 (`653b9a3`, DecisionPanel note), Phase 10 F/G/C.
- **Trigger:** UX polish / before 50. **Effort:** small.
- **Approach:** `router.refresh()` / optimistic updates.

### FEAT-16 — No Admin "Operations" sidebar entry *(discovered during audit)*
- **What:** Navigation.md lists Operations (Manager Home) as a secondary Admin entry (open question); the built Admin sidebar omits it, so Admins reach `/dashboard` only by URL.
- **Source:** Phase 10 B; `Navigation.md` open question.
- **Trigger:** if Admins want the operational view in-nav. **Effort:** trivial.

---

## Testing infrastructure

### TEST-1 — No React render harness for pages/components
- **What:** Pages/components are largely untested at render level; logic is extracted to pure functions + API handlers which *are* tested.
- **Source:** every phase ("no render harness"); Phase 10 D added one `renderToStaticMarkup` test + enabled `jsx` in jest.
- **Trigger:** before 50 / before heavy UI work. **Effort:** medium.
- **Approach:** React Testing Library + jsdom environment.

### TEST-2 — No true cross-process / session-boundary tests
- **What:** Workers + FSM + save-and-resume are tested in-process (the "no client storage" proof is architectural, not a real second process).
- **Source:** Phase 5 (`a3abb83`), Phase 7.
- **Trigger:** before 50. **Effort:** medium.

### TEST-3 — No end-to-end browser tests
- **What:** Nothing drives the real app over HTTP (login → nav → invite → approve). Landing/middleware/chrome are tested via mocks, `redirect()` digests, and isolated `renderToStaticMarkup`.
- **Source:** Phase 10 B/D (faithful substitutes, noted).
- **Trigger:** before 50 / before self-serve. **Effort:** medium.
- **Approach:** Playwright against a seeded dev server.

### TEST-4 — Vision extraction has no continuous eval / drift regression
- **What:** The engine was validated 9/9 on a fixture dataset with one live run; no ongoing eval on model upgrades.
- **Source:** Phase 4 (`23e8f18`, `c8ffa81`).
- **Trigger:** before 50 / on any model upgrade. **Effort:** medium.
- **Approach:** a scheduled eval harness with the labeled dataset + a pass threshold gate.

### TEST-5 — No load / performance tests *(discovered during audit)*
- **Source:** discovered. **Trigger:** if perf surfaces. **Effort:** medium.

### TEST-6 — Page-level behaviors tested via substitutes, not real integration *(discovered during audit)*
- **What:** Middleware matcher tested by reconstructing the regex; landing via `redirect()` digest; chrome leak via isolated AppShell render. Faithful, but not Next's real request pipeline.
- **Source:** Phase 10 B/D.
- **Trigger:** subsumed by TEST-3 (Playwright). **Effort:** see TEST-3.

---

## Patterns observed across the build (meta — insights, not items to fix)

### PATTERN-1 — Integration sweeps catch silent-rejection bugs
The Phase 10 consolidated sweep found that `POST /api/vendors/invite` returned 403 on an out-of-scope location but logged **no** `security.scope_violation` (`0a3d418`) — invisible to every per-feature test, surfaced only by the cross-cutting sweep. Same class as the Phase 7 audit-coverage meta-note (unreasoned precedence change, fixed in Phase 10 F). **Lesson:** every scope-checked mutation needs an explicit "and it logs the violation" assertion; a recurring coverage pass should specifically target mutation endpoints with silent-403 / optional-reason paths.

### PATTERN-2 — The agent optimizes for the green check unless the honesty contract is explicit
Repeatedly, the faithful move was to **fix the code, not weaken the test**: the trade-enum unification added `roofing` to the enum rather than editing the test that used it (`f568c59`); the precedence reason gap was closed rather than asserted-around (`5e7ea5d`); the last-Admin guard was added (`3a46501`). Each happened *because* the contract's "diagnose, don't weaken; STOP and ask" was front-loaded. **Lesson:** keep the honesty contract explicit and early in every kickoff — it is load-bearing, not ceremonial.

### PATTERN-3 — "No new backend" instructions collide with kickoff feature lists
A UI phase over an API-only system repeatedly hit features the backend didn't support (reason on user mutations, role-change-in-edit, precedence reason, scope-violation logging on invite, current-tenant name for the header). Resolution required per-item judgment: fix small invariant/audit gaps inline; defer genuine features. **Lesson:** budget for small backend touches whenever building UI over an existing API, and decide up front which gaps are "invariant" (fix now) vs "feature" (defer).

### PATTERN-4 — Defensibility "absence" tests are vacuous without a positive control
pdf-lib Flate-compresses + hex-encodes content, so a naive raw-byte Sensitive scan passes vacuously. The build standardized **decompress + hex-decode + decrypt-proven-present + positive control** (Phase 9 C), and reused the exact pattern for the chrome-leak scan (Phase 10 D). **Lesson:** every "X is absent" assertion must be paired with a control proving X *would* be detected if present.

### PATTERN-5 — Spec-vs-kickoff divergences are frequent, and the spec wins
District export (Phase 9), Location Record invite roles (Phase 8), `vendor.submitted` → digest (Phase 7), the canonical sidebar set (Phase 10). The kickoff is a plan; the spec doc is authority. **Lesson:** read the per-surface spec before coding and flag divergences rather than silently following the kickoff.

### PATTERN-6 — Backend-complete ≠ usable product
Phases 1–9 built a complete, tested API + a handful of read pages. Phase 10 discovered there was **no login, no nav shell, no config UIs, and no platform shell** — the system couldn't be used in a browser at all. **Lesson:** schedule a "navigable product" milestone early; don't let "the API works" stand in for "a person can use it." This audit exists partly because that milestone came last.

---

## Appendix — what is genuinely solid (so it isn't re-litigated)

- **Tenant isolation** is structural (`TenantDB` injects `tenant_id`; cross-tenant zero-row proven non-vacuously across surfaces).
- **Sensitive data** is encrypted at rest (field-level + envelope) and never leaks in any UI, report, or export by default — proven by decrypt-then-scan tests with positive controls, plus the opt-in *inverse* assertion.
- **Audit trail** is append-only, attributed, tenant-isolated, Sensitive-redacted; coverage was explicitly audited (Phase 7 A, `docs/audit-coverage.md`).
- **The core compliance loop** works end to end and is the product's reason to exist.
- **Worker safety** (claim-then-send/generate, stale reclaim, idempotency) is real and tested.
- **The swap seams** (`Mailer`, `BlobStore`, `VendorNameMatcher`/`LocationNameMatcher`) are in place so the biggest deferrals (ESP, FTS5) are implementation swaps, not rewrites.
