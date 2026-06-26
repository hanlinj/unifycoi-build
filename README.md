# UnifyCOI — Dev Setup

Vendor COI compliance for multi-location self-storage operators.

## Prerequisites

- Node.js 20+ (tested on 24)
- A [Backblaze B2](https://www.backblaze.com/b2/cloud-storage.html) account with a **dev bucket** and **scoped key**

---

## 1 — Configure Backblaze B2 (dev bucket)

1. Log in to the Backblaze console → **Buckets** → **Create a Bucket**
   - Bucket name: `unifycoi-dev` (or similar — keep it separate from prod)
   - Files in bucket: **Private**
2. Go to **App Keys** → **Add a New Application Key**
   - Name: `unifycoi-dev`
   - Allow access to: the dev bucket only
   - Type of access: **Read and Write**
   - Copy the **keyID** and **applicationKey** — you'll only see the applicationKey once.
3. Find your bucket's **S3 Endpoint** on the bucket page (e.g. `https://s3.us-west-004.backblazeb2.com`).
   The region segment (`us-west-004`) is the `S3_REGION` value.

---

## 2 — Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|---|---|
| `SQLITE_PATH` | Path to the SQLite database file (e.g. `./data/unifycoi.db`) |
| `STORAGE_DRIVER` | `s3` for dev/prod; `filesystem` is for tests/CI only |
| `S3_ENDPOINT` | Backblaze B2 S3 endpoint (e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `S3_REGION` | Region from the endpoint (e.g. `us-west-004`) |
| `S3_BUCKET` | Dev bucket name |
| `S3_ACCESS_KEY_ID` | B2 application key ID |
| `S3_SECRET_ACCESS_KEY` | B2 application key |
| `MASTER_KEK` | 32-byte hex master key encryption key (`openssl rand -hex 32`) |
| `FIELD_ENCRYPTION_KEY` | 32-byte hex field encryption key (`openssl rand -hex 32`) |
| `JWT_SECRET` | 32-byte hex JWT signing secret (`openssl rand -hex 32`) |
| `JWT_EXPIRES_IN` | Token lifetime, e.g. `8h` (default) |

Generate keys:

```bash
openssl rand -hex 32  # run three times: MASTER_KEK, FIELD_ENCRYPTION_KEY, JWT_SECRET
```

---

## 3 — Run migrations

Creates all schema tables and indexes in the SQLite database. Idempotent — safe to run multiple times.

```bash
npm run migrate
```

---

## 4 — Start the dev server

```bash
npm run dev
```

Visit [http://localhost:3000/api/health](http://localhost:3000/api/health) — should return `{"status":"ok","timestamp":"..."}`.

Missing required env vars cause an immediate startup error with a clear message.

---

## 5 — Run tests

Tests use an **in-memory SQLite** database and the **filesystem BlobStore adapter**. No B2 credentials required for CI.

```bash
npm test
```

---

## Architecture notes

- **No ORM** — all DB access uses `better-sqlite3` raw SQL.
- **Tenant isolation** — all tenant queries go through `TenantDB` which requires a `tenant_id` at construction; cross-tenant reads are structurally impossible.
- **BlobStore** — `put/get/delete` interface. S3 adapter targets Backblaze B2 (same driver in dev and prod, separate buckets). Filesystem adapter used in tests/CI only.
- **Envelope encryption** — each document file gets a random AES-256-GCM data key, wrapped by `MASTER_KEK`. `encryption_json` stored in the `documents` table.
- **Field-level encryption** — Sensitive DB fields (full TIN, ACH account/routing) encrypted with `FIELD_ENCRYPTION_KEY` using AES-256-GCM.
- **JWT** — HS256 tokens for internal/platform users. Vendors use tokens (not JWT).
