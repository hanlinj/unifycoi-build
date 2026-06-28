-- Migration: 003_engine_advisories
-- Adds engine_advisories table (Phase 4: AI Verification Engine).
-- Also adds state column to documents for tracking expiration gate outcomes.

ALTER TABLE documents ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
-- state: 'active' | 'bounced_expired'

CREATE TABLE IF NOT EXISTS engine_advisories (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  vendor_id            TEXT NOT NULL REFERENCES vendors(id),
  verification_run_id  TEXT NOT NULL REFERENCES verification_runs(id),
  key                  TEXT NOT NULL,        -- e.g. coverage_continuity, personal_ach_account
  severity             TEXT NOT NULL,        -- 'info' | 'warn'
  message              TEXT NOT NULL,
  evidence_json        TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engine_advisories_tenant_vendor
  ON engine_advisories(tenant_id, vendor_id);
