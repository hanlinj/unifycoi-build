// Central requirement_key -> human label map. The ONE place every surface (Compliance Grid,
// Unify Review summary) turns an internal key like "coverage.general_liability.each_occurrence"
// into plain English — so the two surfaces can never drift into showing different names for
// the same requirement. Never renders a raw dotted key: an unmapped key still gets a readable
// title-cased fallback, and is logged (console.warn) so it can be added here, but never breaks
// the render.

const KNOWN_LABELS: Record<string, string> = {
  named_insured_match: 'Named insured match',
  ach_payee_matches_legal_name: 'ACH payee name match',
  certificate_holder_match: 'Certificate holder match',
  entity_type: 'Entity type',
  workers_comp_exemption_claimed: "Workers' comp exemption claimed",
};

const COVERAGE_TYPE_LABELS: Record<string, string> = {
  general_liability: 'General liability',
  automobile_liability: 'Automobile liability',
  umbrella_excess: 'Umbrella / excess',
  umbrella: 'Umbrella / excess',
  workers_comp: "Workers' comp",
  employers_liability: "Employer's liability",
  professional_liability: 'Professional liability',
  pollution: 'Pollution liability',
  other: 'Other coverage',
};

const LIMIT_KEY_LABELS: Record<string, string> = {
  each_occurrence: 'each occurrence',
  general_aggregate: 'general aggregate',
  combined_single_limit: 'combined single limit',
  products_completed_operations: 'products/completed operations',
  personal_advertising_injury: 'personal & advertising injury',
};

const ENDORSEMENT_LABELS: Record<string, string> = {
  additional_insured: 'Additional insured listed',
  waiver_of_subrogation: 'Waiver of subrogation',
  primary_noncontributory: 'Primary & non-contributory',
};

const DOC_TYPE_ON_FILE_LABELS: Record<string, string> = {
  coi: 'COI on file',
  w9: 'W-9 on file',
  ach: 'ACH form on file',
};

function sentenceCase(s: string): string {
  const spaced = s.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Keys already warned about this process lifetime — avoids flooding logs on every render of
// the same unmapped key across repeated page loads/dev-server hot reloads.
const warnedKeys = new Set<string>();

/** internal requirement_key -> plain-English label. Never returns a raw dotted key. */
export function humanizeRequirementKey(key: string): string {
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key];

  const coverage = key.match(/^coverage\.([^.]+)\.(.+)$/);
  if (coverage) {
    const [, type, limit] = coverage;
    const typeLabel = COVERAGE_TYPE_LABELS[type] ?? sentenceCase(type);
    const limitLabel = LIMIT_KEY_LABELS[limit] ?? limit.replace(/_/g, ' ');
    return `${typeLabel} · ${limitLabel}`;
  }

  const coverageRequired = key.match(/^coverage_required\.(.+)$/);
  if (coverageRequired) {
    const type = coverageRequired[1];
    return COVERAGE_TYPE_LABELS[type] ?? sentenceCase(type);
  }

  const endorsement = key.match(/^endorsement\.(.+)$/);
  if (endorsement) {
    return ENDORSEMENT_LABELS[endorsement[1]] ?? sentenceCase(endorsement[1]);
  }

  const docRequired = key.match(/^doc_required\.(.+)$/);
  if (docRequired) {
    return DOC_TYPE_ON_FILE_LABELS[docRequired[1]] ?? `${docRequired[1].toUpperCase()} on file`;
  }

  if (!warnedKeys.has(key)) {
    warnedKeys.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[requirement-labels] unmapped requirement_key — add a label: ${key}`);
  }
  return titleCase(key.replace(/[._]/g, ' '));
}

/** requirement_key shapes whose values are inherently boolean-ish ("is this present/required"),
 *  not a real-world quantity or text to compare. Everything else (coverage.*.* dollar limits,
 *  certificate_holder_match/entity_type/named_insured_match/ach_payee_matches_legal_name text
 *  comparisons) keeps its real value — collapsing those to Yes/No would throw away the actual
 *  extracted text that makes the comparison meaningful. */
export function isPresenceKey(key: string): boolean {
  return (
    key.startsWith('coverage_required.') ||
    key.startsWith('endorsement.') ||
    key.startsWith('doc_required.')
  );
}

/** Render a presence-type value ('true'/'false'/'present'/null) as Yes/No/—; passes through
 *  anything else unchanged (non-presence keys keep their real value). */
export function formatGridValue(key: string, value: string | null): string {
  if (value === null) return '—';
  if (!isPresenceKey(key)) return value;
  if (value === 'true' || value === 'present') return 'Yes';
  if (value === 'false' || value === '0') return 'No';
  return value;
}
