// Vendor overall-status derivation — shared by the Vendor Record profile page's header pill
// (src/app/vendors/[vendorId]/page.tsx) and the /vendors list's Status column. One derivation,
// not two: this used to be an inline deriveOverallStatus() on the profile page only.
//
// Fix applied here (the reason for the extraction, not just a move): declines were invisible
// in two cases.
//   1. Partial approval (e.g. approved at 2 of 3) never mentioned a decline at the third
//      location even when one existed — "Approved · 2 of 3 locations" with no hint.
//   2. With zero approved locations, the leading-status priority fallback picked
//      'under_review' (or any other in-progress status) over 'declined', hiding the decline
//      entirely.
// Whenever ANY in-scope location is declined (and it isn't the ONLY status present, which
// already resolves to a plain "Declined"), the label now always appends " · N declined".

import type { BadgeTone } from '@/components/ui';

export interface OverallStatus {
  label: string;
  tone: BadgeTone;
}

interface LocationLike {
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  invited_pending: 'Invited / Pending',
  onboarding: 'Onboarding',
  under_review: 'Under Review',
  approved: 'Approved',
  expired: 'Expired',
  non_compliant: 'Non-Compliant',
  declined: 'Declined',
};

/** Per-status display label — a single location's status, and the leading label inside
 *  deriveOverallStatus's zero-approved fallback branch. */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** Per-status Badge tone — the design system's own documented convention (Badge.tsx):
 *  approved→success, under_review→info, expired/non_compliant/declined→danger, else neutral. */
function statusTone(status: string): BadgeTone {
  if (status === 'approved') return 'success';
  if (status === 'declined' || status === 'expired' || status === 'non_compliant') return 'danger';
  if (status === 'under_review') return 'info';
  return 'neutral';
}

// Leading-status priority for the zero-approved fallback. 'declined' is deliberately excluded
// from this list — it no longer competes to lead; it's surfaced via the " · N declined" suffix
// instead (or, if it's the ONLY status present, via the dedicated all-declined branch below).
const LEADING_PRIORITY = ['under_review', 'onboarding', 'invited_pending', 'expired', 'non_compliant'];

/**
 * Derive one vendor-level status from its (already scope-filtered) locations.
 * - All approved            -> "Approved" (declines are impossible here: approvedCount === total).
 * - Some approved            -> "Approved · X of N" (+ " · D declined" when any are declined).
 * - None approved, mixed     -> the leading in-progress/terminal status (declined excluded from
 *                                the leading pick) + " · D declined" when any are declined.
 * - None approved, ALL declined -> "Declined" (nothing else to disambiguate).
 */
export function deriveOverallStatus(locations: LocationLike[]): OverallStatus {
  if (locations.length === 0) return { label: 'Unknown', tone: 'neutral' };

  const statuses = locations.map((l) => l.status);
  const total = statuses.length;
  const approvedCount = statuses.filter((s) => s === 'approved').length;
  const declinedCount = statuses.filter((s) => s === 'declined').length;
  const declinedSuffix = declinedCount > 0 ? ` · ${declinedCount} declined` : '';

  if (approvedCount === total) {
    return { label: 'Approved', tone: 'success' };
  }

  if (approvedCount > 0) {
    return {
      label: `Approved · ${approvedCount} of ${total}${declinedSuffix}`,
      tone: declinedCount > 0 ? 'danger' : 'success',
    };
  }

  const nonDeclined = statuses.filter((s) => s !== 'declined');
  if (nonDeclined.length === 0) {
    return { label: 'Declined', tone: 'danger' };
  }

  let lead = nonDeclined[0];
  for (const s of LEADING_PRIORITY) {
    if (nonDeclined.includes(s)) {
      lead = s;
      break;
    }
  }

  return {
    label: `${statusLabel(lead)}${declinedSuffix}`,
    tone: declinedCount > 0 ? 'danger' : statusTone(lead),
  };
}
