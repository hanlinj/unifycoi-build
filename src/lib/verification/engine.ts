// Rules engine — pure deterministic function (AI_Verification_Engine.md).
// (extracted_values, resolved_requirement_matrix) → per-requirement evaluations.
// No model call, no side effects. Same inputs always produce same outputs.

import type { RequirementMatrix } from '@/lib/requirements/resolver';
import type {
  ExtractionBundle,
  ProcessedCOIExtraction,
  ProcessedW9Extraction,
  ProcessedACHExtraction,
  ConfBand,
  FieldValue,
} from '@/lib/extraction/types';

export type ComparisonResult = 'meets' | 'fails' | 'indeterminate' | 'missing';
export type EvaluationOutcome = 'pass' | 'deficient' | 'uncertain';

export interface EvaluationResult {
  requirementKey: string;
  requiredValue: string | null;
  extractedValueRef: string | null;
  comparisonResult: ComparisonResult;
  confidenceBand: ConfBand | null;
  outcome: EvaluationOutcome;
  note: string | null;
}

export type Recommendation = 'approve' | 'deficiencies' | 'uncertain';

// ── Outcome from (comparisonResult × confidenceBand) ─────────────────────────

function outcomeFrom(
  cr: ComparisonResult,
  band: ConfBand | null
): EvaluationOutcome {
  if (cr === 'missing') return 'deficient';
  if (cr === 'indeterminate') return 'uncertain';
  if (band === 'low') return 'uncertain';
  if (cr === 'meets') return 'pass';
  if (cr === 'fails') return 'deficient';
  return 'uncertain';
}

function rollUp(evaluations: EvaluationResult[]): Recommendation {
  if (evaluations.some((e) => e.outcome === 'deficient')) return 'deficiencies';
  if (evaluations.some((e) => e.outcome === 'uncertain')) return 'uncertain';
  return 'approve';
}

// ── Entity name normalization ─────────────────────────────────────────────────

const ENTITY_SUFFIX_RE = /\b(llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|limited|ltd\.?|lp|l\.p\.)\b/gi;

function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,&]/g, ' ')
    .replace(ENTITY_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasEntitySuffix(name: string): boolean {
  ENTITY_SUFFIX_RE.lastIndex = 0;
  return ENTITY_SUFFIX_RE.test(name);
}

function compareEntityNames(
  a: string | null,
  b: string | null
): ComparisonResult {
  if (!a || !b) return 'missing';

  const normA = normalizeEntityName(a);
  const normB = normalizeEntityName(b);
  if (normA === normB) return 'meets';

  // Entity suffix mismatch: one has LLC/Inc and the other doesn't
  const aHasSuffix = hasEntitySuffix(a);
  const bHasSuffix = hasEntitySuffix(b);
  if (bHasSuffix && !aHasSuffix) return 'fails';  // required entity suffix absent
  if (aHasSuffix && !bHasSuffix) return 'indeterminate'; // extra suffix on COI side

  // Word overlap similarity
  const wordsA = new Set(normA.split(/\s+/).filter(Boolean));
  const wordsB = new Set(normB.split(/\s+/).filter(Boolean));
  const common = [...wordsA].filter((w) => wordsB.has(w)).length;
  const total = wordsA.size + wordsB.size - common;
  const similarity = total > 0 ? common / total : 0;

  if (similarity >= 0.95) return 'meets';
  if (similarity >= 0.7) return 'indeterminate';
  return 'fails';
}

// ── Certificate holder comparison (handles ACORD 25 name+address block) ──────

function compareCertHolder(extracted: string | null, required: string): ComparisonResult {
  if (!extracted) return 'missing';
  // ACORD 25 cert holder field often contains name + address on separate lines.
  // Try just the first line (name only) before falling back to full text.
  const firstLine = extracted.split(/\n/)[0]?.trim() ?? extracted.trim();
  const crFirstLine = compareEntityNames(firstLine, required);
  if (crFirstLine !== 'fails') return crFirstLine;
  // Substring fallback: required name embedded in the full extracted block
  if (normalizeEntityName(extracted).includes(normalizeEntityName(required))) return 'meets';
  return crFirstLine;
}

// ── Requirement key parsers ───────────────────────────────────────────────────

function parseCoverageKey(key: string): { coverageType: string; limitKey: string } | null {
  const m = key.match(/^coverage\.([^.]+)\.(.+)$/);
  return m ? { coverageType: m[1], limitKey: m[2] } : null;
}

function parseCoverageRequiredKey(key: string): string | null {
  const m = key.match(/^coverage_required\.(.+)$/);
  return m ? m[1] : null;
}

function parseEndorsementKey(key: string): string | null {
  const m = key.match(/^endorsement\.(.+)$/);
  return m ? m[1] : null;
}

// ── Policy lookup helpers ─────────────────────────────────────────────────────

function policiesOfType(coi: ProcessedCOIExtraction, coverageType: string) {
  return coi.policies.filter(
    (p) => p.coverage_type?.value?.toLowerCase() === coverageType.toLowerCase()
  );
}

function hasCoverageType(coi: ProcessedCOIExtraction, coverageType: string): boolean {
  return policiesOfType(coi, coverageType).length > 0;
}

// ── WC exemption detection ────────────────────────────────────────────────────

const WC_EXEMPTION_KEYWORDS = [
  'exempt', 'exemption', 'waiver of workers', 'no employee', 'sole owner',
  'sole proprietor', 'ic 72-212', 'not applicable', 'n/a', 'owner exclusion',
];

function hasWCExemptionText(doo: string | null): boolean {
  if (!doo) return false;
  const lower = doo.toLowerCase();
  return WC_EXEMPTION_KEYWORDS.some((kw) => lower.includes(kw));
}

function isSoleProprietor(w9: ProcessedW9Extraction | undefined): boolean {
  if (!w9) return false;
  const cls = w9.federal_tax_classification?.value?.toLowerCase() ?? '';
  return cls.includes('individual') || cls.includes('sole proprietor');
}

// ── Entity type check ─────────────────────────────────────────────────────────

const ACCEPTED_ENTITY_TYPES = new Set([
  'single-member llc', 'llc', 'c corporation', 's corporation',
  'partnership', 'trust/estate', 'llc-c', 'llc-s', 'llc-p',
  'c corp', 's corp', 'corporation',
]);

function isAcceptableEntityType(classification: string | null): boolean {
  if (!classification) return false;
  const norm = classification.toLowerCase();
  return [...ACCEPTED_ENTITY_TYPES].some((t) => norm.includes(t.replace('-', ' ').replace('-', ' ')));
}

// ── Main rules engine function ─────────────────────────────────────────────────

export interface EngineInput {
  bundle: ExtractionBundle;
  matrix: RequirementMatrix;
  vendorTrade?: string;
}

export interface EngineOutput {
  evaluations: EvaluationResult[];
  recommendation: Recommendation;
}

export function runRulesEngine(input: EngineInput): EngineOutput {
  const { bundle, matrix } = input;
  const coi = bundle.coi;
  const w9 = bundle.w9;
  const ach = bundle.ach;
  const evaluations: EvaluationResult[] = [];

  // ── Evaluate each key in the requirement matrix ────────────────────────────

  for (const [key, entry] of Object.entries(matrix)) {
    const required = entry.required_value;

    // coverage.<type>.<limit_key> — extracted amount >= required amount
    const coverageParts = parseCoverageKey(key);
    if (coverageParts) {
      const { coverageType, limitKey } = coverageParts;
      if (!coi) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'COI not submitted' });
        continue;
      }
      const policies = policiesOfType(coi, coverageType);
      if (policies.length === 0) {
        // If coverage_required.<type> is in the matrix, that check already flags the absence.
        // Don't double-flag limit keys for missing coverage types.
        if (matrix[`coverage_required.${coverageType}`]) continue;
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: `No ${coverageType} policy found` });
        continue;
      }
      // Find the best limit across matching policies
      let bestValue: number | null = null;
      let bestBand: ConfBand = 'low';
      for (const p of policies) {
        const limitField = p.limits[limitKey] as FieldValue<number | null> | undefined;
        if (limitField?.value != null) {
          if (bestValue === null || limitField.value > bestValue) {
            bestValue = limitField.value;
            bestBand = limitField.band;
          }
        }
      }
      const reqNum = parseFloat(required);
      if (bestValue === null) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'indeterminate', confidenceBand: null, outcome: 'uncertain', note: `Limit key '${limitKey}' not extracted` });
      } else {
        const cr: ComparisonResult = bestValue >= reqNum ? 'meets' : 'fails';
        const outcome = outcomeFrom(cr, bestBand);
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: String(bestValue), comparisonResult: cr, confidenceBand: bestBand, outcome, note: null });
      }
      continue;
    }

    // coverage_required.<type> — policy of that type must exist
    const covRequiredType = parseCoverageRequiredKey(key);
    if (covRequiredType) {
      if (required === 'false' || required === '0') continue; // not required at this location
      if (!coi) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'COI not submitted' });
        continue;
      }

      // Special handling for workers_comp
      if (covRequiredType === 'workers_comp') {
        const wcPresent = hasCoverageType(coi, 'workers_comp');
        if (wcPresent) {
          evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'present', comparisonResult: 'meets', confidenceBand: 'high', outcome: 'pass', note: null });
        } else {
          // Check for exemption indicators
          const doo = coi.description_of_operations?.value ?? null;
          const exemptionInDOO = hasWCExemptionText(doo);
          const soleProprietor = isSoleProprietor(w9);
          const exemptionIndicator = exemptionInDOO || soleProprietor;

          if (exemptionIndicator) {
            // WC absent but exemption may apply → uncertain (not deficient)
            evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'uncertain', note: 'WC absent; exemption claim or sole-proprietor status requires human verification' });
            // Also emit the workers_comp_exemption_claimed cross-doc check
            evaluations.push({
              requirementKey: 'workers_comp_exemption_claimed',
              requiredValue: null,
              extractedValueRef: exemptionInDOO ? 'exemption_text_in_doo' : 'sole_proprietor_w9',
              comparisonResult: 'indeterminate',
              confidenceBand: null,
              outcome: 'uncertain',
              note: exemptionInDOO
                ? 'Exemption language found in Description of Operations; human must verify zero-employee status'
                : 'Sole proprietor on W-9 but no written exemption in COI Description of Operations; human must confirm',
            });
          } else {
            evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'Workers comp policy absent' });
          }
        }
        continue;
      }

      const present = hasCoverageType(coi, covRequiredType);
      if (!present) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: `${covRequiredType} policy not found` });
      } else {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'present', comparisonResult: 'meets', confidenceBand: 'high', outcome: 'pass', note: null });
      }
      continue;
    }

    // endorsement.<name> — endorsement flag must be true
    const endorsementName = parseEndorsementKey(key);
    if (endorsementName) {
      if (required === 'false' || required === '0') continue;
      if (!coi) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'COI not submitted' });
        continue;
      }

      if (endorsementName === 'additional_insured') {
        // Must be true on GL and Auto policies
        const requiredTypes = ['general_liability', 'automobile_liability'];
        const missingOn: string[] = [];
        let worstBand: ConfBand = 'high';
        let anyFails = false;

        for (const ct of requiredTypes) {
          const policies = policiesOfType(coi, ct);
          if (policies.length === 0) continue; // coverage_required check covers absence
          const anyTrue = policies.some((p) => p.additional_insured?.value === true);
          const anyFalse = policies.some((p) => p.additional_insured?.value === false);
          const allLow = policies.every((p) => p.additional_insured?.band === 'low');
          if (allLow) worstBand = 'low';
          if (!anyTrue) {
            missingOn.push(ct);
            if (anyFalse) anyFails = true;
          }
        }

        if (missingOn.length === 0) {
          evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'true', comparisonResult: 'meets', confidenceBand: worstBand, outcome: outcomeFrom('meets', worstBand), note: null });
        } else {
          const cr: ComparisonResult = anyFails ? 'fails' : 'indeterminate';
          const outcome = outcomeFrom(cr, worstBand);
          evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'false', comparisonResult: cr, confidenceBand: worstBand, outcome, note: `Additional insured not present on: ${missingOn.join(', ')}` });
        }
        continue;
      }

      // Generic endorsement check across all policies
      const allPolicies = coi.policies;
      if (allPolicies.length === 0) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'No policies found' });
        continue;
      }
      const endorsField = endorsementName === 'waiver_of_subrogation'
        ? allPolicies.map((p) => p.waiver_of_subrogation)
        : endorsementName === 'primary_noncontributory'
          ? allPolicies.map((p) => p.primary_noncontributory)
          : allPolicies.map((p) => p.additional_insured);

      const anyTrue = endorsField.some((f) => f?.value === true);
      const anyLow = endorsField.some((f) => f?.band === 'low');
      const band: ConfBand = anyLow ? 'low' : 'high';
      if (anyTrue) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'true', comparisonResult: 'meets', confidenceBand: band, outcome: outcomeFrom('meets', band), note: null });
      } else {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'false', comparisonResult: 'fails', confidenceBand: band, outcome: outcomeFrom('fails', band), note: null });
      }
      continue;
    }

    // doc_required.<type> — document presence check
    if (key.startsWith('doc_required.')) {
      if (required === 'false' || required === '0') continue;
      const docType = key.replace('doc_required.', '');
      const present = docType === 'coi' ? !!coi : docType === 'w9' ? !!w9 : docType === 'ach' ? !!ach : false;
      if (!present) {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: `${docType.toUpperCase()} not submitted` });
      } else {
        evaluations.push({ requirementKey: key, requiredValue: required, extractedValueRef: 'present', comparisonResult: 'meets', confidenceBand: 'high', outcome: 'pass', note: null });
      }
      continue;
    }

    // certificate_holder — engine derives certificate_holder_match evaluation
    if (key === 'certificate_holder') {
      if (!coi) {
        evaluations.push({ requirementKey: 'certificate_holder_match', requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'COI not submitted' });
        continue;
      }
      const extracted = coi.certificate_holder?.value ?? null;
      const band = coi.certificate_holder?.band ?? 'low';
      const cr = compareCertHolder(extracted, required);
      evaluations.push({ requirementKey: 'certificate_holder_match', requiredValue: required, extractedValueRef: extracted, comparisonResult: cr, confidenceBand: band, outcome: outcomeFrom(cr, band), note: null });
      continue;
    }

    // entity_type — W-9 federal_tax_classification must be LLC/corp
    if (key === 'entity_type') {
      if (!w9) {
        evaluations.push({ requirementKey: 'entity_type', requiredValue: required, extractedValueRef: null, comparisonResult: 'missing', confidenceBand: null, outcome: 'deficient', note: 'W-9 not submitted' });
        continue;
      }
      const cls = w9.federal_tax_classification?.value ?? null;
      const band = w9.federal_tax_classification?.band ?? 'low';
      if (!cls) {
        evaluations.push({ requirementKey: 'entity_type', requiredValue: required, extractedValueRef: null, comparisonResult: 'indeterminate', confidenceBand: band, outcome: 'uncertain', note: 'Entity type not extracted' });
      } else if (isAcceptableEntityType(cls)) {
        evaluations.push({ requirementKey: 'entity_type', requiredValue: required, extractedValueRef: cls, comparisonResult: 'meets', confidenceBand: band, outcome: outcomeFrom('meets', band), note: null });
      } else {
        evaluations.push({ requirementKey: 'entity_type', requiredValue: required, extractedValueRef: cls, comparisonResult: 'fails', confidenceBand: band, outcome: outcomeFrom('fails', band), note: `Entity type '${cls}' does not meet LLC/corp requirement` });
      }
      continue;
    }
  }

  // ── Engine-derived cross-document checks (always run when docs available) ──

  // named_insured_match — COI named_insured vs W-9 legal_name
  if (coi && w9) {
    const coiName = coi.named_insured?.value ?? null;
    const w9Name = w9.legal_name?.value ?? null;
    const band: ConfBand = (coi.named_insured?.band === 'low' || w9.legal_name?.band === 'low') ? 'low' : 'med';
    const cr = compareEntityNames(coiName, w9Name);
    evaluations.push({ requirementKey: 'named_insured_match', requiredValue: w9Name, extractedValueRef: coiName, comparisonResult: cr, confidenceBand: band, outcome: outcomeFrom(cr, band), note: null });
  }

  // ach_payee_matches_legal_name — ACH account_holder_name vs W-9 legal_name
  if (ach && w9) {
    const achName = ach.account_holder_name?.value ?? null;
    const w9Name = w9.legal_name?.value ?? null;
    const band: ConfBand = (ach.account_holder_name?.band === 'low' || w9.legal_name?.band === 'low') ? 'low' : 'med';
    const cr = compareEntityNames(achName, w9Name);
    evaluations.push({ requirementKey: 'ach_payee_matches_legal_name', requiredValue: w9Name, extractedValueRef: achName, comparisonResult: cr, confidenceBand: band, outcome: outcomeFrom(cr, band), note: null });
  }

  // Filter out PASS evaluations for return (only non-pass evaluations are interesting
  // for confusion matrix; but we return all for completeness — caller can filter)
  const recommendation = rollUp(evaluations);
  return { evaluations, recommendation };
}

export { rollUp };
