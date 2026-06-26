# IMPLEMENTATION_BRIEF — UnifyCOI v1

> **Meta-file, not a spec.** This is the **compile target** for the agentic coder: a single
> projection of the vault into stack, schema, routes, endpoints, and build order. It does
> **not** introduce new product decisions — every choice here is *derived from* the vault
> and points back to the canonical doc that owns it. If this file and a spec doc ever
> disagree, **the spec doc wins** and this file is regenerated.
>
> Doc names below are plain text (not `[[wikilinks]]`) so this file stays out of the spec
> link-graph and the consistency check — same convention as `_CONTINUE.md`.
>
> Authority order for the coder: `MISSION.md` (north star + tiebreakers) → `UnifyCOI_Build_Checklist.md`
> (locked decisions, don't re-litigate) → the relevant spec doc → **then** this brief for the
> concrete shape.

---

## 0. Prime directive — do not invent beyond spec

This is the single most important instruction in this file. The vault is deep and
internally consistent; the failure mode is an agent *synthesizing past it*.

- **Build exactly the tables, routes, and endpoints enumerated here.** No extra entities,
  no speculative columns, no "while I'm here" features.
- **Honor the MISSION Non-Goals.** Not a document store, not an AP system, not a vendor
  marketplace, not a comms platform, not a generic COI tool. Run the **Focus Test** on any
  impulse to add: *does this help operators onboard, verify, monitor, approve, or maintain
  compliant vendors?* If no → don't build it.
- **When a spec doc says "deferred" or "v1 = simple," stop there.** FTS5/fuzzy search,
  as-of-date audit reconstruction, object storage, scheduled report delivery, SMS,
  excess-over-underlying stacking, OCR fallback — all **out of v1** (§2, §9).
- **Stop and ask** (don't guess) if a build need is genuinely not answered by the vault or
  §9 below. Defaults in §9 cover the open items; anything outside them is a real fork.
- **Never weaken an invariant for convenience** (§1 list). Accuracy over speed, defensibility
  over convenience, humans in control (MISSION #1/#2/#4).

---

## 1. Locked invariants (the rails — never violate)

Pulled from `UnifyCOI_Build_Checklist.md`. These constrain the schema and every endpoint.

1. **Three altitudes stay distinct:** Platform (UnifyCOI) · Tenant (client org) · within-tenant
   (Admin/District/Store + vendors). `platform_users` and tenant `users` are **separate
   identity spaces**.
2. **Tenant isolation is structural** — every tenant-scoped row carries `tenant_id` and is
   queried within it. No cross-tenant read, ever. (`Platform_Systems_and_Tenancy.md`)
3. **Vendors are per-tenant isolated** — a vendor serving two clients = two vendor records,
   two document sets. Collect-once reuse is **within a tenant only**.
4. **Only Admin approves** — every first approval. AI verifies + recommends; a human always
   clicks. Managers have **no** approve action. (`Roles_and_Permissions.md`)
5. **Status is per-location; overall is derived** — lives on `vendor_locations`. Overall =
   Approved-at-all / "N of M" / in-pipeline-leads. (`Status_Vocabulary.md`)
6. **Expiration is an objective vendor-upload gate** — an expired policy bounces to the
   vendor and **never reaches the Admin**. The engine *extracts* dates but does not *decide*
   on them. (`AI_Verification_Engine.md`, `Vendor_Onboarding_Workflow.md`)
7. **Rules-only re-eval reads stored extractions** — rule-change AND location-add re-evaluate
   against `extractions` (no Vision call). Renewals re-extract (new document). (`AI_Verification_Engine.md`)
8. **Sensitive = Admin-only, masked server-side** — full TIN + ACH account/routing. No
   Finance/AP role. Masking blocks at the data layer, not the UI. (`Document_Storage_and_Security.md`)
9. **Email-only notifications v1** — exceptions immediate, routine daily digest. Exception
   alerts not opt-out-able. Vendor-facing comms branded as the operator. (`Notifications_and_Communications.md`)
10. **Audit trail is append-only/immutable**, tenant-isolated, attributed (system/AI/user/vendor),
    7-year retention. Sensitive values redacted in payloads. (`Audit_Trail.md`)
11. **7-year retention then purge-eligible** — measured from inactive; superseded docs retained,
    not deleted. Deletion is logged. (`Document_Storage_and_Security.md`)
12. **Two app shells + tokenized vendor flow** — one role-conditional tenant sidebar; separate
    platform shell; vendors have no nav/login. (`Navigation.md`)

---

## 2. Stack & MVP scope

### Stack (pinned by the vault — do not substitute)

- **Next.js 14** (App Router), TypeScript. Server-side API route handlers + a background
  job/worker for verification and the notification digest.
- **SQLite + better-sqlite3** (synchronous, raw — **no ORM**, matches the AI-engine doc).
- **Claude Vision** via the Anthropic API, server-side only, **forced structured output**
  (tool-use / JSON-schema mode — never free-text-then-parse).
- **JWT** for internal users (Admin/District/Store) and platform users. Vendors use **tokens**,
  not JWT (the token is the credential).
- **TLS** everywhere. Document files live in **S3-compatible object storage** behind a
  `BlobStore` interface (`put / get / delete`); files are **envelope-encrypted app-side
  before `put`** (a leaked bucket yields ciphertext). Sensitive *extracted fields* stay
  **field-level encrypted** in the DB. Master/key material managed outside the DB and the bucket.
  Backend = **Backblaze B2** for both **dev and prod** (same driver, **separate buckets + scoped
  keys** per environment). A **filesystem adapter** behind the same interface is used **for
  tests/CI only** (hermetic, credential-free) — not in the dev or prod path.

### In v1

Provisioning → onboarding → AI verification → Admin approve/reject → renewal/expiration chase
→ the four read surfaces (Manager Home, Command Center, Vendor Record, Location Record) →
fixed Reports → Audit export → simple Search → role-conditional nav. The full
seven-segment surface set, built to the depth the specs describe.

### Deferred (architect-for, do **not** build)

FTS5 / fuzzy search (ship facet filters + name prefix/substring behind a service interface) ·
as-of-date audit reconstruction (ship now + full history) · **presigned direct-to-bucket
upload/download URLs** (ship server-proxied + app-side encryption; presigned pairs with
provider-managed SSE, a later swap) · scheduled/recurring report & export delivery (ship
on-demand, ride the digest rails later) · SMS channel · excess-over-underlying limit stacking
(route to Admin) · OCR fallback · re-extract-on-version-bump migration (stamp the version now,
don't build the migration) · read-only/auditor role · legal-hold purge override (flag, don't build).

---

## 3. Database schema (SQLite / better-sqlite3)

> Every tenant-scoped table carries `tenant_id` and is **always** queried within it
> (invariant #2). Sensitive columns are marked `-- SENSITIVE` → field-level encrypted, never
> logged. Timestamps are ISO-8601 text or unix int — pick one and keep it consistent.
> The three engine tables (`extractions`, `verification_runs`, `requirement_evaluations`) are
> reproduced verbatim from `AI_Verification_Engine.md` — that doc owns them.

### Platform altitude (no `tenant_id`)

```sql
CREATE TABLE platform_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,          -- 'owner' | 'staff'
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  lifecycle_state   TEXT NOT NULL,      -- 'provisioning' | 'active' | 'suspended' | 'offboarded'
  monthly_rate_cents INTEGER NOT NULL DEFAULT 9000,  -- $90/location reference
  created_at        TEXT NOT NULL
);

-- Manual billing: app is source of truth for the FIGURE, not the transaction.
-- Billable count is derived from active locations; snapshot rows flag when it changes.
CREATE TABLE billing_snapshots (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  billable_locations INTEGER NOT NULL,
  amount_cents       INTEGER NOT NULL,  -- billable_locations * monthly_rate_cents
  changed            INTEGER NOT NULL,  -- bool: differs from prior snapshot
  created_at         TEXT NOT NULL
);

-- Reusable platform requirement templates applied at provisioning.
CREATE TABLE requirement_templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  payload_json TEXT NOT NULL,           -- the floor + default matrix
  created_at   TEXT NOT NULL
);
```

### Tenant altitude (all carry `tenant_id`)

```sql
CREATE TABLE users (                    -- tenant internal users
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,          -- 'admin' | 'district_manager' | 'store_manager'
  password_hash TEXT,                   -- null until invite accepted
  status        TEXT NOT NULL,          -- 'invited' | 'active' | 'disabled'
  created_at    TEXT NOT NULL,
  UNIQUE (tenant_id, email)
);

CREATE TABLE regions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL
);

CREATE TABLE locations (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  region_id  TEXT REFERENCES regions(id),   -- nullable
  name       TEXT NOT NULL,
  address    TEXT,
  status     TEXT NOT NULL,             -- 'active' | 'archived'  (archive, not hard-delete)
  created_at TEXT NOT NULL
);

-- Scope memberships: district -> regions, store manager -> locations. Admin = org-wide (no rows).
CREATE TABLE user_regions   ( user_id TEXT NOT NULL, region_id   TEXT NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (user_id, region_id) );
CREATE TABLE user_locations ( user_id TEXT NOT NULL, location_id TEXT NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (user_id, location_id) );

CREATE TABLE vendors (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  business_name TEXT NOT NULL,
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  trade         TEXT NOT NULL,          -- enum: plumbing | electrical | gate_tech | landscaping | paving | other ...
  created_at    TEXT NOT NULL
);

-- Per-location status lives HERE (invariant #5). Overall status is derived, not stored.
CREATE TABLE vendor_locations (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  vendor_id    TEXT NOT NULL REFERENCES vendors(id),
  location_id  TEXT NOT NULL REFERENCES locations(id),
  status       TEXT NOT NULL,           -- Status_Vocabulary: invited_pending | onboarding | under_review |
                                        --   approved | expired | non_compliant | declined
  flags_json   TEXT,                    -- modifiers: action_needed, expiring_soon, deficient, uncertain,
                                        --   unverified, bounced, expired_invite
  approved_by  TEXT REFERENCES users(id),
  approved_at  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (tenant_id, vendor_id, location_id)
);

CREATE TABLE invites (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  vendor_id       TEXT REFERENCES vendors(id),
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  token           TEXT UNIQUE NOT NULL, -- single-purpose, scoped, expiring (14d onboarding default)
  token_expires_at TEXT NOT NULL,
  purpose         TEXT NOT NULL,        -- 'onboarding' | 'renewal' | 'correction'
  delivery_state  TEXT NOT NULL,        -- 'sent' | 'unverified' | 'bounced' | 'expired_invite'
  created_at      TEXT NOT NULL
);

CREATE TABLE documents (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  vendor_id         TEXT NOT NULL REFERENCES vendors(id),
  doc_type          TEXT NOT NULL,      -- 'coi' | 'w9' | 'ach' | 'license'
  storage_key       TEXT NOT NULL,      -- object key: tenants/{tenant_id}/vendors/{vendor_id}/{document_id}
  encryption_json   TEXT NOT NULL,      -- {algo, iv, wrapped_data_key} — app-side envelope encryption (see note)
  original_filename TEXT,
  superseded_by     TEXT REFERENCES documents(id),  -- renewal supersedes; old doc retained, not deleted
  uploaded_at       TEXT NOT NULL
);

-- ---- Engine tables: verbatim from AI_Verification_Engine.md (that doc is authoritative) ----
CREATE TABLE extractions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  document_id        TEXT NOT NULL REFERENCES documents(id),
  doc_type           TEXT NOT NULL,
  model_id           TEXT NOT NULL,     -- pinned vision model id
  extraction_version TEXT NOT NULL,     -- schema/prompt version stamp
  payload_json       TEXT NOT NULL,     -- typed schema; per-field {value,confidence,band,source,corroborated}
                                        -- SENSITIVE leaves (full TIN, account/routing) ciphertext, never logged
  created_at         TEXT NOT NULL
);

CREATE TABLE verification_runs (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  vendor_id      TEXT NOT NULL REFERENCES vendors(id),
  trigger        TEXT NOT NULL,         -- 'onboarding' | 'resubmission' | 'renewal' | 'rule_change' | 'location_add'
  engine_version TEXT NOT NULL,
  recommendation TEXT NOT NULL,         -- 'approve' | 'deficiencies' | 'uncertain'
  created_at     TEXT NOT NULL
);

CREATE TABLE requirement_evaluations (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  run_id              TEXT NOT NULL REFERENCES verification_runs(id),
  vendor_id           TEXT NOT NULL REFERENCES vendors(id),
  location_id         TEXT NOT NULL REFERENCES locations(id),
  requirement_key     TEXT NOT NULL,
  required_value      TEXT,
  extracted_value_ref TEXT,             -- pointer into the extraction payload
  comparison_result   TEXT NOT NULL,    -- 'meets' | 'fails' | 'indeterminate' | 'missing'
  confidence_band     TEXT,             -- 'high' | 'med' | 'low'
  outcome             TEXT NOT NULL,    -- 'pass' | 'deficient' | 'uncertain'
  note                TEXT
);
-- -------------------------------------------------------------------------------------------

-- Layered requirement matrix: org base -> trade override -> location override. Engine consumes
-- the RESOLVED matrix; resolution (precedence) is computed, not stored. (Requirements_Configuration.md)
CREATE TABLE requirement_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  scope_type      TEXT NOT NULL,        -- 'org' | 'trade' | 'location'
  scope_ref       TEXT,                 -- null (org) | trade enum | location_id
  requirement_key TEXT NOT NULL,
  required_value  TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,        -- requirement changes REQUIRE a reason (Audit_Trail.md)
  created_at      TEXT NOT NULL
);

CREATE TABLE requirement_settings (
  tenant_id        TEXT PRIMARY KEY REFERENCES tenants(id),
  precedence_policy TEXT NOT NULL DEFAULT 'strictest'  -- 'strictest' | 'location' | 'trade'
);

CREATE TABLE audit_events (             -- append-only / immutable (invariant #10)
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  actor_type  TEXT NOT NULL,            -- 'system' | 'ai' | 'user' | 'vendor' | 'platform'
  actor_id    TEXT,
  event_type  TEXT NOT NULL,            -- e.g. document.extracted, requirement.evaluated, ai.recommendation,
                                        --   vendor.approved, sensitive.viewed, export.generated, impersonation.*
  target_type TEXT,
  target_id   TEXT,
  payload_json TEXT,                    -- Sensitive values REDACTED here
  created_at  TEXT NOT NULL
);

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  recipient_type  TEXT NOT NULL,        -- 'user' | 'vendor'
  recipient_ref   TEXT NOT NULL,        -- user_id or vendor_id/email
  channel         TEXT NOT NULL DEFAULT 'email',
  kind            TEXT NOT NULL,        -- 'exception' (immediate) | 'digest' (daily batch)
  status          TEXT NOT NULL,        -- 'queued' | 'sent' | 'failed' | 'bounced'
  scheduled_for   TEXT,
  sent_at         TEXT,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE audit_exports (            -- generation is itself a logged access event
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  requested_by      TEXT NOT NULL REFERENCES users(id),
  scope_type        TEXT NOT NULL,      -- 'vendor' | 'location' | 'region' | 'org' | 'tenant_offboard'
  scope_ref         TEXT,
  format            TEXT NOT NULL,      -- 'pdf' | 'csv'
  includes_sensitive INTEGER NOT NULL DEFAULT 0,  -- Admin opt-in only, exclude-by-default, extra-logged
  status            TEXT NOT NULL,      -- 'queued' | 'generating' | 'ready' | 'failed'
  storage_key       TEXT,               -- generated export in BlobStore; envelope-encrypted if includes_sensitive
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
```

> **Sensitive storage shape (§9 default):** keep Sensitive *field* leaves as ciphertext **inside**
> `extractions.payload_json`, tagged for redaction — not a separate plaintext column. This is
> the `Document_Storage_and_Security.md` default; a separate ciphertext table is an allowed
> later swap, not a v1 requirement.
>
> **Document files (object storage):** the uploaded artifacts (COI/W-9/ACH PDFs) go to the
> `BlobStore` under a **tenant-prefixed key** (`tenants/{tid}/vendors/{vid}/{document_id}`),
> **envelope-encrypted app-side before `put`**: a random per-object data key encrypts the bytes,
> the data key is wrapped by a master key (KEK) held outside the DB/bucket, and `{algo, iv,
> wrapped_data_key}` is stored in `documents.encryption_json`. Bytes proxy through the server
> both ways (app encrypts on write / decrypts on read) — no presigned URLs in v1 (deferred, §2).
> Provider-side SSE is fine as defense-in-depth but is not the trust boundary.
>
> **Indexes:** at minimum `(tenant_id, status)` on `vendor_locations`, `(tenant_id, vendor_id)`
> on `documents`/`extractions`/`verification_runs`, `(tenant_id, name)` on `vendors`/`locations`
> for the simple Search (prefix/substring), and `(tenant_id, created_at)` on `audit_events`.

---

## 4. App routes (Next.js 14 App Router)

Two shells + a tokenized vendor flow. **Search and Invite are global chrome** (command/modal),
**not** route destinations. Records are reached via destinations/Search, not sidebar entries.
(`Navigation.md`)

### Tenant shell — JWT, one role-conditional sidebar

```
/                       -> role landing (Store: Manager Home · District: oversight Command Center · Admin: Command Center)
/dashboard              -> Manager Home Dashboard          (operational; "who can I hire")
/command-center         -> Corporate Command Center        (exception-first; District = region-scoped instance)
/vendors                -> vendor directory
/vendors/[vendorId]     -> Vendor Record (Admin = approve/reject workbench; managers read-only + Sensitive masked)
/locations              -> Location Management
/locations/[locationId] -> Location Record
/requirements           -> Requirements Configuration       (Admin only)
/users                  -> User Management                  (Admin org-wide · District region)
/reports                -> Reports index (fixed set)
/reports/[reportKey]    -> a specific report (on-demand view + export)
/settings               -> Client Org Settings              (Admin)
/audit                  -> audit view + export entry
```

District = scoped reuse of `/dashboard` and `/command-center` (no distinct surface; server-side
region clamp; oversight-first landing). (`Regional_District_View.md`)

### Platform shell — JWT platform user

```
/platform                       -> Super-Admin Console (Fleet Attention zone first)
/platform/tenants               -> tenant list
/platform/tenants/new           -> New Client Provisioning
/platform/tenants/[tenantId]    -> tenant detail (support entry; impersonation switches INTO the tenant shell)
/platform/templates             -> requirement templates
/platform/billing               -> billing reference (count × $90)
```

### Vendor flow — tokenized, no login

```
/v/[token]              -> guided onboarding / renewal / correction (ONE flow, save-and-resume,
                           expiration gate at the upload step). The flow IS the status view.
```

---

## 5. API endpoints (route handlers under `/api`)

> Every tenant endpoint resolves `tenant_id` from the JWT and **clamps scope server-side** per
> `Roles_and_Permissions.md`. Sensitive fields are masked server-side for non-Admin (invariant #8).
> Verification is **not** a public endpoint — it's an enqueued background run.

```
# Auth
POST   /api/auth/login            POST /api/auth/logout            GET /api/auth/me

# Platform
GET/POST   /api/platform/tenants
GET/PATCH  /api/platform/tenants/:id           # lifecycle: provisioning->active->suspended->offboarded
POST       /api/platform/tenants/:id/impersonate
GET/POST   /api/platform/templates
GET        /api/platform/billing

# Locations & users (tenant)
GET/POST   /api/locations         PATCH /api/locations/:id        # archive, not hard-delete
POST       /api/locations/import                                  # bulk: locations + primary store manager only
GET/POST   /api/users             PATCH /api/users/:id            POST /api/users/:id/invite

# Vendors & onboarding
GET        /api/vendors           GET /api/vendors/:id
POST       /api/vendors/invite                                    # creates invite + token; delivery flags
POST       /api/vendors/:id/locations                            # add-to-locations (collect-once; rules-only re-eval)
POST       /api/vendors/:id/decision                             # body: approve | reject | request_correction (ADMIN ONLY)

# Requirements
GET/PUT    /api/requirements                                     # layered rules; PUT requires reason
PUT        /api/requirements/precedence                          # strictest | location | trade

# Vendor tokenized (no JWT — token is the credential)
GET        /api/v/:token                                         # current flow state
POST       /api/v/:token/documents                               # upload; app envelope-encrypts -> BlobStore.put; expiration gate here
POST       /api/v/:token/submit                                  # enqueues a verification run

# Engine (internal/worker — not client-callable)
(worker)   verification runs        (worker) notification digest (daily)        (worker) chase ladder 60/30/14/7/1

# Read/derived surfaces
GET        /api/search                                           # facet filters + name prefix/substring (v1 simple)
GET        /api/reports/:reportKey                               # fixed reports; export query param pdf|csv

# Audit export
POST       /api/exports           GET /api/exports/:id           # small=sync, large=async+notify; logged event
```

---

## 6. Build order (dependency-ordered)

Subsumes the "build-order README" menu item in `_CONTINUE.md`. Each phase is shippable/testable
before the next.

1. **Foundation** — Next.js 14 + TS scaffold, better-sqlite3 connection, migration runner,
   `tenant_id`-scoping helper (the query guard every read/write passes through), JWT middleware,
   the **`BlobStore` interface + S3-compatible adapter (Backblaze B2, used in dev and prod) +
   filesystem adapter for tests/CI**, and the **envelope-encryption util** (per-object data key, KEK wrap) plus the
   field-level encryption util. Build the storage seam here so nothing downstream hardcodes paths.
2. **Tenancy & identity** — `platform_users`, `tenants`, `users`, `regions`, `locations`,
   scope-membership joins. Platform shell + provisioning + bulk location import. Role matrix
   enforcement. (Segments 1–2)
3. **Requirements resolution** — `requirement_templates`, `requirement_rules`, `requirement_settings`,
   and the **resolver** (org→trade→location + precedence → effective matrix). Pure function;
   unit-test it hard — the engine depends on it. (Requirements_Configuration.md)
4. **AI verification engine** — `documents`, `extractions`, `verification_runs`,
   `requirement_evaluations`; Claude Vision structured extraction; hybrid confidence
   (self-rate + targeted corroboration); deterministic rules engine; the rules-only reuse paths.
   Test against the 10-package dataset; tune band cutoffs. (AI_Verification_Engine.md)
5. **Vendor onboarding** — tokenized flow, guided upload, **expiration gate**, submit → enqueue
   run. `invites`, token lifecycle. (Vendor_Onboarding_Workflow.md)
6. **Decision & workflows** — Admin approve/reject/request-correction; deficiency loop;
   `vendor_locations` per-location status writes + derived overall; add-to-locations;
   renewal/expiration chase (60/30/14/7/1). (Document_Verification.md, Renewal_and_Expiration_Chase.md)
7. **Cross-cutting systems** — `audit_events` (append-only, wired into every mutation),
   `notifications` (email; exceptions immediate, daily digest), retention schedule fields,
   Sensitive masking verified end-to-end. (Segment 6)
8. **Read surfaces** — Manager Home, Corporate Command Center, Vendor Record workbench,
   Location Record. (Segment 3)
9. **Reports & audit export** — the six fixed reports (on-demand view + PDF/CSV);
   `audit_exports` engine (scope + sync/async). (Reports_and_Analytics.md, Audit_Export_Generation.md)
10. **Search & navigation** — simple search service behind an interface (FTS5-swappable later);
    role-conditional sidebar; District oversight-first landing. (Search.md, Navigation.md)

---

## 7. Unresolved decisions → chosen v1 answers

Every open item I could find across the vault, with a default so the coder never stops to ask.
**BLOCKING** = touches what gets built in v1. **DEFER** = architect-for, don't build; default
keeps the door open.

| # | Open item (source doc) | Chosen v1 answer | |
|---|---|---|---|
| 1 | Storage mechanism — filesystem vs object storage (Storage) | **S3-compatible object storage on Backblaze B2** behind a `BlobStore` interface — same driver dev + prod, **separate buckets/keys** per env; **filesystem adapter for tests/CI only**. Files **envelope-encrypted app-side**, tenant-prefixed keys. | BLOCKING |
| 2 | Sensitive storage shape (AI Engine / Storage) | **Ciphertext inside `extractions.payload_json`**, redaction-tagged. No separate plaintext column. | BLOCKING |
| 3 | Managers see COI contents vs status-only (Storage) | **Status-only.** Managers never interpret compliance docs; Admin reviews the artifact. | BLOCKING |
| 4 | Confidence band cutoffs + critical-field list (AI Engine) | **Config defaults: high ≥0.90, med 0.75–0.90, low <0.75**; critical = limits, endorsements, named insured, coverage-present, expiration. Tunable, not hardcoded; tune on the 10-package set pre-launch. | BLOCKING |
| 5 | Entity-match strictness (AI Engine) | **Near-miss → Uncertain (human), clear mismatch → Deficient.** Threshold a config default. | BLOCKING |
| 6 | Exact retention figure (Storage / Tenancy) | **7 years** from inactive, then purge-eligible. Jurisdiction variation + legal-hold = DEFER. | BLOCKING |
| 7 | `Declined` as canonical terminal status (Status Vocab) | **Yes** — include it (hard-reject ≠ request-correction). | BLOCKING |
| 8 | `Action Needed` flag vs status (Status Vocab) | **Flag on Onboarding**, not a status. | BLOCKING |
| 9 | `Expiring Soon` surfaced to managers (Status Vocab) | **Yes** — helps avoid hiring against a near-lapse. | BLOCKING |
| 10 | Audit-export Sensitive default (Audit Export) | **Exclude-by-default**; Admin opt-in with reason, extra-logged. | BLOCKING |
| 11 | Location archive vs hard-delete (Location Mgmt) | **Archive** (`status='archived'`), retained per schedule. | BLOCKING |
| 12 | Standard-doc access logging grain (Storage) | **Sensitive always logged; standard at a lighter grain** (view/download events, not every render). | BLOCKING |
| 13 | Digest cadence + opt-out granularity (Notifications) | **Daily digest**; exception alerts not opt-out-able; finer opt-outs = DEFER. | BLOCKING |
| 14 | Re-evaluate already-approved vendors on rule tighten (Requirements) | **Yes** — rules-only re-eval; failures → Non-Compliant on the risk queue. | BLOCKING |
| 15 | Location-by-location vs satisfied-set approval (Vendor Record) | **Per-location approval** (vendor is hireable where they satisfy). Matches the per-location status model. | BLOCKING |
| 16 | Manager who initiates an add gets activation notice (Add-to-Locations) | **Yes, in the digest.** | non-blocking |
| 17 | Sync→async export threshold (Audit Export) | Small scope (vendor/location) **sync**; region/org/offboard **async + notify**. Exact row threshold = config. | non-blocking |
| 18 | Grace period before Expired-removal (Renewal) | **None** by default — expired is expired. | non-blocking |
| 19 | Admin opt-in to auto-send routine correction requests (Verification) | **Off** in v1 — Admin sends the drafted request. | non-blocking |
| 20 | Whole-vendor vs per-location expiry when one policy lapses (Renewal) | Engine evaluates **per-location** either way; surface the lapse per-location. | non-blocking |
| 21 | Support impersonation: read-only vs full; notify tenant admin (Tenancy) | **Full action, logged + visibly indicated**; tenant-admin notification = DEFER. | non-blocking |
| 22 | Multiple Admins / an owner super-admin among them (Roles) | **Multiple Admins, all org-wide, equal.** No intra-tenant owner tier in v1. | non-blocking |
| 23 | Model id + prompt/schema version pinning (AI Engine) | Pin one current vision model in config; **stamp the version now**, build no migration. | non-blocking |
| 24 | FTS5/fuzzy, coverage-aware search, include-inactive (Search) | **DEFER** — facet + prefix/substring behind a swappable interface; include-inactive off. | DEFER |
| 25 | As-of-date audit reconstruction (Audit Export) | **DEFER** — now + full history only. | DEFER |
| 26 | Scheduled/recurring report & export delivery (Reports/Export) | **DEFER** — on-demand only; ride the digest rails later. | DEFER |
| 27 | Excess-over-underlying limit stacking (AI Engine) | **DEFER** — v1 routes the situation to the Admin. | DEFER |
| 28 | OCR fallback (AI Engine) | **DEFER** — Vision only; not a v1 dependency. | DEFER |
| 29 | Tamper-evidence / PDF integrity stamp / key-management specifics (Storage/Audit) | **DEFER** — append-only table is the v1 integrity guarantee. | DEFER |
| 29b | Presigned direct-to-bucket URLs vs server-proxied files (Storage) | **DEFER** — v1 proxies bytes through the server with app-side envelope encryption (full key control). Presigned-direct pairs with provider SSE-KMS; flip per-bucket later if perf needs it. | DEFER |
| 30 | Read-only/auditor role (Roles) | **DEFER** — Admin/District/Store only in v1. | DEFER |
| 31 | Platform staff finer permissions (Tenancy/Roles) | **DEFER** — Owner + Staff (Staff ≈ provision/impersonate) only. | DEFER |
| 32 | Archived/Removed vendor terminal status (Status Vocab) | **DEFER** — removal retains the record per schedule; no separate live status. | DEFER |
| 33 | Audit retention longer than doc retention (Storage) | **DEFER** — same 7-year schedule for both in v1. | DEFER |

---

## 8. Definition of done (v1)

The vault's own "ultimate test" — at any moment an operator can answer, accurately and
defensibly: **(1) which vendors are approved · (2) which need attention · (3) can we prove it
right now.** If onboarding, verification, approval, renewal, the four read surfaces, reports,
audit export, and simple search all work within tenant isolation and the locked invariants —
v1 is done. Everything in the DEFER column stays unbuilt until deliberately scheduled.
