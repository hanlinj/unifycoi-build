// Vendor list filter model — shared by the client FilterBar (src/app/vendors/FilterBar.tsx)
// and the server route (src/app/api/vendors/route.ts). One definition of the attribute
// registry, the operator set, the match semantics, and the URL encoding — not duplicated
// between client and server.
//
// This stage: four enum-type attributes (Status, Location, Trade, Invited by), two operators
// (is any of / is none of). Operators are keyed by TYPE, not by attribute, so a future 'date'
// type (Stage 3 — Invited date) adds one new registry entry here without touching how enum
// attributes work. Search (Stage 3) is a separate mechanism entirely, not an attribute.

import { statusLabel } from './status';
import { VALID_TRADES } from '@/lib/trades';

// ── Attribute registry ──────────────────────────────────────────────────────────────────

export type FilterAttributeType = 'enum'; // 'date' arrives in Stage 3

export interface FilterAttributeDef {
  key: string;
  label: string;
  type: FilterAttributeType;
}

export const FILTER_ATTRIBUTES: FilterAttributeDef[] = [
  { key: 'status', label: 'Status', type: 'enum' },
  { key: 'location', label: 'Location', type: 'enum' },
  { key: 'trade', label: 'Trade', type: 'enum' },
  { key: 'invitedBy', label: 'Invited by', type: 'enum' },
];

export function attributeDef(key: string): FilterAttributeDef | undefined {
  return FILTER_ATTRIBUTES.find((a) => a.key === key);
}

// ── Operators, keyed by attribute TYPE ──────────────────────────────────────────────────

export interface OperatorDef {
  operator: string;
  label: string;
}

export const OPERATORS_BY_TYPE: Record<FilterAttributeType, OperatorDef[]> = {
  enum: [
    { operator: 'is_any_of', label: 'is any of' },
    { operator: 'is_none_of', label: 'is none of' },
  ],
};

export const DEFAULT_OPERATOR_BY_TYPE: Record<FilterAttributeType, string> = {
  enum: 'is_any_of',
};

export function operatorLabel(type: FilterAttributeType, operator: string): string {
  return OPERATORS_BY_TYPE[type].find((o) => o.operator === operator)?.label ?? operator;
}

// ── Static value options (no query needed — not scope-sensitive) ───────────────────────

export interface FilterOption {
  value: string;
  label: string;
}

// Every vendor_locations.status value is a valid Status filter option, including 'declined' —
// the filter needs to be able to select on it even though the risk-queue-style surfaces treat
// declined-only vendors specially elsewhere (see isDeclinedOnly in command-center.ts, applied
// as a base scope clamp before filtering ever runs, not as a Status-attribute concern here).
const STATUS_VALUES = ['approved', 'under_review', 'onboarding', 'invited_pending', 'expired', 'non_compliant', 'declined'];
export const STATUS_OPTIONS: FilterOption[] = STATUS_VALUES.map((value) => ({ value, label: statusLabel(value) }));

function humanizeTrade(trade: string): string {
  return trade.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export const TRADE_OPTIONS: FilterOption[] = VALID_TRADES.map((value) => ({ value, label: humanizeTrade(value) }));

// ── A vendor filter, as carried in state and in the URL ─────────────────────────────────

export interface VendorFilter {
  attribute: string;
  operator: string;
  values: string[];
}

/**
 * Does a vendor match one filter? `matchSet` is that vendor's values for the filter's
 * attribute — e.g. its in-scope location statuses (Status/Location, which are per-location and
 * so can have more than one member) or a single-element array (Trade/Invited by, vendor-level).
 * An empty `values` array means the filter isn't configured yet ("Select…") — it doesn't
 * narrow anything, matching every vendor, so an in-progress chip never zeroes out the list.
 * is_any_of: at least one of matchSet is in values. is_none_of: none of matchSet is in values
 * — a vendor with an EMPTY matchSet (e.g. no invite on record for Invited by) vacuously passes
 * is_none_of for any values (it has none of them) and never passes is_any_of (it has none to
 * match).
 */
export function evaluateFilter(matchSet: string[], operator: string, values: string[]): boolean {
  if (values.length === 0) return true;
  const hit = matchSet.some((v) => values.includes(v));
  return operator === 'is_none_of' ? !hit : hit;
}

// ── URL encoding ─────────────────────────────────────────────────────────────────────────
// Bare `key=v1,v2` is is_any_of (the default operator) — so a deep link like
// `/vendors?status=expired` (Expired vendors card -> filtered list, a later stage) needs no
// operator ceremony. `key=none:v1,v2` is is_none_of. No special characters in the query KEY
// (avoids relying on `!`/other punctuation surviving every proxy/tool unmangled) — the operator
// rides in the value instead.

const NONE_PREFIX = 'none:';

export function filtersToSearchParams(filters: VendorFilter[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const f of filters) {
    if (f.values.length === 0) continue; // not yet configured — carries no filtering info
    const joined = f.values.join(',');
    params.set(f.attribute, f.operator === 'is_none_of' ? `${NONE_PREFIX}${joined}` : joined);
  }
  return params;
}

export function filtersFromSearchParams(params: URLSearchParams): VendorFilter[] {
  const filters: VendorFilter[] = [];
  for (const def of FILTER_ATTRIBUTES) {
    const raw = params.get(def.key);
    if (!raw) continue;
    const isNone = raw.startsWith(NONE_PREFIX);
    const rest = isNone ? raw.slice(NONE_PREFIX.length) : raw;
    const values = rest.split(',').map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) continue;
    const operator = isNone ? 'is_none_of' : DEFAULT_OPERATOR_BY_TYPE[def.type];
    filters.push({ attribute: def.key, operator, values });
  }
  return filters;
}
