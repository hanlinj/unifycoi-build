# Decision Log (ADR-style)

Durable, agent-independent record of the **non-obvious** calls whose reasoning would
otherwise live only in commit messages and review chat. Terse: decision / context / why.
Commits carry the terse version; this file carries the "why" so it survives without the chat.

Format: newest first. Each entry is a decision, not a changelog — only calls where a
reasonable engineer might later ask "why did they do it *that* way?"

---

## Phase 12 — Design system + platform dashboard

### ADR-012-01 · Design substrate = Tailwind v3 + a semantic token layer; preflight OFF (additive)
- **Decision:** Introduce Tailwind (v3) + a semantic token layer in `tailwind.config.ts` (canvas/surface/border/fg/fg-muted + accent/success/attention/danger, each with subtle/emphasis) — one source of truth replacing the hand-repeated inline Primer hex. Thin primitives in `src/components/ui/*`. **`corePlugins.preflight` is disabled.**
- **Context:** Slice 1. The design layer was greenfield (100% inline styles, no framework/tokens/primitives). User supplied references: three self-storage ops-dashboard screenshots + Cubby (clean, light, trustworthy B2B) — the authoritative direction — plus one dark-glass/lime board treated as **non-authoritative** (clashes with a trustworthy compliance tool; not adopted).
- **Why:** The pinned direction (utility layout, bordered cards, status pills, Primer-family palette) maps idiomatically onto Tailwind; shadcn/Radix is heavier than needed and a hand-rolled tokens-module reinvents Tailwind's ergonomics. **Preflight OFF** because the DS is additive this phase — Tailwind's global reset would restyle the un-retrofitted inline-styled tenant pages (they migrate in Slice 9, FENCE: migration-only). Primitives get correct box-sizing via a minimal `globals.css` base rule instead. Because everything routes through tokens, shifting the accent/energy later (e.g. toward the dark board) is a handful of token edits.
- **Testing:** jest now runs two projects — `node` (existing 762 `*.test.ts`, untouched) and `jsdom` (RTL `*.test.tsx`). Disjoint globs.

## Phase 11 — Launch-prep (infrastructural)

### ADR-011-11 · COI expiry boundary = START of the expiry day, tenant-local (not end-of-day)
- **Decision:** OPS-7 math half. `expiryBoundaryMs(expiry, tz)` resolves a date-only expiry to **00:00 in the tenant's timezone** (start of the expiry day); a full-ISO expiry is honored as-is. Used by the renewal ladder + day-0 flip, Command Center `daysToExpiry`, and reports `daysOut` — one treatment, in `src/lib/time/zone.ts` (same `Intl` primitive as the digest cadence's `localHourInZone`).
- **Context:** Slice 6. The kickoff's framing leaned "valid THROUGH the expiry date → flip at END of that local day." Investigation surfaced two problems with end-of-day.
- **Why start-of-day, not end-of-day:** (1) The **spec wins** (CLAUDE.md) and `Renewal_and_Expiration_Chase` says "Expired **the moment the date passes** … safest compliance posture" and "**past its expiration date**" — i.e. expire *earlier*, don't grant an extra local day of hireability against possibly-lapsed coverage. (2) The current code was already start-of-day (`Date.parse(date-only)` = UTC midnight), so end-of-day would **change UTC behavior** (+1 day) and break `phase7-worker.test.ts:147` (a date-only, UTC-fallback tenant) — tripping the "no-op for UTC / stop if a test changes" rule. The premise that "UTC was already correct, only non-UTC was off" was itself wrong — it was start-of-day for *everyone*; the ONLY bug was the timezone, which is orthogonal to start-vs-end. So: fix the timezone (the real bug), keep the spec's start-of-day semantics. Byte-identical no-op for UTC/null-tz tenants (zero existing-test changes). The user chose this explicitly after the trade-off was surfaced.
- **Not chosen:** end-of-day-local ("valid through") — would be a spec-level semantic change (grant one more day) requiring the spec + those tests updated; flagged, not built.

### ADR-011-01 · ESP is Resend, behind the existing Mailer seam
- **Decision:** Real email goes through Resend, swapped in behind the existing `Mailer` interface (not a new abstraction).
- **Context:** Slice 1. Postmark and Resend were both viable; the whole product value is that chase/invite emails reach the inbox.
- **Why:** Resend's native `Idempotency-Key` header closes the worker double-send window (SEC-2) with zero extra bookkeeping — the worker already threads `notificationId`, which becomes the key directly. Chosen over Postmark for that clean SEC-2 fit. Per-operator DKIM domains deferred (FEAT-13); operator identity rides the From display name on a shared verified domain.

### ADR-011-02 · `SendResult.providerId` is an additive field, not an interface change
- **Decision:** Added an optional `providerId` to `SendResult` rather than treating it as "changing the Mailer interface."
- **Context:** Slice 1. The kickoff said "transport swap, don't change the interface." The cookie-less delivery webhook needs to correlate a bounce to a single tenant-scoped row.
- **Why:** The `send()` method contract and `EmailMessage` are untouched; `providerId` is optional, the NoOp mailer omits it, callers ignore it unless present. It's the only way to persist the ESP message id (`notifications.provider_message_id`) so the webhook can resolve a bounce by **message id, not recipient email** (email collides across tenants). Additive ≠ breaking.

### ADR-011-03 · Login lockout is DERIVED from a rolling window, not a `login_lockouts` table
- **Decision:** No lockout table. `login_attempts` logs failures; the lock is a windowed count. `clearLoginFailuresForEmail` is the unlock seam.
- **Context:** Slice 2 (SEC-9).
- **Why:** Prime Directive — don't invent entities. The lock is fully derivable (count ≥ threshold in window), so a separate row would be speculative. A first-class `login_lockouts` row (with `locked_until`, audited `cleared_by`) only earns its place when a platform dashboard needs "locked until X, unlocked by whom" — a Phase 12 decision, made then. `clearLoginFailuresForEmail(email)` is exactly the seam a future operator-unlock calls. Per-IP scope is a rolling window and is deliberately NOT reset on one success (a valid login must not wipe an attacker's IP count).

### ADR-011-04 · Reset token is hash-only at rest; raw token scrubbed from the notification payload on send AND fail
- **Decision:** `password_reset_tokens` stores only SHA-256(token). The raw token rides `notifications.payload_json` transiently so the worker can render the link, then the worker **nulls it after the send attempt** — on success AND failure. Scoped to `password_reset` only; the invite-token path is deliberately untouched.
- **Context:** Slice 3 + amendment (SEC-8).
- **Why:** The verifier table is hash-only so a DB dump can't reset anyone — but `payload_json` lives in the *same* DB, so a raw token sitting there for the 1h TTL partly undoes that. A reset token **takes over an existing account** on `/confirm` — higher blast radius than an invite token — so it does not inherit the invite pattern's at-rest posture just because delivery plumbing is shared. Scrubbing on failure too (beyond the literal "on success" ask) is required so a failed send doesn't leave the token in a `failed` row for the full TTL. Invite tokens are a separate risk object and a separate decision — not a silent ride-along. **Residual (named):** the raw token is in cleartext between queue and send-attempt (bounded by the worker tick), not for the full TTL.

### ADR-011-05 · Password-reset resolution inherits login's first-match; platform users out of scope
- **Decision:** Reset resolves an email to a tenant user via the **same first-match order login uses**; a multi-tenant email resolves the same way login would. Platform-user reset is not built this phase.
- **Context:** Slice 3.
- **Why:** A reset resolving *differently* than login would be its own bug (SEC-11 carry-forward). Inheriting is correct, not a shortcut. Platform users are engineer-provisioned (operator-assisted model) and the notification worker only delivers to tenant users — platform reset is separate infra, deferred.

### ADR-011-06 · CSRF rejects only `cross-site`; `same-site` is allowed
- **Decision:** Edge middleware rejects `Sec-Fetch-Site: cross-site` (and unknown-Origin on the fallback); `same-site` and `none` pass. CSRF exemptions are **structural** (Bearer / cookie-less), not a hand-maintained path allowlist.
- **Context:** Slice 4 (SEC-12).
- **Why:** The app is single-origin with no untrusted subdomains, so `same-site` (sibling subdomain) is not a live threat, and rejecting it would add risk of false positives for no gain. Making exemptions structural (Bearer isn't ambient; cookie-less can't be CSRF'd) means new cookie-less/token routes are exempt *by construction* — no allowlist to forget to update. **Conditional hardening (tracked in launch-prep):** reject `same-site` too *if* untrusted subdomains are ever introduced. Login is NOT exempt (it's cookie-*setting* → gets the Origin check even without a prior cookie).

### ADR-011-07 · CSRF lives in middleware → matcher must include `/api/*`
- **Decision:** Expanded the middleware matcher to include `/api/*` (it previously excluded it). API routes pass through (never redirected); they own their 401/403 via `getAuth`.
- **Context:** Slice 4. Changed the one test that pinned the old "middleware never runs on /api/" invariant.
- **Why:** "CSRF in edge middleware" and "matcher excludes /api/" are contradictory — the middleware can't protect API mutations it never sees. The matcher change is mandatory for the slice; the test that asserted `/api/` was excluded encoded the *pre-SEC-12* design, so updating it is a design-invariant change, not a test bent to fit a bug.

### ADR-011-08 · Key-version is implicit-v1 for fields (format unchanged), explicit for blobs
- **Decision:** SEC-13 versioning hook. Blob envelope meta stamps `key_version: 1` (free in JSON). Field ciphertext stays 3-part (`iv:tag:ct`) = **v1 by definition**; `decryptField` is version-aware (understands a future `v<N>:iv:tag:ct`) but `encryptField`'s output is unchanged. Migration adds `documents.key_version` (DEFAULT 1). No rotation.
- **Context:** Slice 5 (SEC-13).
- **Why:** Explicitly prefixing `v1:` on fields would change the delimiter arity and break the format-pinning field tests — for zero current benefit (there's no v2 to distinguish from). Unversioned-legacy-as-v1 is the standard pattern; the version tag earns its place only when v2 exists, and the decrypt side already routes it. Decrypt defaults missing/legacy → v1 so all existing data still decrypts. This is a *hook* — `kekForVersion`/`fieldKeyForVersion` throw for unknown versions; rotation itself is deferred.

### ADR-011-09 · Observability scrub is a denylist; its boundary is named, not assumed total
- **Decision:** Sentry `beforeSend` (and self-logged context) run a denylist scrub — redact by sensitive **key name** and by sensitive **digit pattern** (TIN/SSN/EIN/ACH). Alerts pass **IDs only**; the scrub is defense-in-depth on top.
- **Context:** Slice 5 (OPS-12 / SEC-16).
- **Why:** A denylist misses by nature. Named residual: a Sensitive value that is *both* non-digit-shaped (confidential name, lettered account id, base64 secret) *and* under an unrecognized key can slip through. The primary guarantee for the SEC-16/OPS-3 alerts is that callers pass IDs only; the scrub is a safety net for unexpected `captureError` contexts and third-party breadcrumbs, not a total guarantee. Stated so the boundary is known, not oversold.

### ADR-011-10 · Doppler buys at-rest + rotation, not runtime isolation; ALLOWED_ORIGINS is build-time
- **Decision:** Secrets move to Doppler; `env.ts` stays the single chokepoint. Documented honestly in `.env.example`.
- **Context:** Slice 5 (OPS-13).
- **Why:** On a single host, Doppler gives encrypted-at-rest storage + central rotation/audit of secret *values* — it does **not** give runtime process isolation (a compromised app process still reads its own env). Say that, don't oversell it. **Footgun (documented):** Next inlines `process.env` used in *edge middleware* at BUILD time — `ALLOWED_ORIGINS` (and any edge-middleware env) must be present at `next build`, not just injected at runtime, or the edge bundle inlines `undefined` and every Origin-fallback mutation 403s. Build-time vs runtime env are distinct sets in the deploy pipeline.
