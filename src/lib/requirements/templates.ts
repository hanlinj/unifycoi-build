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
import type { Db } from '@/lib/db/client';
import { withTransaction } from '@/lib/db/transaction';
import { logAudit } from '@/lib/audit';

export interface TemplatePayload {
  floor: Record<string, string>;
  defaults: Record<string, string>;
}

export interface RequirementTemplate {
  id: string;
  name: string;
  // jsonb column — Kysely/pg returns it already-parsed as an object, not a JSON string
  // (Phase 13 migration note: this differs from the old SQLite TEXT column, which needed
  // JSON.parse() on every read; do not re-parse this).
  payload_json: TemplatePayload;
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
export async function seedTemplates(db: Db): Promise<void> {
  const now = new Date();
  for (const tpl of PLATFORM_TEMPLATES) {
    await db
      .insertInto('requirement_templates')
      .values({ id: tpl.id, name: tpl.name, payload_json: JSON.stringify(tpl.payload), created_at: now })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

export async function listTemplates(db: Db): Promise<RequirementTemplate[]> {
  return db.selectFrom('requirement_templates').selectAll().orderBy('name').execute() as Promise<RequirementTemplate[]>;
}

export async function getTemplate(db: Db, templateId: string): Promise<RequirementTemplate | null> {
  const row = await db.selectFrom('requirement_templates').selectAll().where('id', '=', templateId).executeTakeFirst();
  return (row as RequirementTemplate | undefined) ?? null;
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
export async function applyTemplate(
  db: Db,
  tenantId: string,
  templateId: string,
  actorId: string
): Promise<void> {
  const tpl = await getTemplate(db, templateId);
  if (!tpl) throw Object.assign(new Error(`Template not found: ${templateId}`), { status: 404 });

  const payload = tpl.payload_json; // jsonb — already an object, not a JSON string (see RequirementTemplate)
  const now = new Date();

  await withTransaction(db, async (trx) => {
    // Seed org-level requirement_rules from template defaults
    for (const [key, value] of Object.entries(payload.defaults)) {
      await trx
        .insertInto('requirement_rules')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          scope_type: 'org',
          scope_ref: null,
          requirement_key: key,
          required_value: value,
          created_by: actorId,
          reason: 'Initial template application',
          created_at: now,
        })
        .execute();
    }

    // Upsert requirement_settings with the floor snapshot
    await trx
      .insertInto('requirement_settings')
      .values({ tenant_id: tenantId, precedence_policy: 'strictest', floor_json: JSON.stringify(payload.floor) })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ floor_json: JSON.stringify(payload.floor) }))
      .execute();

    // Record which template was applied
    await trx.updateTable('tenants').set({ applied_template_id: templateId }).where('id', '=', tenantId).execute();
  });

  // Audit the template application (provisioning). Spec: "template applications" are a
  // logged requirement-change event (Audit_Trail.md). Actor is the tenant admin who
  // triggers provisioning — the rules' created_by FK references tenant users(id), so the
  // actor is necessarily a tenant user, not the platform user. No Sensitive values here.
  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'requirement.template_applied',
    targetType: 'tenant',
    targetId: tenantId,
    payload: {
      template_id: templateId,
      template_name: tpl.name,
      defaults_count: Object.keys(payload.defaults).length,
    },
  });
}
