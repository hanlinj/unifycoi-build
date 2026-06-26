-- Migration: 001_initial_schema
-- Full schema — verbatim from IMPLEMENTATION_BRIEF §3.
-- Tenant-scoped tables carry tenant_id on every row (invariant #2).
-- Sensitive columns are marked with -- SENSITIVE (field-level encrypted, never logged).
-- Timestamps: ISO-8601 TEXT throughout.

-- ─── Platform altitude (no tenant_id) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,          -- 'owner' | 'staff'
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  lifecycle_state   TEXT NOT NULL,      -- 'provisioning' | 'active' | 'suspended' | 'offboarded'
  monthly_rate_cents INTEGER NOT NULL DEFAULT 9000,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_snapshots (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  billable_locations INTEGER NOT NULL,
  amount_cents       INTEGER NOT NULL,
  changed            INTEGER NOT NULL,  -- bool: 1=differs from prior snapshot
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirement_templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ─── Tenant altitude (all carry tenant_id) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS regions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  region_id  TEXT REFERENCES regions(id),
  name       TEXT NOT NULL,
  address    TEXT,
  status     TEXT NOT NULL,             -- 'active' | 'archived'
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_regions (
  user_id   TEXT NOT NULL,
  region_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (user_id, region_id)
);

CREATE TABLE IF NOT EXISTS user_locations (
  user_id     TEXT NOT NULL,
  location_id TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE IF NOT EXISTS vendors (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  business_name TEXT NOT NULL,
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  trade         TEXT NOT NULL,          -- plumbing|electrical|gate_tech|landscaping|paving|other
  created_at    TEXT NOT NULL
);

-- Per-location status lives here (invariant #5). Overall is derived, never stored.
CREATE TABLE IF NOT EXISTS vendor_locations (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  vendor_id   TEXT NOT NULL REFERENCES vendors(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  status      TEXT NOT NULL,            -- invited_pending|onboarding|under_review|approved|
                                        -- expired|non_compliant|declined
  flags_json  TEXT,                     -- action_needed|expiring_soon|deficient|uncertain|
                                        -- unverified|bounced|expired_invite
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (tenant_id, vendor_id, location_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  vendor_id        TEXT REFERENCES vendors(id),
  inviter_user_id  TEXT NOT NULL REFERENCES users(id),
  token            TEXT UNIQUE NOT NULL,
  token_expires_at TEXT NOT NULL,
  purpose          TEXT NOT NULL,       -- 'onboarding' | 'renewal' | 'correction'
  delivery_state   TEXT NOT NULL,       -- 'sent' | 'unverified' | 'bounced' | 'expired_invite'
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  vendor_id         TEXT NOT NULL REFERENCES vendors(id),
  doc_type          TEXT NOT NULL,      -- 'coi' | 'w9' | 'ach' | 'license'
  storage_key       TEXT NOT NULL,      -- tenants/{tenant_id}/vendors/{vendor_id}/{document_id}
  encryption_json   TEXT NOT NULL,      -- {algo,iv,tag,wrapped_data_key}
  original_filename TEXT,
  superseded_by     TEXT REFERENCES documents(id),
  uploaded_at       TEXT NOT NULL
);

-- ─── Engine tables: verbatim from AI_Verification_Engine.md ──────────────────

CREATE TABLE IF NOT EXISTS extractions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  document_id        TEXT NOT NULL REFERENCES documents(id),
  doc_type           TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  extraction_version TEXT NOT NULL,
  payload_json       TEXT NOT NULL,     -- SENSITIVE leaves ciphertext, never logged
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  vendor_id      TEXT NOT NULL REFERENCES vendors(id),
  trigger        TEXT NOT NULL,         -- onboarding|resubmission|renewal|rule_change|location_add
  engine_version TEXT NOT NULL,
  recommendation TEXT NOT NULL,         -- 'approve' | 'deficiencies' | 'uncertain'
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirement_evaluations (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  run_id              TEXT NOT NULL REFERENCES verification_runs(id),
  vendor_id           TEXT NOT NULL REFERENCES vendors(id),
  location_id         TEXT NOT NULL REFERENCES locations(id),
  requirement_key     TEXT NOT NULL,
  required_value      TEXT,
  extracted_value_ref TEXT,
  comparison_result   TEXT NOT NULL,    -- 'meets' | 'fails' | 'indeterminate' | 'missing'
  confidence_band     TEXT,             -- 'high' | 'med' | 'low'
  outcome             TEXT NOT NULL,    -- 'pass' | 'deficient' | 'uncertain'
  note                TEXT
);

-- ─── Requirements ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS requirement_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  scope_type      TEXT NOT NULL,        -- 'org' | 'trade' | 'location'
  scope_ref       TEXT,                 -- null(org) | trade enum | location_id
  requirement_key TEXT NOT NULL,
  required_value  TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,        -- changes REQUIRE a reason (Audit_Trail.md)
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirement_settings (
  tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id),
  precedence_policy TEXT NOT NULL DEFAULT 'strictest'  -- 'strictest' | 'location' | 'trade'
);

-- ─── Audit (append-only / immutable — invariant #10) ─────────────────────────

CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  actor_type   TEXT NOT NULL,           -- 'system' | 'ai' | 'user' | 'vendor' | 'platform'
  actor_id     TEXT,
  event_type   TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  payload_json TEXT,                    -- Sensitive values REDACTED
  created_at   TEXT NOT NULL
);

-- ─── Notifications ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  recipient_type TEXT NOT NULL,         -- 'user' | 'vendor'
  recipient_ref  TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'email',
  kind           TEXT NOT NULL,         -- 'exception' | 'digest'
  status         TEXT NOT NULL,         -- 'queued' | 'sent' | 'failed' | 'bounced'
  scheduled_for  TEXT,
  sent_at        TEXT,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- ─── Exports ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_exports (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  requested_by       TEXT NOT NULL REFERENCES users(id),
  scope_type         TEXT NOT NULL,     -- 'vendor' | 'location' | 'region' | 'org' | 'tenant_offboard'
  scope_ref          TEXT,
  format             TEXT NOT NULL,     -- 'pdf' | 'csv'
  includes_sensitive INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,     -- 'queued' | 'generating' | 'ready' | 'failed'
  storage_key        TEXT,
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);

-- ─── Indexes (§3 minimum set) ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_vendor_locations_tenant_status
  ON vendor_locations(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_vendor
  ON documents(tenant_id, vendor_id);

-- extractions links via document_id, not vendor_id (AI_Verification_Engine.md is authoritative)
CREATE INDEX IF NOT EXISTS idx_extractions_tenant_document
  ON extractions(tenant_id, document_id);

CREATE INDEX IF NOT EXISTS idx_verification_runs_tenant_vendor
  ON verification_runs(tenant_id, vendor_id);

-- vendors uses business_name, not name
CREATE INDEX IF NOT EXISTS idx_vendors_tenant_business_name
  ON vendors(tenant_id, business_name);

CREATE INDEX IF NOT EXISTS idx_locations_tenant_name
  ON locations(tenant_id, name);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created
  ON audit_events(tenant_id, created_at);
