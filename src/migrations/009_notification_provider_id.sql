-- Migration: 009_notification_provider_id
-- Phase 11 (Slice 1): correlate a real ESP (Resend) delivery webhook back to the
-- notification row that produced the send.
--
-- The bounce/complaint webhook is cookie-less and carries NO tenant_id — Resend only
-- knows the message id it returned on send. Storing that id per row lets the webhook
-- resolve an event to a single tenant-scoped notification without trusting the
-- recipient email (which can collide across tenants). The status column already
-- anticipates the 'bounced' terminal value (001).

ALTER TABLE notifications ADD COLUMN provider_message_id TEXT;  -- Resend email id (set on send)

CREATE INDEX IF NOT EXISTS idx_notifications_provider_message_id
  ON notifications(provider_message_id);
