# Decision Log (ADR-style)

Durable, agent-independent record of the **non-obvious** calls whose reasoning would
otherwise live only in commit messages and review chat. Terse: decision / context / why.
Commits carry the terse version; this file carries the "why" so it survives without the chat.

Format: newest first. Each entry is a decision, not a changelog — only calls where a
reasonable engineer might later ask "why did they do it *that* way?"

---

## Phase 12 — Design system + platform dashboard

### ADR-012-01 · Design substrate = Tailwind v3 + tokens; theme from the user's design-system file (lime + graphite); preflight OFF
- **Decision:** Tailwind (v3) + a semantic token layer. The **authoritative visual spec is `refdoc/unifycoi-design-system.html`** (the user authored it): its `:root` lives verbatim in `globals.css` as the single source of truth, and Tailwind utilities map to those CSS vars. Theme = **"lime + graphite ops":** lime `#CFF04A` brand highlight, graphite `#191A1E` primary action, warm `#EDECEF` canvas, cornflower-blue `#6E8BE8` info, green/amber/red semantics, **Plus Jakarta Sans** (via `next/font`, self-hosted), large radii (12/18/24px), soft layered shadows. Icons: `lucide-react`. Thin primitives in `src/components/ui/*`. **`corePlugins.preflight` disabled.**
- **Context:** Slice 1. First cut used a Primer-family blue palette from screenshot references and (wrongly) treated a dark-glass/lime board as non-authoritative. The user then supplied a complete design-system HTML file that **is** the spec — lime energy IS wanted. That file supersedes the first cut; retranslated the tokens + primitives to it exactly. (Recorded honestly: the initial read was corrected by the user's explicit artifact — their words win, PATTERN-5.)
- **Why (substrate):** the direction maps idiomatically onto Tailwind; shadcn/Radix is heavier than needed, a hand-rolled tokens-module reinvents Tailwind. Tokens as CSS vars keep the user's design-system file the editable source of truth. **Preflight OFF** because the DS is additive — Tailwind's global reset would restyle the un-retrofitted inline tenant pages (they migrate in Slice 9, FENCE: migration-only); primitives get box-sizing via a minimal `globals.css` base rule; the ambient lime/blue canvas is scoped to `.ds-canvas`, not the global body.
- **Testing:** jest runs two projects — `node` (existing 762 `*.test.ts`, untouched) and `jsdom` (RTL `*.test.tsx`). Disjoint globs.

### ADR-012-02 · Platform shell is a separate nested layout; planned nav items shown disabled
- **Decision:** `/platform` gets its own route-group `layout.tsx` + `PlatformShell` (sidebar + header) — NOT the tenant `AppShell` (invariant #12). The layout gates every `/platform/*` surface to platform users (tenant→`/`, unauth→`/login`). The platform sidebar shows the full intended set (Tenants · Provisioning · Billing · Health · Settings) but **only Tenants is a link**; the rest render **disabled with a "Soon" chip** and enable as their slices land.
- **Context:** Slice 2. Tenant chrome already can't reach `/platform` (`shouldShowChrome('/platform')===false`); the new layout adds platform chrome inside that gap.
- **Why disabled-not-hidden:** the tenant nav strictly hides unbuilt destinations ("no dead doors"), but the platform console is founder-facing and benefits from seeing the roadmap — a *disabled* item is not a dead door (it never navigates). Proven non-vacuously that the tenant sidebar does NOT leak onto `/platform` (RTL, with a positive control showing it DOES render on a tenant route).
- **Fleet data:** the roster reads `listTenants` directly in a server component (same source the GET exposes; no self-fetch). It shows only what the API returns — name, lifecycle, **monthly rate**, created. Per-tenant **location count + computed monthly value** (rate × billable locations) need a `listTenants` extension → deferred to the billing/detail slices, NOT invented.
- **Row menu → minimal detail stub:** the fleet row kebab ("View details") links to a read-only `/platform/tenants/[id]` over the existing `getTenantById`. A deliberate stub so the fleet is navigable + the menu is a real door; **Slice 6 (tenant cockpit)** expands it with locations/users/template/billing/controls.

### ADR-012-03 · Stripe billing (⚠ owner-approved spec deviation) + the provisioning DB/Stripe boundary
- **Decision:** Provisioning (`provisionTenant`) creates the tenant + first Admin + locations + requirements template + a **required, validated IANA timezone** in ONE audited DB transaction (through the real services — never dev-seed raw SQL), then attaches a **Stripe customer + SetupIntent** behind an injectable `BillingProvider` seam. Migration 013 adds `tenants.stripe_customer_id`.
- **⚠ Spec deviation (owner-approved):** `Platform_Systems_and_Tenancy.md` says "no in-app payment processor; invoicing happens outside the app." The user explicitly chose full Stripe (billing-attach at provisioning; automation tail in Slice 8). Flagged per PATTERN-5; this is a conscious override, not an oversight.
- **The DB-commit / Stripe-call boundary (why it's ordered this way):** a DB transaction can't wrap an external network call. So the core commits FIRST (atomic — any step throwing rolls back the whole tenant, no partial/orphan), THEN Stripe runs. Ordering is tenant-then-customer, so a Stripe customer is only ever created for a tenant that exists → **no orphaned customer-without-tenant**. If Stripe fails after commit, the tenant sits in `provisioning` with `stripe_customer_id` NULL and `billing.attached=false` — **recoverable** (retry is idempotent via `provision:<tenantId>` → reuses the same customer) and **non-billable** (activation, Slice 5, is gated on `stripe_customer_id`), so **no orphaned live tenant**. Both the happy path and the Stripe-fails-after-commit path are proven in tests.
- **Seam:** `BillingProvider` (createCustomer/createSetupIntent); `StripeBillingProvider` runs only with `STRIPE_SECRET_KEY`, else `NoOpBillingProvider` (dev/test) returns deterministic synthetic ids keyed off the idempotency key — so provisioning works offline and the failure/idempotency paths are testable without the network. Mirrors the Mailer/BlobStore seam.
- **First Admin created WITH a password (loginable now):** there is no internal invite-accept flow (only vendor `/v/[token]`), and password-reset requires an existing hash — so an `invited` admin couldn't set a password. Slice 4's wizard can add an invite option (reusing password-reset as the set-password mechanism). Template rules are attributed to the first Admin (`requirement_rules.created_by → users(id)`; the platform user isn't a tenant user).
- **OPS-7 input closed:** `createTenant` now captures `timezone` (backward-compatible — optional there, REQUIRED + validated in provisioning). The Slice-6 (Phase 11) boundary math already reads it, so a provisioned tenant's expiry math is correct from day one.

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
