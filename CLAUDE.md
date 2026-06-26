# CLAUDE.md — UnifyCOI

UnifyCOI is a B2B SaaS that automates vendor COI (certificate-of-insurance) compliance for
multi-location self-storage operators. This file is the standing contract for every Claude Code
session in this repo. Read it first, every time.

## Source of truth & read order

The spec vault lives at **`docs/spec/UnifyCOI_Vault/`**. It — not your inference — defines the
product. Before writing code for any task, read in this order:

1. **`MISSION.md`** — north star + the 13 numbered tiebreaker principles + non-goals.
2. **`UnifyCOI_Build_Checklist.md`** — the index and the "don't re-litigate" list of locked decisions.
3. **`IMPLEMENTATION_BRIEF.md`** — the compile target: stack · schema · routes · endpoints · build
   order · do-not-invent guardrail · v1 defaults for every open decision.
4. The specific spec doc(s) for the surface/workflow/system you're touching.

If `IMPLEMENTATION_BRIEF.md` and a spec doc ever disagree, **the spec doc wins** — flag it, don't
silently pick one.

## Prime directive — do not invent beyond spec

Build **exactly** the tables, routes, and endpoints the brief enumerates. No extra entities, no
speculative columns, no "while I'm here" features. Honor the MISSION non-goals (not a doc store, not
an AP system, not a marketplace, not a comms platform, not a generic COI tool). For any impulse to
add something, run the **Focus Test**: *does this help operators onboard, verify, monitor, approve,
or maintain compliant vendors?* If no → don't build it. When something genuinely isn't covered by
the vault or the brief's §7 defaults, **stop and ask** — do not guess.

## Locked invariants (never violate)

1. Three altitudes stay distinct: Platform / Tenant / within-tenant. `platform_users` and tenant
   `users` are separate identity spaces.
2. Tenant isolation is **structural** — every tenant-scoped row carries `tenant_id` and is queried
   within it. No cross-tenant read, ever.
3. Vendors are per-tenant isolated. Collect-once reuse is within a tenant only.
4. **Only Admin approves.** AI verifies + recommends; a human always clicks. Managers have no approve action.
5. Status is **per-location** (on `vendor_locations`); overall is derived.
6. Expiration is an objective vendor-upload gate — an expired policy bounces to the vendor and
   never reaches the Admin. The engine extracts dates; it does not decide on them.
7. Rules-only re-eval (rule-change, location-add) reads **stored extractions** — no Vision call.
   Renewals re-extract.
8. Sensitive data (full TIN, ACH account/routing) is **Admin-only, masked server-side** — not in the UI.
9. Email-only notifications v1: exceptions immediate, routine daily digest. Vendor comms branded as the operator.
10. Audit trail is append-only/immutable, attributed, tenant-isolated; Sensitive values redacted in payloads.
11. 7-year retention then purge-eligible; superseded docs retained, not deleted; deletion is logged.
12. Two app shells + tokenized vendor flow; one role-conditional tenant sidebar; vendors have no nav/login.

## Stack (pinned — do not substitute)

Next.js 14 (App Router) · TypeScript · **better-sqlite3 (raw, no ORM)** · Claude Vision via the
Anthropic API (server-side, forced structured output) · JWT for internal users, **tokens** for
vendors · S3-compatible object storage on **Backblaze B2** behind a `BlobStore` interface (same
driver dev + prod, separate buckets/keys; filesystem adapter for tests/CI only),
documents **envelope-encrypted app-side**, Sensitive DB fields field-level encrypted.

## Standing conventions

- **Every DB read/write goes through the tenant-scoped query helper** that injects `tenant_id`.
  Never write a raw query that could read across tenants.
- **All file I/O goes through `BlobStore`.** Never touch `fs` or an S3 client directly outside the
  adapter. Object keys are tenant-prefixed: `tenants/{tenant_id}/vendors/{vendor_id}/{document_id}`.
- **Never log Sensitive values** (full TIN, account/routing) — redact in audit payloads and logs.
- The rules engine is a **pure deterministic function** — no model call, no side effects.
- Match the schema in brief §3 exactly; the three engine tables are verbatim from `AI_Verification_Engine.md`.

## Build discipline

- Build **one build-order phase at a time** (brief §6). Do not start the next phase until the
  current one is checkpointed and verified.
- Each phase is a PR-sized unit; the §8 "definition of done" is the gate.
- At the end of a phase, **stop and summarize what was built + what's next** — don't run ahead.
- Schema-as-migrations lands before any feature reads/writes data.
