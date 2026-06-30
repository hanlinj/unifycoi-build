// Projects each report's data into ONE canonical table (title + optional subtitle + columns +
// rows) so the CSV and PDF renderers stay report-agnostic. Sensitive data is never present —
// the builders don't query it — so projection cannot reintroduce it.

import type { ReportKey, ReportResult } from './index';

export interface ReportTable {
  title: string;
  subtitle: string | null;
  columns: string[];
  rows: (string | number)[][];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function projectReport(key: ReportKey, result: ReportResult): ReportTable {
  const d = result.data as any;
  const title = result.meta.name;

  switch (key) {
    case 'compliance-posture':
      return {
        title,
        subtitle: `${d.snapshot.compliantPct}% compliant — ${d.snapshot.approved} approved of ${d.snapshot.total} vendor-locations`,
        columns: ['Month', 'Approved', 'Submitted', 'Expired', 'Non-compliant', 'Declined'],
        rows: (d.trend as any[]).map((t) => [t.period, t['vendor.approved'] ?? 0, t['vendor.submitted'] ?? 0, t['vendor.expired'] ?? 0, t['vendor.non_compliant_rule_change'] ?? 0, t['vendor.declined'] ?? 0]),
      };

    case 'renewal-forecast':
      return {
        title,
        subtitle: `≤30d: ${d.buckets.d30} · ≤60d: ${d.buckets.d60} · ≤90d: ${d.buckets.d90} · beyond: ${d.buckets.beyond}`,
        columns: ['Vendor', 'Trade', 'Locations', 'Expires', 'Days out', 'Next reminder'],
        rows: (d.rows as any[]).map((r) => [r.vendorName, r.trade, r.locations.join('; '), r.expirationDate.slice(0, 10), r.daysOut, r.nextRung != null ? `${r.nextRung}d` : '']),
      };

    case 'vendor-roster':
      return {
        title,
        subtitle: `${d.rows.length} vendors in scope`,
        columns: ['Vendor', 'Trade', 'Status', 'Locations', 'GL each occurrence', 'Additional insured', 'Waiver of subrogation'],
        rows: (d.rows as any[]).map((r) => [r.vendorName, r.trade, r.overallStatus, r.locations.join('; '), r.coverage.glEachOccurrence ?? '', boolText(r.coverage.additionalInsured), boolText(r.coverage.waiverOfSubrogation)]),
      };

    case 'onboarding-funnel':
      return {
        title,
        subtitle: d.note,
        columns: ['Stage', 'Reached', 'Conversion %', 'Median days in stage'],
        rows: [
          ['Invited', d.reached.invited, '', ''],
          ['Onboarding', d.reached.onboarding, numText(d.conversion.invited_to_onboarding), numText(d.medianDaysInStage.invited_to_onboarding)],
          ['Under Review', d.reached.underReview, numText(d.conversion.onboarding_to_review), numText(d.medianDaysInStage.onboarding_to_review)],
          ['Approved', d.reached.approved, numText(d.conversion.review_to_approved), numText(d.medianDaysInStage.review_to_approved)],
        ],
      };

    case 'deficiency-analysis':
      return {
        title,
        subtitle: `Range ${(d.range.from || '').slice(0, 10)} → ${(d.range.to || '').slice(0, 10)}`,
        columns: ['Requirement', 'Deficient', 'Uncertain', 'Total'],
        rows: (d.ranked as any[]).map((r) => [r.requirement_key, r.deficient, r.uncertain, r.total]),
      };

    case 'audit-readiness':
      return {
        title,
        subtitle: 'Management summary — see the Audit Export for the event-level record',
        columns: ['Metric', 'Value'],
        rows: [
          ['Compliant %', `${d.posture.compliantPct}%`],
          ['Approved vendor-locations', d.posture.approved],
          ['Total vendor-locations', d.posture.total],
          ['Open exceptions', d.openExceptions],
          ['Coverage gaps', d.coverageGaps],
          ['Renewal exposure (next 90 days)', d.renewalExposure90d],
        ],
      };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function boolText(v: boolean | null): string { return v == null ? '' : v ? 'Yes' : 'No'; }
function numText(v: number | null): string { return v == null ? '' : String(v); }
