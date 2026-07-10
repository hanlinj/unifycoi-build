-- Migration: 017_user_invite_sent_at
-- Phase 12 (Slice 5b, Feature 2): tracks the last time an invite link was issued to a user,
-- so the Users panel can distinguish "invited, no link sent" (created_at only) from "invited,
-- link already sent at least once" (invite_sent_at set) — the Send-invite/Resend-invite button
-- distinction. Same treatment as migration 016's `purpose` column: a new column, backfilled to
-- a deliberate default for existing rows.
--
-- NULL = never sent (the correct default for every pre-existing row — nobody has retroactively
-- had an invite link issued to them by this migration running). Every writer (sendUserInvite)
-- sets this explicitly to the current timestamp; nothing else touches it.

ALTER TABLE users ADD COLUMN invite_sent_at TEXT;
