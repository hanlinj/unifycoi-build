// Advisory flag generation — Phase 4.
//
// Advisory flags are observations outside the requirement matrix.
// They do NOT affect the verification_run.recommendation.
// They are NOT emitted by rules-only re-evaluations (rule_change, location_add).
//
// See AI_Verification_Engine.md § "Advisory flags".

import type { ExtractionBundle } from '@/lib/extraction/types';
import { getEngineDate, toIsoDateStr } from '@/lib/extraction/extractor';

export interface AdvisoryFlag {
  key: string;
  severity: 'info' | 'warn';
  message: string;
  evidence: string;
}

// ── coverage_continuity ───────────────────────────────────────────────────────
// Detect a possible coverage gap when a vendor appears to have recently switched
// carriers. All policies sharing the same very-recent effective date is the
// signal — suggesting a wholesale carrier change rather than a routine renewal.
// The Admin can then verify the prior carrier's expiration date for any gap.

const RECENCY_DAYS = 45; // flag if effective date is within last 45 days of the reference date

function detectCoverageContinuity(bundle: ExtractionBundle): AdvisoryFlag | null {
  const coi = bundle.coi;
  if (!coi || coi.policies.length === 0) return null;

  const effectiveDates = coi.policies
    .map((p) => p.effective_date?.value)
    .filter((d): d is string => !!d);

  if (effectiveDates.length === 0) return null;

  // All policies must share the same effective date (wholesale carrier switch indicator).
  const uniqueEffective = [...new Set(effectiveDates)];
  if (uniqueEffective.length > 1) return null;

  const earliestEffective = effectiveDates[0];
  // Normalize date strings — model may return ISO (YYYY-MM-DD) or US (MM/DD/YYYY)
  const isoDate = toIsoDateStr(earliestEffective);
  const effectiveDate = isoDate ? new Date(isoDate + 'T00:00:00Z') : null;
  if (!effectiveDate || isNaN(effectiveDate.getTime())) return null;

  // Only flag when the effective date is very recent (suggesting a fresh carrier switch).
  // Routine annual renewals are submitted months before/after; only a recent change
  // implies a potential gap from the prior carrier's expected expiration.
  const referenceDate = getEngineDate();
  const daysSinceEffective = Math.floor(
    (referenceDate.getTime() - effectiveDate.getTime()) / 86400000
  );
  if (daysSinceEffective < 0 || daysSinceEffective > RECENCY_DAYS) return null;

  return {
    key: 'coverage_continuity',
    severity: 'warn',
    message: `New carrier effective ${earliestEffective} implies a possible coverage gap vs. the prior carrier's expected expiration. Current policies are fully compliant; prior expiration date needed to confirm no gap.`,
    evidence: `All current policy effective dates: ${earliestEffective} (${daysSinceEffective} day(s) before evaluation date). Prior carrier expiration unknown — Admin should verify continuity.`,
  };
}

// ── personal_ach_account ──────────────────────────────────────────────────────
// ACH account holder name is an individual name while the vendor's W-9 shows
// an LLC/Corp classification — or vice versa (sole proprietor, personal account).

function detectPersonalAchAccount(bundle: ExtractionBundle): AdvisoryFlag | null {
  const ach = bundle.ach;
  const w9 = bundle.w9;
  if (!ach || !w9) return null;

  const achName = ach.account_holder_name?.value ?? null;
  const w9Classification = w9.federal_tax_classification?.value ?? null;
  const tinType = w9.tin_type?.value ?? null;

  if (!achName || !w9Classification) return null;

  const isLLC = w9Classification.toLowerCase().includes('llc')
    || w9Classification.toLowerCase().includes('corporation')
    || w9Classification.toLowerCase().includes('corp')
    || w9Classification.toLowerCase().includes('partnership');

  const isSoleProprietor = w9Classification.toLowerCase().includes('individual')
    || w9Classification.toLowerCase().includes('sole proprietor');

  const hasSSN = tinType?.toUpperCase() === 'SSN';

  // Flag if: sole proprietor OR uses SSN (suggests personal account)
  if (isSoleProprietor || hasSSN) {
    const w9LegalName = w9.legal_name?.value ?? 'unknown';
    return {
      key: 'personal_ach_account',
      severity: 'warn',
      message: `ACH account holder "${achName}" appears to be a personal account. Payments will disburse to an individual rather than a business entity.`,
      evidence: `ACH account_holder_name: "${achName}"; W-9 federal_tax_classification: "${w9Classification}"; W-9 TIN type: ${tinType ?? 'unknown'} (legal name: "${w9LegalName}").`,
    };
  }

  return null;
}

// ── Public entry point ─────────────────────────────────────────────────────────

export function generateAdvisories(bundle: ExtractionBundle): AdvisoryFlag[] {
  const flags: AdvisoryFlag[] = [];

  const continuity = detectCoverageContinuity(bundle);
  if (continuity) flags.push(continuity);

  const personalAch = detectPersonalAchAccount(bundle);
  if (personalAch) flags.push(personalAch);

  return flags;
}
