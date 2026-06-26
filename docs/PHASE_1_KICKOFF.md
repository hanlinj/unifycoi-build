# Phase 1 kickoff — paste into Claude Code

> Unzip this seed at your repo root — you get `CLAUDE.md` + `.env.example` + `.gitignore` at root and
> the vault at `docs/spec/UnifyCOI_Vault/`. Then `git init`, copy `.env.example` to `.env` and fill it
> in, and paste the prompt below into Claude Code. It scopes you to the foundation phase only.

---

Read `CLAUDE.md`, then `docs/spec/UnifyCOI_Vault/IMPLEMENTATION_BRIEF.md` (especially §2 stack,
§3 schema, §6 build order, §0 do-not-invent). We are building **Phase 1 (Foundation) only** — the
load-bearing seams everything else depends on. Do not build any product feature, surface, or
business endpoint this phase. Stop when Phase 1's acceptance criteria are met and summarize.

## Scope — build exactly this

1. **Scaffold** a Next.js 14 (App Router) + TypeScript project. Add `npm` scripts for `dev`,
   `migrate`, and `test`. Wire config from `.env` (see `.env.example`); fail fast on missing required vars.
2. **DB layer** — better-sqlite3 connection (raw, no ORM) at `SQLITE_PATH`. A small migration runner
   (idempotent, tracks applied migrations).
3. **Full schema as the initial migration** — implement **every table in brief §3 verbatim**
   (platform, tenant, engine, requirements, audit, notifications, exports), with the indexes §3 lists.
   No tables beyond §3.
4. **Tenant-scoping guard** — a query helper that all tenant-scoped reads/writes pass through and
   that injects/enforces `tenant_id`. Make cross-tenant reads structurally impossible, not a convention.
5. **`BlobStore` interface** (`put / get / delete`) with an **S3-compatible adapter** (targets
   **Backblaze B2** via `S3_ENDPOINT` + `S3_REGION`; same driver for dev and prod, separate buckets)
   and a **filesystem adapter used for tests/CI only**, selected by `STORAGE_DRIVER`. Object keys
   tenant-prefixed: `tenants/{tenant_id}/vendors/{vendor_id}/{document_id}`.
6. **Envelope-encryption util** — per-object random data key, wrapped by `MASTER_KEK`; encrypt before
   `put`, decrypt after `get`; persist `{algo, iv, wrapped_data_key}` shape for `documents.encryption_json`.
7. **Field-level encryption util** — encrypt/decrypt for Sensitive DB fields using `FIELD_ENCRYPTION_KEY`.
8. **JWT middleware** — issue + verify internal/platform sessions; reject missing/expired/invalid.
9. **Health check route** only (`GET /api/health`). No other routes.
10. **Dev README** — how to configure the B2 dev bucket + scoped key, run migrations, and start the
    app. (No local storage server; tests use the filesystem adapter.)

## Constraints

- Honor every locked invariant in `CLAUDE.md`. Never log Sensitive values.
- No ORM. No storage access outside `BlobStore`. No DB access outside the tenant-scoped helper.
- If anything you need isn't answered by the vault or brief §7 defaults, **stop and ask** — don't guess.

## Definition of done (Phase 1)

- `npm run dev` boots; missing required env vars fail loudly.
- `npm run migrate` is idempotent and creates all §3 tables + indexes.
- A unit test proves a tenant-scoped query **cannot** run without a `tenant_id`.
- `BlobStore` round-trip (`put → get → delete`) passes against the **B2 dev bucket** **and** the
  filesystem adapter (the latter is what CI runs).
- Envelope encryption round-trips; the stored blob is ciphertext (≠ plaintext) at rest.
- Field-level encryption round-trips.
- JWT issue/verify works; bad/expired tokens are rejected.
- `GET /api/health` returns OK. No other routes exist.

When done: summarize what was built, list any assumptions, and stop. Do **not** begin Phase 2
(Tenancy & identity) until I tell you to.
