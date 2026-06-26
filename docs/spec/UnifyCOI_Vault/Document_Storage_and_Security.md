# System: Document Storage & Security

> A **cross-cutting systems** doc (not a screen), spanning the platform and tenant altitudes. Defines how vendor documents and sensitive data are **stored, isolated, encrypted, access-controlled, retained, and audited**. This is the backbone of MISSION #9 (secure by default) — the reason a wary tradesperson can trust the platform with banking and tax info.

## What's stored

For each vendor, within a tenant:

- **Document artifacts** — the uploaded files: COI, W-9, ACH form / voided check, licenses/certs.
- **Extracted structured data** — the values [[Document Verification]] pulls from each artifact (limits, endorsements, expiration dates, named insured, TIN, account/routing).
- **Audit records** — every extraction, verification, decision, communication, access, and status change (see [[Audit Trail]]).

Nothing is stored that doesn't support onboarding, compliance, payment setup, risk, or audit (MISSION non-goal: not a general document store).

## Sensitivity classification

Access and masking are driven by a two-tier classification:

| Tier | Includes | Who sees it |
|---|---|---|
| **Sensitive** | ACH/banking (account #, routing #, voided check), **full** tax ID (TIN/EIN) | **Admin only** (decision below) |
| **Standard** | COI contents, coverage limits, endorsements, expiration dates, license info, business name/contact | Role-scoped (Admin / District / Store within scope) |

## Storage architecture

> **Decision locked (storage mechanism):** **document files live in S3-compatible object storage on Backblaze B2** behind a `BlobStore` interface (`put / get / delete`) — the **same driver for dev and prod**, pointed at **separate buckets with their own scoped keys** per environment. A **filesystem adapter** behind the same interface is used **for tests/CI only** (hermetic, no credentials), not in the dev or prod path. **Extracted metadata stays in SQLite**; **Sensitive extracted *fields* (account/routing, full TIN) field-level encrypted** in the database; everything **partitioned by tenant** at the data layer. Build the storage seam first so nothing downstream hardcodes paths. *(Previously defaulted to filesystem; promoted to object storage so the encryption boundary and key scheme are built once, not retrofitted — see `IMPLEMENTATION_BRIEF.md` §2–3.)*

- **Tenant partitioning is structural**, not just UI filtering — every document, extracted field, and audit record carries its tenant and is queried within it (see [[Platform Systems & Tenancy]]). Object keys are **tenant-prefixed** (`tenants/{tenant_id}/vendors/{vendor_id}/{document_id}`) so retention, export, and offboard-purge are clean prefix operations.
- **Encryption in transit** — TLS for every connection (vendor uploads, internal access, API).
- **Encryption at rest** — document files are **envelope-encrypted app-side before upload** (a random per-object data key encrypts the bytes; the data key is wrapped by a master key held outside the DB *and* the bucket), so a leaked bucket yields ciphertext, not COIs. Sensitive *fields* are field-level encrypted in the DB. Bytes proxy through the server both ways (encrypt on write / decrypt on read); **presigned direct-to-bucket URLs are deferred** — they pair with provider-managed SSE-KMS, a later per-bucket swap. Provider SSE is fine as defense-in-depth but is not the trust boundary. *(Key-management specifics deferred — don't over-spec here.)*

## Tenant isolation

- Every document belongs to **exactly one tenant**. No cross-tenant read, ever.
- **Vendors are per-tenant isolated** (confirmed platform decision): a vendor serving both Acme and New Age has **two separate document sets** and submits to each independently. No cross-tenant document reuse (see [[Platform Systems & Tenancy]]).
- Platform staff have **no standing access** to a tenant's Sensitive data; they reach it only via **logged impersonation** during support (see [[Platform Systems & Tenancy]]).

## Access control & masking

**Sensitive data is Admin-only — no new role** (decision). The tenant role matrix stays Admin / District Manager / Store Manager (see [[Roles & Permissions]]); no Finance/AP role is introduced.

| Role | Standard data | Sensitive data (ACH / full TIN) |
|---|---|---|
| **Admin** | Full (org-wide) | **Full** |
| **District Manager** | Status + standard, **region** scope | **Masked** — sees the doc is *on file*, not its contents |
| **Store Manager** | Status + standard, **store** scope | **Masked** — on-file only, no contents |
| **Vendor** | Only their own submission (tokenized) | Their own only, while submitting |
| **Platform staff** | Impersonation only (logged) | Impersonation only (logged) |

- **Masking is enforced server-side**, role-gated at the data layer — Sensitive values are *not sent to the client* for unauthorized roles, not merely hidden in the UI. (Echoes the [[Vendor Record]]: blocked by role, not just visually hidden.)
- **Minimize exposure:** the Store Manager who *invited* a vendor never sees that vendor's banking or tax contents. This is deliberate — it's what lets onboarding promise the vendor their sensitive info is safe ([[Vendor Onboarding Workflow]]).

> **Decision to confirm:** do District/Store Managers see **COI contents** (the certificate itself), or only **status + that it's on file**? Default: **status only** — managers don't interpret compliance documents (MISSION: they never need to understand insurance). The Admin reviews the actual artifact on the [[Vendor Record]].

## Tokenized vendor access (no login)

Vendors never get an account. They reach the system only through **tokenized links** (onboarding, renewal, correction). Security properties, consolidated:

- **Single-purpose & scoped** — a token identifies one vendor/invite and grants access only to that vendor's own submission.
- **Expiring** — limited lifetime (onboarding default 14 days; see [[Vendor Onboarding Workflow]]); renewal/correction tokens are issued per event.
- **No standing credential** — a token is not a password; it can be revoked and re-issued (resend).
- A token never exposes other vendors, internal data, or another tenant.

## Access auditing

- **Every access to Sensitive data is logged** — who viewed or downloaded ACH/TIN, and when. Viewing sensitive data is itself an audited event (security + defensibility).
- Document views/downloads, decisions, and changes are logged to the [[Audit Trail]].
- *(Decision to confirm: is *standard*-document access also logged, or only Sensitive? Default: log Sensitive access always; standard access at a lighter grain.)*

## Retention & deletion

**Defined schedule, then purge-eligible** (decision):

- Documents and audit records are retained for a **defined schedule — default 7 years** — measured from when a record becomes **inactive**: a vendor is removed, a document is **superseded** by a renewal, or a tenant is **offboarded**.
- A **superseded document** (an old COI replaced by a renewal) is **not** deleted immediately — it's retained per schedule so the compliance history stays provable.
- After the retention window, records become **eligible for purge** (a deliberate purge process or an explicit request — not silent auto-deletion mid-window).
- **Offboarded tenants:** still **suspend + retain + export on demand** (see [[Platform Systems & Tenancy]]); the 7-year schedule then governs when retained data becomes purge-eligible.
- **Hard deletion** happens on explicit request or when purge-eligible per schedule. The **fact of deletion is itself logged** (the audit record of *what was deleted and when* is retained).

> This **refines** the open retention question in [[Platform Systems & Tenancy]] (previously "retain indefinitely until requested") to a **defined 7-year schedule**. 7 years aligns with common insurance/contract record-retention norms. *(Confirm the exact figure and whether it varies by jurisdiction; consider a legal-hold override that pauses purge.)*

## Defensibility tie-in

The [[Audit Trail]] is retained under this same schedule and is the spine of "prove it on demand" ([[Corporate Command Center]] export). The security model exists so that audit record is **trustworthy** — access-controlled, tenant-isolated, and tamper-evident (append-only is the ideal; confirm in the Audit Trail doc).

## Edge & error states

- **Upload fails to store:** never lose a vendor's submission silently — retry/queue and surface the failure; the vendor shouldn't have to re-do a successful upload.
- **Unauthorized access attempt** (a manager tries to reach masked Sensitive data): blocked server-side and **logged** as a security event.
- **Sensitive-data export:** only an Admin can export records containing Sensitive data; the export is logged.
- **Deletion request during the retention window:** honored per policy, but weigh a **legal-hold** exception (an active dispute/audit may require retention past a request). *(Flag for the Audit Trail / legal review.)*
- **Orphaned files** (DB record gone, file remains, or vice-versa): reconcile on a schedule; neither a dangling file nor a dangling pointer should linger.

## Open questions

- Storage mechanism — **resolved: S3-compatible object storage on Backblaze B2 behind a `BlobStore` interface (same driver dev + prod, separate buckets/keys), envelope-encrypted app-side, tenant-prefixed keys** (above); filesystem adapter for tests/CI only. Presigned-direct URLs deferred.
- Manager visibility of COI contents vs. status-only (above).
- Exact retention figure / per-jurisdiction variation + legal-hold override (above).
- Key-management specifics (deferred).
- Access-logging grain for standard documents (above).

## Links

- [[Roles & Permissions]] — the role matrix this enforces (Admin-only Sensitive access)
- [[Platform Systems & Tenancy]] — tenant isolation, offboard posture, retention (refined here)
- [[Vendor Onboarding Workflow]] — collects the Sensitive data; the trust promise this backs
- [[Vendor Record]] — where role-masking is visible; Admin-only Sensitive view
- [[Document Verification]] — produces the extracted Sensitive/Standard fields stored here
- [[AI Verification Engine]] — writes the extracted fields into this store (field-level encryption for Sensitive, tenant-partitioned); reads stored extractions for rules-only re-evaluation
- [[Audit Trail]] — the logged events and their retention (forward-linked; Segment 6)
- [[Corporate Command Center]] — the "prove it on demand" export this secures
- [[Audit Export Generation]] — applies the Sensitive (Admin-only) and Standard-only export rules defined here
- [[Search]] — excludes Sensitive fields from its index; honors server-side scope
