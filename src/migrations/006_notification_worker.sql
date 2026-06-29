-- Migration: 006_notification_worker
-- Phase 7 (Slice C): columns + index for the eager-scheduled renewal ladder and the
-- claim-then-send worker.
--
-- status now also uses: 'sending' (claimed by a worker, mid-send) and 'superseded'
-- (an unfired reminder canceled because a renewal replaced the document). The column is
-- free-text TEXT (no CHECK), so no constraint change is needed — documented here.

ALTER TABLE notifications ADD COLUMN claimed_at  TEXT;  -- when a worker claimed the row (status='sending')
ALTER TABLE notifications ADD COLUMN document_id TEXT REFERENCES documents(id);  -- the COI a reminder chases (for supersession)

-- Worker poll: due rows are status='queued' with scheduled_for null or past.
CREATE INDEX IF NOT EXISTS idx_notifications_due
  ON notifications(status, scheduled_for);

-- Supersession lookup: unfired reminders for a given document.
CREATE INDEX IF NOT EXISTS idx_notifications_document
  ON notifications(tenant_id, document_id);
