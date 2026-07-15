# Gate 2 — Admin review workbench + document-targeted correction — 🟡 IN PROGRESS (landing gate not built, 2026-07-15)

Read-only handoff doc — written to let a fresh session resume with zero context loss. No code
changed to produce this file. "Gate 2" is this codebase's own informal name for this arc (see the
code comments it already cites, e.g. `src/app/vendors/[vendorId]/page.tsx`,
`src/app/api/vendors/[id]/documents/[documentId]/route.ts`) — it isn't a numbered Phase in
`docs/decisions.md`'s ADR sequence (that sequence stops at Phase 13, the Postgres migration,
tracked in `docs/phase-13-postgres-migration.md`). This doc follows that same tracking-doc
convention (stage table + commit hashes + an open ledger) for Gate 2, which has never had one
until now.

**Where this sits in the bigger picture:** Gate 1 (not detailed here) is vendor onboarding +
background AI verification. Gate 2 is the Admin's review surface on top of that — the compliance
grid, the Unify Review summary, per-location decisions, and (still incomplete) the
document-targeted correction/resend loop. The single biggest thing a fresh session needs to know:
**the correction loop is not closed** — see the dedicated section below before touching anything
correction-related.

## Stage-by-stage — what shipped, in commit order

| Commit | Date | What |
|---|---|---|
| `030e28f` | 2026-07-13 | Background verification via a `verification_jobs` queue + worker — decouples Vision extraction/`runVerification()` from the vendor's upload/submit request path (migration `002_verification_jobs.ts`). |
| `c42770b` | 2026-07-13 | Admin compliance grid (Stage 1 of the 4-stage workbench) — `computeComplianceGrid()`, a read-time recompute over the stored extraction bundle that surfaces PASSING rows too (`requirement_evaluations` only ever persisted exceptions); read-only, no writes. |
| `c23e731` | 2026-07-13 | Unify Review summary (Stage 2) — plain-language recap generated FROM the grid's own pass/gap data, never a fresh AI call, so it can't contradict the grid. Recommends; the admin decides. |
| `a23d094` | 2026-07-13 | Admin document viewer (Stage 3) — accordion PDF viewer, admin-only decrypt-and-serve route, per-view/per-reveal audit logging, Sensitive fields masked by default, store-manager sessions 403. |
| `dd2ee3b` | 2026-07-13 | Decision panel placement (Stage 4) — reordered the workbench to read top-to-bottom: Unify Review → grid → documents → decision panel. Pure layout, no logic change. |
| `2a92d64` | 2026-07-14 | Visual restyle pass 1 — Unify Review callout, humanized grid labels (`requirement-labels.ts`), per-location pills, collapsible facilities, colored document/decision pills, full-PDF viewer, a click-to-copy audit fix. |
| `52f46ba` | 2026-07-14 | Visual polish pass 2 — Unify Review tag wording, location box styling/spacing, soft-pastel decision buttons (the color tokens later reused for per-location Approve/Reject). |
| `01a41d0` | 2026-07-14 | Replaced the native `<iframe>` PDF embed with an in-app PDF.js renderer (`PdfViewer.tsx`) — continuous vertical scroll, all pages, identical across browsers. Worker file copied to `/public/pdf.worker.min.mjs` by `scripts/copy-pdf-worker.js` on every `npm install` (gitignored, regenerated). See the middleware gap in the open ledger below — this is where it originates. |
| `5d4ac8e` | 2026-07-14 | Per-location Request Correction, stage one — scoped `request_correction` to explicit `location_ids` instead of sweeping every under-review location. **Superseded by the next row** — this turned out to be the wrong model. |
| `6f16a2a` | 2026-07-14 | **Reverted** `5d4ac8e` — correction is vendor-level, not per-location, because documents (and thus what a correction is actually about) are vendor-wide, not per-site. The revert also fixed a live regression the per-location scoping had introduced: the API required non-empty `location_ids` for every action while the decision panel always sent `[]` for `request_correction`, so every correction click 400'd in production. |
| `aa3ace5` | 2026-07-14 | Fixed `scripts/dev-seed.ts`'s wipe-and-reseed: wrapped the whole wipe in one transaction (a mid-wipe failure previously left `vendor_locations`/`documents` empty tenant-wide while `vendors` itself survived — this happened for real mid-session and was the trigger for this fix) and added `verification_jobs` + `password_reset_tokens` to the delete order (both missing, both would have hit the identical failure mode). |
| `da4d5ab` | 2026-07-14 | Generalized document supersession to all three doc types (coi/w9/ach) via `supersedePriorDocument()` in `src/lib/notifications/renewal.ts`, called from the verification worker's per-document loop (not the upload route — preserves COI's bounce-before-supersede invariant). Made `loadExtractionBundle()`'s document query deterministic (`ORDER BY uploaded_at ASC`) so it can never pick ambiguously between two active rows of the same type. This is the foundation the document-flag spine (next row) sits on. |
| `008a5d3` | 2026-07-14 | The document-flag spine, data layer only — migration `003_document_flag_note.ts` (adds `documents.flag_note`, nullable text) + `src/lib/documents/flags.ts` (`flagDocumentsForReplacement()`, `getFlaggedDocuments()`). The flag itself is a new `documents.state` value (`'correction_requested'`, exported as `FLAGGED_STATE`) — no migration needed for that, `state` has no CHECK constraint. `supersedePriorDocument()` (previous row) was widened to treat `state IN ('active', FLAGGED_STATE)` as a valid "prior" document, which is the entire auto-clear mechanism — no separate unflag code path exists. |
| `539c3cb` | 2026-07-14 | The "Request more info" admin panel (`RequestMoreInfoPanel.tsx`) — the writer for the flag spine. Document picker (type-label pills, never filenames), 4 preset reason chips + editable note, calls the existing `request_correction` decision action with `doc_types` + the shared note. `decision.ts`'s `request_correction` branch now optionally flags the selected `docTypes` with the note, reusing the exact same vendor-locations sweep + invite + email it already had. Old per-location "Request Correction" button removed from `DecisionPanel.tsx`. |
| `31fb8ad` | 2026-07-15 | Per-location decision UI — Approve/Reject moved into each location's box in the compliance grid (scoped to that `location_id` only), a green-check/red-marker header replaces the Pass/Warnings pills once a location is decided (never hidden), an "Approve all passing (N)" shortcut that only ever includes zero-warning under-review locations. Deleted the now-fully-orphaned `Workbench.tsx`, `DecisionPanel.tsx`, `UncertaintyRow.tsx` (the old vendor-level decision panel and the per-line-item "Needs Your Review" Accept/Treat-as-deficient block). |
| `7d68fa6` | 2026-07-15 | Three display fixes: (1) "Approved by" showed a raw user UUID — now joined to `users`, graceful "Unknown user" fallback; (2) column renamed to "Decided by", now populated for declines too (sourced from the location's own `vendor.declined` audit event, not a new column — see Locked decisions); (3) Unify Review summary no longer repeats a vendor-wide deficiency once per location — groups by `requirementKey` first, names vendor-wide gaps once with a scope note, names location-specific gaps with their location(s). |

Everything from `030e28f` through `7d68fa6` is pushed to `origin/main`. No PRs — direct-to-main
throughout, per how this repo has been worked.

## Migrations — and their prod status

**⚠ Railway does NOT auto-run migrations on deploy.** Every migration landed in this arc had to be
applied to prod by hand, deliberately, as its own step — pushing the commit does *not* make the
schema change live. This will keep being true for every future migration; don't assume otherwise.

| Migration | Adds | Prod status |
|---|---|---|
| `002_verification_jobs.ts` (`030e28f`) | `verification_jobs` table (the background-verification queue) | ✅ Applied manually to prod, confirmed via `_migrations` ledger. |
| `003_document_flag_note.ts` (`008a5d3`) | `documents.flag_note` (nullable text) | ✅ Applied manually to prod, confirmed via `_migrations` ledger and a direct `\d documents` check against the prod DB. |

**How it was actually done, for the next one:** `DATABASE_URL="<railway-public-proxy-connection-string>" npm run migrate` — run from a dev box, pointed at Railway's **public/proxy** Postgres connection string (not the `*.railway.internal` private one, which only resolves inside Railway's own network). The `migrate` script (`dotenv -- tsx src/lib/db/migrate.ts`) uses `dotenv-cli`, which does **not** override an already-set `DATABASE_URL` by default (confirmed from its own docs — override needs an explicit `-o` flag this script doesn't pass), so a manually-exported `DATABASE_URL` safely wins over whatever's in the local `.env`. Get the public connection string from the Railway dashboard → the Postgres plugin service (not the web/app service) → Connect tab → Public Network. Verify with `psql "<public-conn-string>" -c "SELECT name, applied_at FROM _migrations WHERE name = '<file>.ts';"`.

## The correction/resend feature — exact current state (read this before touching anything here)

**Model, locked:** correction is **vendor-level and document-targeted**, not per-location. This
was tried the other way (`5d4ac8e`) and reverted (`6f16a2a`) — documents are vendor-wide (one COI
covers every location), so "which locations does this apply to" was never the right question. The
right question is "which *document(s)* need to be resent."

**What works today, verified live:**
- The admin opens **Request More Info** (next to Documents on File — vendor-level, not per-location,
  and deliberately not inside any per-location decision UI), picks one or more documents by type
  (COI/W-9/"Payment info" — a pill + label, filenames never shown, verified via the RSC payload
  itself, not just the DOM), picks a preset or writes a note (one shared note per request,
  regardless of how many documents are selected), and sends.
- That call flags each selected document: `documents.state` → `'correction_requested'`
  (`FLAGGED_STATE` in `src/lib/documents/flags.ts`), `documents.flag_note` → the note. Verified:
  `getFlaggedDocuments()` returns exactly the flagged doc(s) with the note; unselected documents
  are untouched.
- The **same** vendor-level correction invite + email that already existed fires — no new email
  path was built. `decision.ts`'s `request_correction` reuses the existing vendor-locations sweep,
  invite issuance, and notification insert; `doc_types` + the note just ride along. The email body
  **does carry the note** today, via the pre-existing `correctionLine = reason || deficientList`
  mechanism in `src/lib/notifications/worker.ts`'s `renderEmail()` — confirmed live by pulling a
  real persisted notification payload and running it through the actual (temporarily exported,
  then reverted) `renderEmail()`.
- The flag **auto-clears on supersession**, with no separate "unflag" code path: when a
  replacement document is uploaded and the verification worker's per-document loop runs
  `supersedePriorDocument()` (`src/lib/notifications/renewal.ts`), the query matches
  `state IN ('active', 'correction_requested')` — so a flagged row is a valid supersession target.
  Once superseded (`superseded_by` set), it drops out of `getFlaggedDocuments()`'s result (which
  requires `superseded_by IS NULL`), even though the old row's own `state`/`flag_note` are left
  untouched as a historical record. The new document is always inserted `state: 'active'` by the
  upload route, so it never carries the flag forward. Verified live end-to-end: flag → replace →
  confirmed `getFlaggedDocuments()` back to empty.

**What does NOT work — the loop is not closed:** `src/app/v/[token]/page.tsx`'s landing gate:

```ts
const hasRun = !!(await tdb.get<{ id: string }>(
  `SELECT id FROM verification_runs WHERE tenant_id = $1 AND vendor_id = $2 LIMIT 1`,
  [invite.vendor_id]
));
if (hasRun) {
  return <SubmittedPage vendorName={vendor.business_name} />;
}
```

This checks only "has this vendor *ever* had any verification run" — no check of invite purpose,
no check of open corrections, no awareness of `getFlaggedDocuments()` at all. **Any vendor who has
ever submitted once gets bounced to "Documents submitted" on every subsequent visit, including via
a correction invite link.** The admin can flag a document, write a note, and the vendor gets a real
email with a real link — and clicking that link bounces them to a terminal "already submitted"
page. No vendor can currently act on a correction. **This is next up** — the landing gate needs to
read `getFlaggedDocuments()` (or equivalent) and, when there's an open flag, show an upload form
scoped to the flagged document type(s) instead of bouncing. The upload route itself
(`/api/v/[token]/documents`) and submit route need no changes for this — they already accept a
replacement of any type and the worker already re-verifies vendor-wide on any submit.

## Open ledger

- **The landing gate (above) — next up.** Scope: make `/v/[token]` check for open document flags
  and render a scoped upload form instead of unconditionally bouncing on `hasRun`. Everything else
  in the resend loop is already built and verified; this is the one missing piece.
- **Orphaned backend code, not deleted (flagged per instruction when found, `31fb8ad`):**
  `POST /api/vendors/:id/evaluations/:evalId/accept`
  (`src/app/api/vendors/[id]/evaluations/[evalId]/accept/route.ts`) and
  `acceptUncertainEvaluation()` (`src/lib/services/decision.ts`) — nothing calls either anymore
  now that `UncertaintyRow.tsx`/`Workbench.tsx` (the old "Needs Your Review" per-line-item
  Accept/Treat-as-deficient block) are deleted. Confirmed via grep: the route is the only caller
  of the service function, and nothing in the frontend calls the route. Left in place — say the
  word if/when to remove.
- **Seed-data key mismatch: `coverage.umbrella` vs `umbrella_excess`.** `scripts/dev-seed.ts`'s
  org-level (and one location-level) rule is keyed `coverage.umbrella.each_occurrence`, but real
  Vision COI extractions return `coverage_type: "umbrella_excess"` (per the documented vocabulary
  in `src/lib/extraction/types.ts`), and the engine's `parseCoverageKey()`/`policiesOfType()`
  match on the coverage-type segment of the key verbatim. Net effect: umbrella coverage reads as
  **"missing" for every vendor in this tenant that has a real (non-seed) extraction**, regardless
  of actual coverage. Discovered and confirmed live twice this arc (both times while building
  throwaway test vendors with real Vision-extracted fixtures — see `31fb8ad` and `7d68fa6`'s
  commit messages for the exact repro). Not fixed — it's seed/rule *data*, not engine code, and
  both discoveries deliberately left it as-is afterward (once even used it on purpose as a
  ready-made "vendor-wide deficiency" example for the summary-dedup test in `7d68fa6`). Fix is a
  one-row `UPDATE requirement_rules SET requirement_key = 'coverage.umbrella_excess.each_occurrence' WHERE requirement_key = 'coverage.umbrella.each_occurrence'`
  (there are currently two rows: one `org` scope, one `location` scope at Coeur d'Alene) — trivial
  once someone decides it's worth doing.
- **Middleware matcher doesn't exclude the PDF.js worker path.** `src/middleware.ts`'s matcher
  (`['/((?!login|reset-password|billing/setup|v/|_next/|favicon.ico|robots.txt).*)']`) excludes
  several static/public paths but not `/pdf.worker.min.mjs`, which `PdfViewer.tsx` fetches from an
  absolute top-level path (`GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'`). Today this is
  masked in practice — `PdfViewer` only renders inside the admin-only `DocumentsAccordion`, so the
  browser fetching the worker file already has a valid session cookie from viewing the page at
  all. But if the session cookie is ever missing at the exact moment the worker script loads
  (expired mid-session, a direct/incognito fetch, or any future vendor-facing PDF view), the
  middleware's page-route branch would redirect that JS-asset request to `/login` — an HTML
  response where a worker script was expected, which fails opaquely. Not fixed — flagged only, per
  this doc being read-only. Fix would be adding `pdf.worker.min.mjs` to the matcher's negative
  lookahead, same pattern as `favicon.ico`/`robots.txt`.
- **Deferred yellow/warning tier — green/red only today.** `src/lib/verification/grid.ts`'s
  `GridStatus` type is `'green' | 'red'` and `statusFor()` maps anything that isn't `'meets'` to
  `'red'` — `fails`, `missing`, `indeterminate`, and `not_evaluated` are all visually identical
  (a red row) in the compliance grid today. There's no distinct "needs a look, not necessarily
  broken" tier for the genuinely uncertain/indeterminate case (which used to have its own
  "Needs Your Review" surface, now removed — see `31fb8ad`). Uncertain findings are still visible
  (as an Indeterminate/Missing status label within a red row, and named in the Unify Review
  summary), just not visually distinguished from a hard failure. Deferred, not scheduled.
- **`locName()`'s raw location-ID leak, flagged not fixed (`7d68fa6`).**
  `src/app/settings/requirements/page.tsx`'s `locName = (id) => locations.find(l => l.id === id)?.name ?? id`
  has the identical raw-ID-fallback shape that `nameOf()` on the same page had for user ids (fixed
  in `7d68fa6`) — but for location ids, which was out of that task's explicit "raw user id" scope.
  Same fix would apply: fallback to a readable label instead of the raw id.

## Locked design decisions — do not re-litigate

- **Approve/Reject is per-location, not vendor-level.** Requirements genuinely differ by site
  (trade overrides, location-scoped overrides — e.g. one location requiring higher GL), so a
  single vendor-wide approve/reject can't express "meets requirements at site A, doesn't at site
  B." `applyDecision()`'s approve/reject branches take `location_ids` and have been correct and
  untouched since before this arc began.
- **Correction is vendor-level *and* document-targeted — never per-location.** Reverted once
  already (`5d4ac8e` → `6f16a2a`) after shipping the wrong model. Documents are vendor-wide, so
  "which location" was never the right axis for a correction request — "which document" is.
- **The flag auto-clears on supersession; there is no separate "unflag" action or code path.**
  `supersedePriorDocument()` treating `'correction_requested'` as a valid prior-document state IS
  the entire clearing mechanism. Don't add a second explicit unflag step — it would be redundant
  and could race with or duplicate this.
- **One shared note per correction request, regardless of how many documents are selected.** Not
  a per-document note field. If a future need arises for genuinely different notes per document
  in the same request, that's a real scope change to discuss, not an oversight to silently fix.
- **Presets pre-fill an editable note — they don't lock it.** Clicking a preset chip
  ("Unreadable / blurry", "Expired", "Wrong document", "Missing pages") sets the note text; the
  admin can still edit or fully replace it before sending.
- **The document picker shows type labels, never filenames.** COI / W-9 / "Payment info" (not
  "ACH" — deliberately more human-facing wording for this one panel specifically; the shared
  `doc-type-style.ts` map still says "ACH" everywhere else, e.g. `DocumentsAccordion`, and was left
  alone). `original_filename` is stripped from `RequestMoreInfoPanel`'s props entirely at the
  `page.tsx` call site — not just hidden in the rendered DOM, confirmed absent from the actual RSC
  payload.
- **"Approve all passing" must never touch a location with any outstanding warning.** It only
  ever includes locations that are both `under_review` and have zero red grid rows. This was a
  hard requirement, verified live against a real mixed vendor (a genuinely passing location
  approved by the shortcut, a location with one real warning left untouched and still
  `under_review`).
- **The overall status pill reads "Approved · X of N locations" and surfaces declines**, not just
  a single aggregate word — `deriveOverallStatus()` in `page.tsx` (pre-dates this arc, untouched;
  noted here because per-location decisions make partial-approval states the common case now,
  not an edge case).
