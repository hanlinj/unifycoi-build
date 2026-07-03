-- Migration: 010_login_rate_limit
-- Phase 11 (Slice 2): DB-backed rolling-window login throttle (SEC-9).
--
-- A cross-cutting security control — like the notification worker, it legitimately spans
-- tenants and is NOT tenant-scoped: a failed login may resolve to no tenant at all, and
-- per-IP throttling is cross-tenant by design.
--
-- One row per FAILED attempt, per scope. The lock is DERIVED from windowed counts (no
-- separate lock row): within the window,
--   count(scope='email') >= LOGIN_MAX_PER_EMAIL  → that email is soft-locked
--   count(scope='ip')    >= LOGIN_MAX_PER_IP     → that IP is throttled
-- A successful login DELETES the email scope (clears the soft lock); the IP scope is a
-- rolling window and is deliberately NOT reset by one success (one valid login must not
-- wipe an attacker's IP count). Deleting the email scope is also the exact seam a future
-- platform-dashboard operator-unlock action will call — data model only this phase.
-- Blocked attempts are NOT recorded, so the window ages out and the soft lock self-lifts.

CREATE TABLE IF NOT EXISTS login_attempts (
  id         TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,   -- 'email' | 'ip'
  scope_key  TEXT NOT NULL,   -- normalized email (trimmed/lowercased) | client ip
  created_at TEXT NOT NULL    -- ISO8601; window math compares against this
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_scope
  ON login_attempts(scope_type, scope_key, created_at);
