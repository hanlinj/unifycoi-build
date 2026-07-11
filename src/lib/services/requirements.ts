import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { isStricter } from '@/lib/requirements/resolver';
import { triggerRuleChangeReeval } from '@/lib/requirements/re-eval';
import { VALID_TRADES as SHARED_TRADES } from '@/lib/trades';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ScopeType = 'org' | 'trade' | 'location';
export type Precedence = 'strictest' | 'location' | 'trade';

export interface RequirementRuleRow {
  id: string;
  tenant_id: string;
  scope_type: ScopeType;
  scope_ref: string | null;
  requirement_key: string;
  required_value: string;
  created_by: string;
  reason: string;
  created_at: string;
}

export interface SetRuleInput {
  scope: ScopeType;
  scope_ref: string | null;
  requirement_key: string;
  required_value: string;
  reason: string;
}

// Valid trades from the vendor schema
// Trade overrides validate against the SAME shared enum the invite/vendor surface uses
// (Requirements_Configuration.md: trade overrides use the invite Primary Niche). Re-exported
// as REQUIREMENT_TRADES for the config UI's selectors.
export { VALID_TRADES as REQUIREMENT_TRADES } from '@/lib/trades';
const VALID_TRADES = new Set<string>(SHARED_TRADES);

// ─── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns the current layered rules (latest per key per scope) and settings for
 * the requirements configuration screen.
 */
export async function getRequirements(
  db: Db,
  tenantId: string
): Promise<{
  rules: { org: RequirementRuleRow[]; trade: RequirementRuleRow[]; location: RequirementRuleRow[] };
  precedence: Precedence;
  floor: Record<string, string>;
}> {
  const tdb = new TenantDB(db, tenantId);

  // Load all rules, newest-first; deduplicate by (scope_type, scope_ref, requirement_key)
  const allRules = await tdb.all<RequirementRuleRow>(
    `SELECT id, tenant_id, scope_type, scope_ref, requirement_key, required_value,
            created_by, reason, created_at
     FROM requirement_rules
     WHERE tenant_id = $1
     ORDER BY created_at DESC`
  );

  // Deduplicate: keep latest per (scope_type, scope_ref, key) — allRules sorted newest-first
  const seen = new Set<string>();
  const current: RequirementRuleRow[] = [];
  for (const r of allRules) {
    const dedupeKey = `${r.scope_type}|${r.scope_ref ?? ''}|${r.requirement_key}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      current.push(r);
    }
  }

  // floor_json is jsonb — Kysely/pg returns it already parsed, never JSON.parse() it.
  const settings = await tdb.get<{ precedence_policy: Precedence; floor_json: Record<string, string> | null }>(
    'SELECT precedence_policy, floor_json FROM requirement_settings WHERE tenant_id = $1'
  );

  return {
    rules: {
      org: current.filter((r) => r.scope_type === 'org'),
      trade: current.filter((r) => r.scope_type === 'trade'),
      location: current.filter((r) => r.scope_type === 'location'),
    },
    precedence: settings?.precedence_policy ?? 'strictest',
    floor: settings?.floor_json ?? {},
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────────

/**
 * Set (create or supersede) a single requirement rule.
 *
 * Each change creates a new row — the history accumulates in requirement_rules; the
 * resolver always reads the latest per key. The audit event records old → new.
 * The reason field is mandatory (audit invariant #10).
 *
 * Validates:
 *   - scope_ref is valid for the given scope type
 *   - required_value is not below the platform floor (if a floor exists for this key)
 */
export async function setRequirementRule(
  db: Db,
  tenantId: string,
  input: SetRuleInput,
  actorId: string
): Promise<RequirementRuleRow> {
  const tdb = new TenantDB(db, tenantId);

  // Validate scope_ref
  if (input.scope === 'org' && input.scope_ref !== null) {
    throw Object.assign(new Error('scope_ref must be null for org scope'), { status: 400 });
  }
  if (input.scope === 'trade') {
    if (!input.scope_ref || !VALID_TRADES.has(input.scope_ref)) {
      throw Object.assign(
        new Error(`Invalid trade: ${input.scope_ref}. Valid: ${[...VALID_TRADES].join(', ')}`),
        { status: 400 }
      );
    }
  }
  if (input.scope === 'location') {
    if (!input.scope_ref) {
      throw Object.assign(new Error('scope_ref (location_id) required for location scope'), { status: 400 });
    }
    const loc = await tdb.get<{ id: string }>(
      'SELECT id FROM locations WHERE tenant_id = $1 AND id = $2',
      [input.scope_ref]
    );
    if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });
  }

  // Validate against floor. floor_json is jsonb — Kysely/pg returns it already parsed, never
  // JSON.parse() it.
  const settings = await tdb.get<{ floor_json: Record<string, string> | null }>(
    'SELECT floor_json FROM requirement_settings WHERE tenant_id = $1'
  );
  if (settings?.floor_json) {
    const floorValue = settings.floor_json[input.requirement_key];
    if (floorValue !== undefined && isStricter(floorValue, input.required_value)) {
      throw Object.assign(
        new Error(
          `Value "${input.required_value}" is below the platform floor "${floorValue}" for key "${input.requirement_key}"`
        ),
        { status: 422 }
      );
    }
  }

  // Find the current rule (if any) for audit diff
  const existing = await tdb.get<RequirementRuleRow>(
    `SELECT id, required_value FROM requirement_rules
     WHERE tenant_id = $1 AND scope_type = $2 AND scope_ref ${input.scope_ref === null ? 'IS NULL' : '= $3'}
       AND requirement_key = ${input.scope_ref === null ? '$3' : '$4'}
     ORDER BY created_at DESC LIMIT 1`,
    input.scope_ref === null
      ? [input.scope, input.requirement_key]
      : [input.scope, input.scope_ref, input.requirement_key]
  );

  const id = randomUUID();
  const now = new Date();

  await tdb.insert('requirement_rules', {
    id,
    scope_type: input.scope,
    scope_ref: input.scope_ref ?? null,
    requirement_key: input.requirement_key,
    required_value: input.required_value,
    created_by: actorId,
    reason: input.reason,
    created_at: now,
  });

  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'requirement.rule_changed',
    targetType: 'requirement_rule',
    targetId: id,
    payload: {
      scope: input.scope,
      scope_ref: input.scope_ref,
      requirement_key: input.requirement_key,
      old_value: existing?.required_value ?? null,
      new_value: input.required_value,
      reason: input.reason,
    },
  });

  // Re-evaluation hook (Phase 4 fills in the body)
  await triggerRuleChangeReeval(db, tenantId, input.requirement_key);

  return (await tdb.get<RequirementRuleRow>(
    `SELECT id, tenant_id, scope_type, scope_ref, requirement_key, required_value,
            created_by, reason, created_at
     FROM requirement_rules WHERE tenant_id = $1 AND id = $2`,
    [id]
  ))!;
}

// ─── Precedence ────────────────────────────────────────────────────────────────

export async function getPrecedence(db: Db, tenantId: string): Promise<Precedence> {
  const tdb = new TenantDB(db, tenantId);
  const row = await tdb.get<{ precedence_policy: Precedence }>(
    'SELECT precedence_policy FROM requirement_settings WHERE tenant_id = $1'
  );
  return row?.precedence_policy ?? 'strictest';
}

export async function setPrecedence(
  db: Db,
  tenantId: string,
  policy: Precedence,
  actorId: string,
  reason?: string
): Promise<void> {
  const old = await getPrecedence(db, tenantId);

  // Upsert requirement_settings
  await db
    .insertInto('requirement_settings')
    .values({ tenant_id: tenantId, precedence_policy: policy })
    .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ precedence_policy: policy }))
    .execute();

  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'requirement.precedence_changed',
    targetType: 'requirement_settings',
    targetId: tenantId,
    payload: { old_policy: old, new_policy: policy, ...(reason ? { reason } : {}) },
  });
}
