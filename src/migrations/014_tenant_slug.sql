-- Migration: 014_tenant_slug
-- Phase 12 (Slice 4): tenant slug for the provisioning wizard's Tenant step.
-- Net-new (not in IMPLEMENTATION_BRIEF/vault schema) — owner-directed deviation from
-- New_Client_Provisioning_Workflow.md's "duplicate org name: warn; allow if intentional"
-- (soft-warn). Slug uniqueness is a HARD block instead, per explicit Slice 4 instruction.
-- Nullable: existing tenants (created before this migration) keep NULL; provisioning
-- validates+requires it going forward. SQLite treats each NULL as distinct under a UNIQUE
-- index, so multiple pre-existing NULL slugs coexist fine.

ALTER TABLE tenants ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
