-- Migration: 004_invite_token_hashing
-- Semantic change: invites.token now stores SHA-256(raw_token) as a 64-char hex string.
-- The raw bearer token (32 CSPRNG bytes, base64url-encoded) goes to the vendor in the
-- invite link and is never stored in the DB. Lookup is always hash-first.
-- The UNIQUE constraint on invites.token provides the token-lookup index.
-- This migration adds the missing (tenant_id, vendor_id) index for list queries.

CREATE INDEX IF NOT EXISTS idx_invites_tenant_vendor
  ON invites(tenant_id, vendor_id);
