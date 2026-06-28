/**
 * Platform requirement templates — seeded once at startup.
 *
 * Templates define:
 *   floor    — the platform guardrail minimums the admin can never go below.
 *   defaults — the org-level rules inserted when the template is applied to a new tenant.
 *
 * requirement_key format:
 *   coverage.<coverage_type>.<limit_key>  — e.g. coverage.general_liability.each_occurrence
 *   coverage_required.<coverage_type>     — e.g. coverage_required.general_liability ("true")
 *   doc_required.<doc_type>               — e.g. doc_required.coi ("true")
 *   endorsement.<name>                    — e.g. endorsement.additional_insured ("true")
 *
 * Numeric values are string-encoded (e.g. "1000000"); boolean values are "true"/"false".
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export interface TemplatePayload {
  floor: Record<string, string>;
  defaults: Record<string, string>;
}

export interface RequirementTemplate {
  id: string;
  name: string;
  payload_json: string;
  created_at: string;
}

// ─── Fixture templates ────────────────────────────────────────────────────────

export const PLATFORM_TEMPLATES: Array<{ id: string; name: string; payload: TemplatePayload }> = [
  {
    id: 'tpl_standard_self_storage',
    name: 'Standard Self-Storage',
    payload: {
      floor: {
        'doc_required.coi': 'true',
        'doc_required.w9': 'true',
        'endorsement.additional_insured': 'true',
        'coverage_required.general_liability': 'true',
        'coverage.general_liability.each_occurrence': '500000',
        'coverage.general_liability.general_aggregate': '1000000',
      },
      defaults: {
        'doc_required.coi': 'true',
        'doc_required.w9': 'true',
        'endorsement.additional_insured': 'true',
        'endorsement.waiver_of_subrogation': 'false',
        'coverage_required.general_liability': 'true',
        'coverage_required.workers_comp': 'true',
        'coverage.general_liability.each_occurrence': '1000000',
        'coverage.general_liability.general_aggregate': '2000000',
        'coverage.general_liability.products_completed_ops_aggregate': '2000000',
        'coverage.workers_comp.el_each_accident': '500000',
        'coverage.workers_comp.el_disease_each_employee': '500000',
        'coverage.workers_comp.el_disease_policy_limit': '500000',
      },
    },
  },
  {
    id: 'tpl_premium_self_storage',
    name: 'Premium Self-Storage',
    payload: {
      floor: {
        'doc_required.coi': 'true',
        'doc_required.w9': 'true',
        'endorsement.additional_insured': 'true',
        'endorsement.waiver_of_subrogation': 'true',
        'coverage_required.general_liability': 'true',
        'coverage.general_liability.each_occurrence': '1000000',
        'coverage.general_liability.general_aggregate': '2000000',
      },
      defaults: {
        'doc_required.coi': 'true',
        'doc_required.w9': 'true',
        'endorsement.additional_insured': 'true',
        'endorsement.waiver_of_subrogation': 'true',
        'endorsement.primary_noncontributory': 'true',
        'coverage_required.general_liability': 'true',
        'coverage_required.umbrella_excess': 'true',
        'coverage_required.workers_comp': 'true',
        'coverage.general_liability.each_occurrence': '2000000',
        'coverage.general_liability.general_aggregate': '4000000',
        'coverage.general_liability.products_completed_ops_aggregate': '4000000',
        'coverage.umbrella_excess.each_occurrence': '5000000',
        'coverage.umbrella_excess.aggregate': '5000000',
        'coverage.workers_comp.el_each_accident': '1000000',
        'coverage.workers_comp.el_disease_each_employee': '1000000',
        'coverage.workers_comp.el_disease_policy_limit': '1000000',
      },
    },
  },
];

// ─── Seeder ───────────────────────────────────────────────────────────────────

/**
 * Insert platform templates that don't already exist. Idempotent — safe to call at
 * every startup. Uses stable IDs so re-seeding is a no-op for existing rows.
 */
export function seedTemplates(db: Database.Database): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO requirement_templates (id, name, payload_json, created_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  for (const tpl of PLATFORM_TEMPLATES) {
    stmt.run(tpl.id, tpl.name, JSON.stringify(tpl.payload), now);
  }
}

export function listTemplates(db: Database.Database): RequirementTemplate[] {
  return db
    .prepare('SELECT id, name, payload_json, created_at FROM requirement_templates ORDER BY name')
    .all() as RequirementTemplate[];
}

export function getTemplate(db: Database.Database, templateId: string): RequirementTemplate | null {
  return (
    (db
      .prepare('SELECT id, name, payload_json, created_at FROM requirement_templates WHERE id = ?')
      .get(templateId) as RequirementTemplate | undefined) ?? null
  );
}

/**
 * Apply a template to a tenant: seeds org-level requirement_rules from the template's
 * defaults, snapshots the floor into requirement_settings, and records which template
 * was applied on the tenant row.
 *
 * Idempotent within a transaction — called by New Client Provisioning when a tenant
 * transitions from 'provisioning' to 'active'.
 *
 * @param actorId  The platform user or admin who triggered provisioning.
 */
export function applyTemplate(
  db: Database.Database,
  tenantId: string,
  templateId: string,
  actorId: string
): void {
  const tpl = getTemplate(db, templateId);
  if (!tpl) throw Object.assign(new Error(`Template not found: ${templateId}`), { status: 404 });

  const payload = JSON.parse(tpl.payload_json) as TemplatePayload;
  const now = new Date().toISOString();

  db.transaction(() => {
    // Seed org-level requirement_rules from template defaults
    const insertRule = db.prepare(
      `INSERT INTO requirement_rules
         (id, tenant_id, scope_type, scope_ref, requirement_key, required_value, created_by, reason, created_at)
       VALUES (?, ?, 'org', NULL, ?, ?, ?, ?, ?)`
    );
    for (const [key, value] of Object.entries(payload.defaults)) {
      insertRule.run(randomUUID(), tenantId, key, value, actorId, 'Initial template application', now);
    }

    // Upsert requirement_settings with the floor snapshot
    db.prepare(
      `INSERT INTO requirement_settings (tenant_id, precedence_policy, floor_json)
       VALUES (?, 'strictest', ?)
       ON CONFLICT(tenant_id) DO UPDATE SET floor_json = excluded.floor_json`
    ).run(tenantId, JSON.stringify(payload.floor));

    // Record which template was applied
    db.prepare('UPDATE tenants SET applied_template_id = ? WHERE id = ?').run(templateId, tenantId);
  })();
}
