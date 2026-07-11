/**
 * Requirements Resolver — pure compute function + DB-backed entry point.
 *
 * The resolver is a pure, deterministic function: same inputs always yield the same
 * outputs. No side effects, no DB writes, no network calls. The AI engine calls
 * resolveRequirements() for each vendor × location pair; the rules-only re-evaluation
 * path (rule-change, location-add) calls the same function against stored extractions.
 *
 * Layering: org base → trade override → location override. When trade and location
 * both touch the same field, the tenant's precedence policy resolves the conflict.
 * The platform floor is the absolute backstop; no resolved value may fall below it.
 */

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';

export type Precedence = 'strictest' | 'location' | 'trade';

export interface RuleRow {
  id: string;
  scope_type: 'org' | 'trade' | 'location';
  scope_ref: string | null;
  requirement_key: string;
  required_value: string;
}

export interface ResolvedEntry {
  required_value: string;
  /** Which scope produced this value. 'floor' means the platform guardrail clamped it. */
  scope: 'org' | 'trade' | 'location' | 'floor';
  /** ID of the requirement_rules row, or null when scope='floor'. */
  rule_id: string | null;
}

export type RequirementMatrix = Record<string, ResolvedEntry>;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if value `a` is stricter (higher requirement) than value `b`.
 * Numeric: higher number is stricter (coverage limits).
 * Boolean string: 'true' is stricter than 'false' (required > not-required).
 */
export function isStricter(a: string, b: string): boolean {
  const aNum = Number(a);
  const bNum = Number(b);
  if (!isNaN(aNum) && !isNaN(bNum) && a !== '' && b !== '') return aNum > bNum;
  if (a === 'true' && b !== 'true') return true;
  return false;
}

/**
 * Given rules sorted newest-first, returns the latest rule per requirement_key.
 * Handles the case where a single key has been changed multiple times (history rows
 * accumulate; we always use the most recent).
 */
function latestPerKey(rules: RuleRow[]): Map<string, RuleRow> {
  const map = new Map<string, RuleRow>();
  for (const rule of rules) {
    if (!map.has(rule.requirement_key)) {
      map.set(rule.requirement_key, rule);
    }
  }
  return map;
}

// ─── Core pure function ───────────────────────────────────────────────────────

/**
 * Compute the effective requirement matrix from pre-loaded rule sets and floor.
 *
 * All three rule arrays must be sorted newest-first (by created_at DESC) so that
 * latestPerKey() picks the correct current value per key.
 *
 * @param orgRules       Org-scope rules for this tenant (scope_type='org').
 * @param tradeRules     Trade-scope rules for the vendor's trade.
 * @param locationRules  Location-scope rules for the specific location.
 * @param floor          Platform guardrail floor: { requirement_key → min_value }.
 * @param precedence     How to resolve trade-vs-location conflicts.
 */
export function computeRequirements(
  orgRules: RuleRow[],
  tradeRules: RuleRow[],
  locationRules: RuleRow[],
  floor: Record<string, string>,
  precedence: Precedence
): RequirementMatrix {
  const orgMap = latestPerKey(orgRules);
  const tradeMap = latestPerKey(tradeRules);
  const locationMap = latestPerKey(locationRules);

  const allKeys = new Set<string>([
    ...orgMap.keys(),
    ...tradeMap.keys(),
    ...locationMap.keys(),
    ...Object.keys(floor),
  ]);

  const matrix: RequirementMatrix = {};

  for (const key of allKeys) {
    const org = orgMap.get(key);
    const trade = tradeMap.get(key);
    const loc = locationMap.get(key);
    const floorValue = floor[key];

    let resolved: ResolvedEntry | null = null;

    if (!trade && !loc) {
      // No overrides — org base applies if it exists
      if (org) {
        resolved = { required_value: org.required_value, scope: 'org', rule_id: org.id };
      }
    } else if (trade && !loc) {
      // Trade override only; replaces org for this key
      resolved = { required_value: trade.required_value, scope: 'trade', rule_id: trade.id };
    } else if (!trade && loc) {
      // Location override only; replaces org for this key
      resolved = { required_value: loc.required_value, scope: 'location', rule_id: loc.id };
    } else {
      // Both trade and location override — precedence policy decides
      const tradeEntry: ResolvedEntry = { required_value: trade!.required_value, scope: 'trade', rule_id: trade!.id };
      const locEntry: ResolvedEntry = { required_value: loc!.required_value, scope: 'location', rule_id: loc!.id };

      if (precedence === 'location') {
        resolved = locEntry;
      } else if (precedence === 'trade') {
        resolved = tradeEntry;
      } else {
        // strictest: take the higher requirement; location is tiebreaker
        resolved = isStricter(trade!.required_value, loc!.required_value) ? tradeEntry : locEntry;
      }
    }

    // Floor enforcement — the platform guardrail can never be undercut
    if (floorValue !== undefined) {
      if (resolved === null || isStricter(floorValue, resolved.required_value)) {
        resolved = { required_value: floorValue, scope: 'floor', rule_id: null };
      }
    }

    if (resolved !== null) {
      matrix[key] = resolved;
    }
  }

  return matrix;
}

// ─── DB-backed entry point ────────────────────────────────────────────────────

/**
 * Load requirement rules from the DB and return the effective requirement matrix
 * for a given vendor trade × location pair.
 *
 * The precedence parameter should be read from requirement_settings by the caller
 * before invoking this function (the /api/requirements endpoints do this).
 */
export async function resolveRequirements(
  db: Db,
  input: {
    tenantId: string;
    vendorTrade: string;
    locationId: string;
    precedence: Precedence;
  }
): Promise<RequirementMatrix> {
  const tdb = new TenantDB(db, input.tenantId);

  // Load all rules for this tenant, newest-first so latestPerKey picks correctly
  const allRules = await tdb.all<RuleRow & { created_at: string }>(
    `SELECT id, scope_type, scope_ref, requirement_key, required_value, created_at
     FROM requirement_rules
     WHERE tenant_id = $1
     ORDER BY created_at DESC`
  );

  const orgRules = allRules.filter((r) => r.scope_type === 'org' && r.scope_ref === null);
  const tradeRules = allRules.filter(
    (r) => r.scope_type === 'trade' && r.scope_ref === input.vendorTrade
  );
  const locationRules = allRules.filter(
    (r) => r.scope_type === 'location' && r.scope_ref === input.locationId
  );

  // Load the floor snapshot stored when the template was applied. floor_json is jsonb —
  // Kysely/pg returns it already parsed, never JSON.parse() it.
  const settings = await tdb.get<{ floor_json: Record<string, string> | null }>(
    'SELECT floor_json FROM requirement_settings WHERE tenant_id = $1'
  );
  const floor: Record<string, string> = settings?.floor_json ?? {};

  return computeRequirements(orgRules, tradeRules, locationRules, floor, input.precedence);
}
