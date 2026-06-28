-- Migration: 002_requirements_phase3
-- Adds applied_template_id to tenants (which template was applied at provisioning)
-- and floor_json to requirement_settings (snapshotted floor when template is applied).

ALTER TABLE tenants ADD COLUMN applied_template_id TEXT;
ALTER TABLE requirement_settings ADD COLUMN floor_json TEXT;
