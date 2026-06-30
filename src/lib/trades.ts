// Single source of truth for the vendor trade enum (the invite "Primary Niche").
//
// Both the invite/vendor surface AND requirements trade-overrides import this — per
// Requirements_Configuration.md ("trade overrides use the Primary Niche enum from Invite
// Vendor Workflow"). Previously two diverging copies existed (vendors vs requirements); a rule
// could be scoped to a trade no vendor could have, and vice-versa. One list eliminates that.

// Superset of the two previously-divergent built enums' legitimate trades. The vendor enum's
// members are kept; `roofing` + `pest_control` (only in the old requirements enum, and the
// Requirements_Configuration scenario explicitly uses roofers) are folded in. Naming variants
// consolidate to the vendor names: old `gate_tech` → `gate_door`, old `paving` → `paving_asphalt`.
export const VALID_TRADES = [
  'plumbing', 'hvac', 'electrical', 'landscaping', 'sprinklers_irrigation',
  'paving_asphalt', 'handyman', 'security', 'cleaning', 'general_contractor',
  'gate_door', 'roofing', 'pest_control', 'other',
] as const;

export type Trade = typeof VALID_TRADES[number];
