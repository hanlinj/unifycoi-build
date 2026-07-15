// Unify Review summary — a short, deterministic narrative generated FROM the compliance
// grid's own comparison data (src/lib/verification/grid.ts). Never a fresh AI/LLM call: every
// count and requirement label in the sentence traces back to a grid row, so it can never
// contradict what the grid shows below it. Recommends; the admin decides — the closing
// sentence is always advisory ("review", "decide"), never "approved"/"declined".
//
// Documents are vendor-wide (one extraction bundle feeds every location's evaluation), so the
// SAME missing/failing requirement usually shows up as a red row at every location — that's
// one problem, not N. Everything below groups by requirementKey first: a requirement counts
// once, and its own group records exactly which locations it's red at, so a requirement that's
// genuinely location-specific (a location-scoped override, e.g. one site requiring higher GL)
// still gets its own scoped mention instead of being silently merged into the vendor-wide count.

import type { ComplianceGrid, GridRow } from './grid';
import { humanizeRequirementKey } from './requirement-labels';

interface DeficiencyGroup {
  requirementKey: string;
  // Which locations show this requirement as red — length === facilityCount means every
  // location has it (vendor-wide); length < facilityCount means it's location-specific
  // (almost always a location-scoped requirement override, since the underlying extraction
  // bundle itself never varies by location).
  locationNames: string[];
}

/** requirementKey -> {gap group | pass}, deduped once across the whole grid regardless of how
 *  many locations resolved it. A key with any red row anywhere is a gap; a key that's green
 *  everywhere it appears is a pass. Every requirementKey lands in exactly one bucket. */
function groupByRequirement(grid: ComplianceGrid): { gapGroups: DeficiencyGroup[]; passKeys: string[] } {
  const redLocationsByKey = new Map<string, string[]>();
  const allKeysSeen = new Set<string>();

  for (const loc of grid.locations) {
    for (const row of loc.rows) {
      allKeysSeen.add(row.requirementKey);
      if (row.status === 'red') {
        const locs = redLocationsByKey.get(row.requirementKey) ?? [];
        locs.push(loc.locationName);
        redLocationsByKey.set(row.requirementKey, locs);
      }
    }
  }

  const gapGroups = [...redLocationsByKey.entries()].map(([requirementKey, locationNames]) => ({
    requirementKey,
    locationNames,
  }));
  const passKeys = [...allKeysSeen].filter((k) => !redLocationsByKey.has(k));
  return { gapGroups, passKeys };
}

/** "A", "A and B", "A, B, and C", or "A, B, C, and 4 more" past `max`. */
function joinWithAnd(items: string[], max = 3): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  if (items.length <= max) return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  return `${items.slice(0, max).join(', ')}, and ${items.length - max} more`;
}

/** One deduped, scope-aware description of every distinct deficient requirement — vendor-wide
 *  ones named together with a shared "affects all N locations" note, location-specific ones
 *  named individually with their own location(s). Never repeats a requirement per location. */
function describeGapGroups(groups: DeficiencyGroup[], facilityCount: number): string {
  const vendorWide = groups.filter((g) => g.locationNames.length === facilityCount);
  const partial = groups.filter((g) => g.locationNames.length < facilityCount);

  const clauses: string[] = [];

  if (vendorWide.length > 0) {
    const labels = vendorWide.map((g) => humanizeRequirementKey(g.requirementKey));
    const joined = joinWithAnd(labels);
    clauses.push(
      facilityCount > 1
        ? `${joined} — ${vendorWide.length === 1 ? 'this affects' : 'these affect'} all ${facilityCount} locations`
        : joined
    );
  }

  for (const g of partial) {
    const label = humanizeRequirementKey(g.requirementKey);
    clauses.push(`${label} doesn't meet the requirement at ${joinWithAnd(g.locationNames)}`);
  }

  return clauses.join('; ');
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
  const allRows: GridRow[] = grid.locations.flatMap((l) => l.rows);

  if (allRows.length === 0) {
    return `No requirements resolved to evaluate for ${vendorName} — nothing to review yet.`;
  }

  const facilityCount = grid.locations.length;
  const facilityWord = facilityCount === 1 ? 'facility' : 'facilities';

  const { gapGroups, passKeys } = groupByRequirement(grid);
  const totalDistinct = gapGroups.length + passKeys.length;

  if (gapGroups.length === 0) {
    return (
      `${vendorName} meets all ${totalDistinct} ${reqWord(totalDistinct)} the engine checked, across ${facilityCount} ${facilityWord}. ` +
      `This vendor looks ready — review the detail below and confirm.`
    );
  }

  const gapDescription = describeGapGroups(gapGroups, facilityCount);

  const leadSentence = recommendation === 'uncertain'
    ? `${vendorName} has ${gapGroups.length} ${reqWord(gapGroups.length)} that ${gapGroups.length === 1 ? 'needs' : 'need'} a closer look before this can move forward: ${gapDescription}.`
    : `${vendorName} does not meet ${gapGroups.length} of ${totalDistinct} ${reqWord(totalDistinct)} across ${facilityCount} ${facilityWord}: ${gapDescription}.`;

  const reviewSentence = recommendation === 'uncertain'
    ? `Review the flagged items below — this needs your judgment, not just the engine's.`
    : `Review the gaps below before deciding whether to approve, request a correction, or decline.`;

  return (
    `${leadSentence} ` +
    `${passKeys.length} ${reqWord(passKeys.length)} ${passKeys.length === 1 ? 'is' : 'are'} met. ` +
    reviewSentence
  );
}
