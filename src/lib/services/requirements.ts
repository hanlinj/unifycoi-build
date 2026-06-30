import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { isStricter } from '@/lib/requirements/resolver';
import { triggerRuleChangeReeval } from '@/lib/requirements/re-eval';

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
// NOTE (launch-prep): this trade enum differs from the vendors VALID_TRADES enum (Phase 5).
// Trade overrides validate against THIS set. The divergence is banked in the launch-prep audit.
export const REQUIREMENT_TRADES = [
  'plumbing', 'electrical', 'gate_tech', 'landscaping', 'paving', 'roofing',
  'hvac', 'pest_control', 'cleaning', 'security', 'other',
] as const;
const VALID_TRADES = new Set<string>(REQUIREMENT_TRADES);

// ─── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns the current layered rules (latest per key per scope) and settings for
 * the requirements configuration screen.
 */
export function getRequirements(
  db: Database.Database,
  tenantId: string
): {
  rules: { org: RequirementRuleRow[]; trade: RequirementRuleRow[]; location: RequirementRuleRow[] };
  precedence: Precedence;
  floor: Record<string, string>;
} {
  const tdb = new TenantDB(db, tenantId);

  // Load all rules, newest-first; deduplicate by (scope_type, scope_ref, requirement_key)
  const allRules = tdb.all<RequirementRuleRow>(
    `SELECT id, tenant_id, scope_type, scope_ref, requirement_key, required_value,
            created_by, reason, created_at
     FROM requirement_rules
     WHERE tenant_id = ?
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

  const settings = tdb.get<{ precedence_policy: Precedence; floor_json: string | null }>(
    'SELECT precedence_policy, floor_json FROM requirement_settings WHERE tenant_id = ?'
  );

  return {
    rules: {
      org: current.filter((r) => r.scope_type === 'org'),
      trade: current.filter((r) => r.scope_type === 'trade'),
      location: current.filter((r) => r.scope_type === 'location'),
    },
    precedence: settings?.precedence_policy ?? 'strictest',
    floor: settings?.floor_json ? (JSON.parse(settings.floor_json) as Record<string, string>) : {},
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
  db: Database.Database,
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
    const loc = tdb.get<{ id: string }>(
      'SELECT id FROM locations WHERE tenant_id = ? AND id = ?',
      [input.scope_ref]
    );
    if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });
  }

  // Validate against floor
  const settings = tdb.get<{ floor_json: string | null }>(
    'SELECT floor_json FROM requirement_settings WHERE tenant_id = ?'
  );
  if (settings?.floor_json) {
    const floor = JSON.parse(settings.floor_json) as Record<string, string>;
    const floorValue = floor[input.requirement_key];
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
  const existing = tdb.get<RequirementRuleRow>(
    `SELECT id, required_value FROM requirement_rules
     WHERE tenant_id = ? AND scope_type = ? AND scope_ref ${input.scope_ref === null ? 'IS NULL' : '= ?'}
       AND requirement_key = ?
     ORDER BY created_at DESC LIMIT 1`,
    input.scope_ref === null
      ? [input.scope, input.requirement_key]
      : [input.scope, input.scope_ref, input.requirement_key]
  );

  const id = randomUUID();
  const now = new Date().toISOString();

  tdb.insert('requirement_rules', {
    id,
    scope_type: input.scope,
    scope_ref: input.scope_ref ?? null,
    requirement_key: input.requirement_key,
    required_value: input.required_value,
    created_by: actorId,
    reason: input.reason,
    created_at: now,
  });

  logAudit(db, {
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

  return tdb.get<RequirementRuleRow>(
    `SELECT id, tenant_id, scope_type, scope_ref, requirement_key, required_value,
            created_by, reason, created_at
     FROM requirement_rules WHERE tenant_id = ? AND id = ?`,
    [id]
  )!;
}

// ─── Precedence ────────────────────────────────────────────────────────────────

export function getPrecedence(db: Database.Database, tenantId: string): Precedence {
  const tdb = new TenantDB(db, tenantId);
  const row = tdb.get<{ precedence_policy: Precedence }>(
    'SELECT precedence_policy FROM requirement_settings WHERE tenant_id = ?'
  );
  return row?.precedence_policy ?? 'strictest';
}

export function setPrecedence(
  db: Database.Database,
  tenantId: string,
  policy: Precedence,
  actorId: string,
  reason?: string
): void {
  const tdb = new TenantDB(db, tenantId);
  const old = getPrecedence(db, tenantId);

  // Upsert requirement_settings
  db.prepare(
    `INSERT INTO requirement_settings (tenant_id, precedence_policy)
     VALUES (?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET precedence_policy = excluded.precedence_policy`
  ).run(tenantId, policy);

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'requirement.precedence_changed',
    targetType: 'requirement_settings',
    targetId: tenantId,
    payload: { old_policy: old, new_policy: policy, ...(reason ? { reason } : {}) },
  });
}
