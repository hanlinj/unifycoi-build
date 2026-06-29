-- Migration: 005_tenant_timezone
-- Phase 7 (Slice B): per-tenant timezone for daily digest timing.
-- Nullable; when NULL the digest scheduler falls back to UTC + DIGEST_HOUR_LOCAL
-- (flagged in the Phase 7 checkpoint as a UTC-fallback default).

ALTER TABLE tenants ADD COLUMN timezone TEXT;  -- IANA tz name, e.g. 'America/Chicago'; NULL = UTC fallback
