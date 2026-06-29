-- Migration: 007_retention
-- Phase 7 (Slice D): retention enforcement marking. v1 MARKS purge-eligibility only;
-- actual hard deletion (purge) is a separate, deliberate step — never auto-deleted here
-- (Document_Storage_and_Security.md, invariant #11).
--
-- Retention anchor ("inactive from"):
--   documents     → superseded_at (a renewal supersedes the old COI). Active documents are
--                   never purge-eligible. Vendor-removal / tenant-offboard anchors are not
--                   yet modeled — flagged as deferred in the Phase 7 checkpoint.
--   audit_events  → created_at (immutable point-in-time facts; brief §7 = same 7-year schedule).

ALTER TABLE documents ADD COLUMN superseded_at     TEXT;     -- set when superseded_by is set
ALTER TABLE documents ADD COLUMN purge_eligible    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN purge_eligible_at TEXT;     -- when the retention worker marked it

ALTER TABLE audit_events ADD COLUMN purge_eligible    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_events ADD COLUMN purge_eligible_at TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_retention    ON documents(purge_eligible, superseded_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_retention ON audit_events(purge_eligible, created_at);
