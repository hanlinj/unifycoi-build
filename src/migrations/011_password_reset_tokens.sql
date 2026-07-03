-- Migration: 011_password_reset_tokens
-- Phase 11 (Slice 3): emailed password-reset flow (SEC-8).
--
-- Tenant-scoped (this phase resets TENANT users; platform-user reset is engineer-
-- provisioned and out of scope). Stores ONLY the SHA-256 hash of the raw token — the raw
-- token exists only in the emailed link, never in this table. Single-use (consumed_at),
-- short TTL (expires_at, ~1h set by the service). Confirm consumes one token and
-- invalidates all other outstanding tokens for the same user.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,      -- SHA-256(raw); raw is only ever in the emailed link
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,               -- set on use (single-use) or when invalidated
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(tenant_id, user_id);
