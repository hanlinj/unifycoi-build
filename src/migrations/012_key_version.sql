-- Migration: 012_key_version
-- Phase 11 (Slice 5): SEC-13 key-version tag — a HOOK for future key rotation, NOT rotation.
--
-- Adds documents.key_version so a future rotation sweep can query blobs needing re-wrap
-- without JSON-extracting encryption_json. Existing rows get 1 (DEFAULT), so ALL existing
-- encrypted data still decrypts via the v1-default path. There is exactly one key version
-- today and no rotation is performed here — this only makes rotation possible later.
--
-- Field-encrypted columns (scattered across tables) are versioned in-value instead: the
-- decrypt path treats unversioned 3-part ciphertext as v1 and understands a future
-- `v<N>:iv:tag:ct` form (see src/lib/crypto/field.ts).

ALTER TABLE documents ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
