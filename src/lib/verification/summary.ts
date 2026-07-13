// Unify Review summary — a short, deterministic narrative generated FROM the compliance
// grid's own comparison data (src/lib/verification/grid.ts). Never a fresh AI/LLM call: every
// count and requirement label in the sentence traces back to a grid row, so it can never
// contradict what the grid shows below it. Recommends; the admin decides — the closing
// sentence is always advisory ("review", "decide"), never "approved"/"declined".

import type { ComplianceGrid, GridRow } from './grid';

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const KNOWN_LABELS: Record<string, string> = {
  named_insured_match: 'Named Insured Match',
  ach_payee_matches_legal_name: 'ACH Payee Name Match',
  certificate_holder_match: 'Certificate Holder Match',
  entity_type: 'Entity Type',
  workers_comp_exemption_claimed: 'Workers Comp Exemption',
};

/** Mirrors the requirement_key shapes engine.ts recognizes — same humanizing convention as
 *  the Activity zone's titleCaseEventType (page.tsx): light regex + title-case, no new system. */
function humanizeRequirementKey(key: string): string {
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key];
  const coverage = key.match(/^coverage\.([^.]+)\.(.+)$/);
  if (coverage) return `${titleCase(coverage[1])} — ${titleCase(coverage[2])}`;
  const coverageRequired = key.match(/^coverage_required\.(.+)$/);
  if (coverageRequired) return `${titleCase(coverageRequired[1])} Coverage`;
  const endorsement = key.match(/^endorsement\.(.+)$/);
  if (endorsement) return `${titleCase(endorsement[1])} Endorsement`;
  const docRequired = key.match(/^doc_required\.(.+)$/);
  if (docRequired) return `${docRequired[1].toUpperCase()} on File`;
  return titleCase(key.replace(/[._]/g, ' '));
}

function listLabels(rows: GridRow[], max = 3): string {
  const labels = rows.map((r) => humanizeRequirementKey(r.requirementKey));
  if (labels.length <= max) return labels.join(', ');
  return `${labels.slice(0, max).join(', ')}, and ${labels.length - max} more`;
}

const reqWord = (n: number): string => (n === 1 ? 'requirement' : 'requirements');

/**
 * Build the 2-3 sentence Unify Review summary. Driven by the grid's actual gap/pass counts,
 * not by `recommendation` alone — `recommendation` only steers the lead phrasing/tone, so the
 * summary can never assert full compliance while the grid still shows a red row (e.g. a
 * verification_runs.recommendation computed before an admin-accepted uncertain finding, or a
 * grid `not_evaluated` row the engine's own rollup never saw).
 */
export function buildUnifyReviewSummary(
  grid: ComplianceGrid,
  recommendation: string,
  vendorName: string
): string {
  const allRows = grid.locations.flatMap((l) => l.rows);
  const total = allRows.length;

  if (total === 0) {
    return `No requirements resolved to evaluate for ${vendorName} — nothing to review yet.`;
  }

  const gaps = allRows.filter((r) => r.status === 'red');
  const passes = allRows.filter((r) => r.status === 'green');
  const facilityCount = grid.locations.length;
  const facilityWord = facilityCount === 1 ? 'facility' : 'facilities';

  if (gaps.length === 0) {
    return (
      `${vendorName} meets all ${total} ${reqWord(total)} the engine checked, across ${facilityCount} ${facilityWord}. ` +
      `This vendor looks ready — review the detail below and confirm.`
    );
  }

  const leadSentence = recommendation === 'uncertain'
    ? `${vendorName} has ${gaps.length} ${reqWord(gaps.length)} that ${gaps.length === 1 ? 'needs' : 'need'} a closer look before this can move forward: ${listLabels(gaps)}.`
    : `${vendorName} does not meet ${gaps.length} of ${total} ${reqWord(total)} across ${facilityCount} ${facilityWord}: ${listLabels(gaps)}.`;

  const reviewSentence = recommendation === 'uncertain'
    ? `Review the flagged items below — this needs your judgment, not just the engine's.`
    : `Review the gaps below before deciding whether to approve, request a correction, or decline.`;

  return (
    `${leadSentence} ` +
    `${passes.length} ${reqWord(passes.length)} ${passes.length === 1 ? 'is' : 'are'} met. ` +
    reviewSentence
  );
}
