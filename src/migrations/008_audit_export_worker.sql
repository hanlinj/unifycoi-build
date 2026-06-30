-- Migration: 008_audit_export_worker
-- Phase 9 (Slice D): claim-then-generate column for the async audit-export worker.
-- status already supports 'queued' | 'generating' | 'ready' | 'failed' (migration 001).

ALTER TABLE audit_exports ADD COLUMN claimed_at TEXT;  -- when the export worker claimed the row (status='generating')

CREATE INDEX IF NOT EXISTS idx_audit_exports_queue ON audit_exports(status, created_at);
