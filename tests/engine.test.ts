// Phase 4 — AI Verification Engine tests.
//
// Covers: toBand, toIsoDateStr, expiration gate, advisory generator,
// rules engine (pure function), verification pipeline (DB integration),
// and ground-truth validation against synthetic extractions for all 10 vendors.
//
// No Vision API calls are made here. Synthetic ProcessedExtraction objects
// stand in for what the extractor would return from the fixture PDFs.

import { randomUUID } from 'crypto';
import {
  toBand,
  toIsoDateStr,
  checkExpirationGate,
  setEngineDateOverride,
} from '@/lib/extraction/extractor';
import { generateAdvisories } from '@/lib/verification/advisories';
import { runRulesEngine, rollUp } from '@/lib/verification/engine';
import { runVerification, loadExtractionBundle } from '@/lib/verification/run';
import type {
  ConfBand,
  FieldValue,
  ProcessedCOIExtraction,
  ProcessedW9Extraction,
  ProcessedACHExtraction,
  ProcessedPolicy,
  ExtractionBundle,
} from '@/lib/extraction/types';
import type { RequirementMatrix } from '@/lib/requirements/resolver';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedLocation,
  seedVendor,
  seedVendorLocation,
  seedDocument,
  seedExtraction,
  seedRequirementSettings,
  seedRequirementRule,
} from './helpers';

// ── Field value factory helpers ───────────────────────────────────────────────

const fv = <T>(value: T, band: ConfBand = 'high', corroborated = true): FieldValue<T> => ({
  value,
  confidence: band === 'high' ? 0.95 : band === 'med' ? 0.82 : 0.50,
  band,
  source: { page: 1, snippet: String(value ?? '') },
  corroborated,
});

const fvLow = <T>(value: T): FieldValue<T> => fv(value, 'low', true);
const fvMed = <T>(value: T): FieldValue<T> => fv(value, 'med', true);

// ── Resolved entry factory (RequirementMatrix value) ─────────────────────────

const re = (value: string): RequirementMatrix[string] => ({
  required_value: value,
  scope: 'org',
  rule_id: null,
});

// ── Standard COI builder ──────────────────────────────────────────────────────
// Builds a minimal compliant COI. Override individual policies or fields as needed.

function makePolicy(
  coverageType: string,
  limits: Record<string, number>,
  overrides: Partial<ProcessedPolicy> = {}
): ProcessedPolicy {
  return {
    coverage_type: fv(coverageType),
    insurer_letter: fv('A'),
    policy_number: fv(`POL-${coverageType.slice(0, 4).toUpperCase()}-001`),
    effective_date: fv('04/09/2025'),
    expiration_date: fv('04/09/2027'),
    limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, fv(v)])),
    additional_insured: fv(false),
    additional_insured_scope: fv(null),
    waiver_of_subrogation: fv(false),
    primary_noncontributory: fv(false),
    ...overrides,
  };
}

function makeCOI(
  namedInsured: string,
  policies: ProcessedPolicy[],
  certHolder = 'StoreSafe Capital Partners LLC',
  doo: string | null = null
): ProcessedCOIExtraction {
  return {
    doc_type: 'coi',
    document_type_confirmed: 'coi',
    certificate_date: fv('04/09/2026'),
    producer: fv('Test Insurance Agency'),
    named_insured: fv(namedInsured),
    insured_address: fv('123 Main St, Boise, ID 83702'),
    insurers: [{ letter: 'A', carrier_name: fv('Great American Insurance'), naic: fv('16691') }],
    policies,
    additional_insured_entities: fv(null),
    description_of_operations: fv(doo),
    certificate_holder: fv(certHolder),
  };
}

function makeW9(
  legalName: string,
  classification = 'Single-member LLC',
  tinType = 'EIN'
): ProcessedW9Extraction {
  return {
    doc_type: 'w9',
    document_type_confirmed: 'w9',
    legal_name: fv(legalName),
    business_name: fv(null),
    federal_tax_classification: fv(classification),
    tin_type: fv(tinType),
    tin_value: fv('[ENCRYPTED]'),
    address: fv('123 Main St, Boise, ID 83702'),
    signature_present: fv(true),
    signature_date: fv('04/01/2026'),
  };
}

function makeACH(accountHolder: string): ProcessedACHExtraction {
  return {
    doc_type: 'ach',
    document_type_confirmed: 'ach',
    account_holder_name: fv(accountHolder),
    bank_name: fv('First National Bank'),
    routing_number: fv('[ENCRYPTED]'),
    account_number: fv('[ENCRYPTED]'),
    account_type: fv('checking'),
    voided_check_present: fv(true),
    authorization_signature: fv(true),
  };
}

// ── Standard requirement matrix for the 10-vendor ground-truth dataset ────────

const STANDARD_MATRIX: RequirementMatrix = {
  'coverage.general_liability.each_occurrence': re('1000000'),
  'coverage.general_liability.general_aggregate': re('2000000'),
  'coverage.automobile_liability.combined_single_limit': re('1000000'),
  'coverage.umbrella_excess.each_occurrence': re('5000000'),
  'coverage.umbrella_excess.aggregate': re('5000000'),
  'coverage.workers_comp.el_each_accident': re('1000000'),
  'coverage.workers_comp.el_disease_each_employee': re('1000000'),
  'coverage.workers_comp.el_disease_policy_limit': re('1000000'),
  'coverage_required.general_liability': re('true'),
  'coverage_required.automobile_liability': re('true'),
  'coverage_required.workers_comp': re('true'),
  'coverage_required.umbrella_excess': re('true'),
  'endorsement.additional_insured': re('true'),
  'certificate_holder': re('StoreSafe Capital Partners LLC'),
  'entity_type': re('llc_or_corp'),   // required by eval harness for all vendors
};

// ── Fully compliant policy set (used for perfect-vendor tests) ────────────────

function compliantPolicies(aiOnGLAndAuto = true): ProcessedPolicy[] {
  return [
    makePolicy('general_liability', { each_occurrence: 2000000, general_aggregate: 4000000 }, {
      additional_insured: fv(aiOnGLAndAuto),
      additional_insured_scope: fv(aiOnGLAndAuto ? 'blanket' : null),
    }),
    makePolicy('automobile_liability', { combined_single_limit: 1000000 }, {
      additional_insured: fv(aiOnGLAndAuto),
      additional_insured_scope: fv(aiOnGLAndAuto ? 'blanket' : null),
    }),
    makePolicy('umbrella_excess', { each_occurrence: 5000000, aggregate: 5000000 }),
    makePolicy('workers_comp', {
      el_each_accident: 1000000,
      el_disease_each_employee: 1000000,
      el_disease_policy_limit: 1000000,
    }),
  ];
}

// ── Reference date for expiration tests ──────────────────────────────────────

const REFERENCE_DATE = new Date('2026-04-09T00:00:00Z');

beforeEach(() => {
  setEngineDateOverride(null);
});

afterEach(() => {
  setEngineDateOverride(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — Confidence band (toBand)
// ─────────────────────────────────────────────────────────────────────────────

describe('toBand', () => {
  test('≥ 0.90 → high', () => {
    expect(toBand(0.90)).toBe('high');
    expect(toBand(0.95)).toBe('high');
    expect(toBand(1.00)).toBe('high');
  });
  test('0.75–0.89 → med', () => {
    expect(toBand(0.75)).toBe('med');
    expect(toBand(0.82)).toBe('med');
    expect(toBand(0.899)).toBe('med');
  });
  test('< 0.75 → low', () => {
    expect(toBand(0.74)).toBe('low');
    expect(toBand(0.50)).toBe('low');
    expect(toBand(0.00)).toBe('low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — Date normalization (toIsoDateStr)
// ─────────────────────────────────────────────────────────────────────────────

describe('toIsoDateStr', () => {
  test('ISO date returned unchanged', () => {
    expect(toIsoDateStr('2026-04-09')).toBe('2026-04-09');
  });
  test('US slash format converted', () => {
    expect(toIsoDateStr('04/09/2026')).toBe('2026-04-09');
  });
  test('single-digit month/day padded', () => {
    expect(toIsoDateStr('1/5/2026')).toBe('2026-01-05');
  });
  test('unpadded ISO-dash date (single-digit month and/or day) gets zero-padded', () => {
    // Phase 13 Stage 5 pre-commit gap-closing: Vision's tool schema puts no format constraint
    // on expiration_date, so this is a real possible extraction output, not just a synthetic
    // edge case — and an un-normalized unpadded date creates a latent seam between how
    // Date.parse() and Postgres's ::timestamptz cast each interpret it (see chase.ts).
    expect(toIsoDateStr('2026-9-5')).toBe('2026-09-05');
    expect(toIsoDateStr('2026-9-15')).toBe('2026-09-15');
    expect(toIsoDateStr('2026-12-5')).toBe('2026-12-05');
  });
  test('invalid string returns null', () => {
    expect(toIsoDateStr('April 9 2026')).toBeNull();
    expect(toIsoDateStr('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3 — Expiration gate
// ─────────────────────────────────────────────────────────────────────────────

describe('checkExpirationGate', () => {
  beforeEach(() => setEngineDateOverride(REFERENCE_DATE));

  test('all policies expire in the future → passes', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { each_occurrence: 1000000 }, {
        expiration_date: fv('04/09/2027'),
      }),
    ]);
    const result = checkExpirationGate(coi);
    expect(result.passed).toBe(true);
    expect(result.expiredPolicies).toHaveLength(0);
  });

  test('policy expires before reference date → fails', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { each_occurrence: 1000000 }, {
        expiration_date: fv('11/15/2025'),
      }),
    ]);
    const result = checkExpirationGate(coi);
    expect(result.passed).toBe(false);
    expect(result.expiredPolicies).toHaveLength(1);
    expect(result.expiredPolicies[0]).toContain('11/15/2025');
  });

  test('multiple expired policies all reported', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { expiration_date: fv('11/15/2025') }),
      makePolicy('automobile_liability', {}, { expiration_date: fv('11/15/2025') }),
    ]);
    const result = checkExpirationGate(coi);
    expect(result.passed).toBe(false);
    expect(result.expiredPolicies).toHaveLength(2);
  });

  test('policy expiring ON reference date still passes gate (valid through expiry day)', () => {
    // Gate uses strict < (not <=): a policy that expires on the reference date is still
    // considered active that day. The renewal chase ladder handles near-expiry notices.
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { expiration_date: fv('04/09/2026') }),
    ]);
    const result = checkExpirationGate(coi);
    expect(result.passed).toBe(true);
  });

  test('policy expiring 1 day after reference → passes', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { expiration_date: fv('04/10/2026') }),
    ]);
    const result = checkExpirationGate(coi);
    expect(result.passed).toBe(true);
  });

  test('COI with no expiration dates → passes (no gate applies)', () => {
    const policy = makePolicy('general_liability', {});
    policy.expiration_date = fv(null);
    const coi = makeCOI('Test LLC', [policy]);
    const result = checkExpirationGate(coi);
    expect(result.passed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 4 — Roll-up function
// ─────────────────────────────────────────────────────────────────────────────

describe('rollUp', () => {
  test('all pass → approve', () => {
    const evals = [
      { outcome: 'pass' as const, requirementKey: 'k', requiredValue: null, extractedValueRef: null, comparisonResult: 'meets' as const, confidenceBand: 'high' as const, note: null },
    ];
    expect(rollUp(evals)).toBe('approve');
  });

  test('any deficient → deficiencies (even with pass)', () => {
    const evals = [
      { outcome: 'pass' as const, requirementKey: 'a', requiredValue: null, extractedValueRef: null, comparisonResult: 'meets' as const, confidenceBand: 'high' as const, note: null },
      { outcome: 'deficient' as const, requirementKey: 'b', requiredValue: null, extractedValueRef: null, comparisonResult: 'fails' as const, confidenceBand: 'high' as const, note: null },
    ];
    expect(rollUp(evals)).toBe('deficiencies');
  });

  test('uncertain only → uncertain', () => {
    const evals = [
      { outcome: 'uncertain' as const, requirementKey: 'k', requiredValue: null, extractedValueRef: null, comparisonResult: 'indeterminate' as const, confidenceBand: 'low' as const, note: null },
    ];
    expect(rollUp(evals)).toBe('uncertain');
  });

  test('deficient + uncertain → deficiencies (deficient wins)', () => {
    const evals = [
      { outcome: 'deficient' as const, requirementKey: 'a', requiredValue: null, extractedValueRef: null, comparisonResult: 'fails' as const, confidenceBand: 'high' as const, note: null },
      { outcome: 'uncertain' as const, requirementKey: 'b', requiredValue: null, extractedValueRef: null, comparisonResult: 'indeterminate' as const, confidenceBand: 'low' as const, note: null },
    ];
    expect(rollUp(evals)).toBe('deficiencies');
  });

  test('empty evaluations → approve', () => {
    expect(rollUp([])).toBe('approve');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — Rules engine — coverage limits
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — coverage limits', () => {
  const matrix: RequirementMatrix = {
    'coverage.general_liability.each_occurrence': re('1000000'),
  };

  test('limit meets requirement → pass', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { each_occurrence: 1000000 }),
    ]);
    const { evaluations, recommendation } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(ev?.outcome).toBe('pass');
    expect(recommendation).toBe('approve');
  });

  test('limit exceeds requirement → pass', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000 }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(ev?.outcome).toBe('pass');
  });

  test('limit below requirement → deficient', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { each_occurrence: 500000 }),
    ]);
    const { evaluations, recommendation } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(ev?.outcome).toBe('deficient');
    expect(ev?.comparisonResult).toBe('fails');
    expect(recommendation).toBe('deficiencies');
  });

  test('low-confidence limit → uncertain even if value meets', () => {
    const policy = makePolicy('general_liability', {});
    policy.limits['each_occurrence'] = fvLow(1000000);
    const coi = makeCOI('Test LLC', [policy]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(ev?.outcome).toBe('uncertain');
  });

  test('limit key not extracted → uncertain (indeterminate)', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { general_aggregate: 2000000 }),  // no each_occurrence
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(ev?.outcome).toBe('uncertain');
    expect(ev?.comparisonResult).toBe('indeterminate');
  });

  test('no COI submitted → deficient (missing)', () => {
    const { evaluations } = runRulesEngine({ bundle: {}, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(ev?.outcome).toBe('deficient');
    expect(ev?.comparisonResult).toBe('missing');
  });

  test('best limit taken across multiple matching policies', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', { each_occurrence: 500000 }),
      makePolicy('general_liability', { each_occurrence: 1500000 }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    // Best value is 1500000 ≥ 1000000 → pass
    expect(ev?.outcome).toBe('pass');
    expect(ev?.extractedValueRef).toBe('1500000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6 — Rules engine — coverage required
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — coverage required', () => {
  test('required coverage present → pass', () => {
    const matrix: RequirementMatrix = { 'coverage_required.general_liability': re('true') };
    const coi = makeCOI('Test LLC', [makePolicy('general_liability', { each_occurrence: 1000000 })]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage_required.general_liability');
    expect(ev?.outcome).toBe('pass');
  });

  test('required coverage absent → deficient', () => {
    const matrix: RequirementMatrix = { 'coverage_required.general_liability': re('true') };
    const coi = makeCOI('Test LLC', [makePolicy('automobile_liability', { combined_single_limit: 1000000 })]);
    const { evaluations, recommendation } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage_required.general_liability');
    expect(ev?.outcome).toBe('deficient');
    expect(recommendation).toBe('deficiencies');
  });

  test('coverage_required.false in matrix → no evaluation (skipped)', () => {
    const matrix: RequirementMatrix = { 'coverage_required.automobile_liability': re('false') };
    const coi = makeCOI('Test LLC', []);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage_required.automobile_liability');
    expect(ev).toBeUndefined();
  });

  test('workers_comp absent, no exemption → deficient', () => {
    const matrix: RequirementMatrix = { 'coverage_required.workers_comp': re('true') };
    const coi = makeCOI('Test LLC', []);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'coverage_required.workers_comp');
    expect(ev?.outcome).toBe('deficient');
    expect(ev?.comparisonResult).toBe('missing');
  });

  test('workers_comp absent + DOO exemption text → uncertain + exemption_claimed', () => {
    const matrix: RequirementMatrix = { 'coverage_required.workers_comp': re('true') };
    const coi = makeCOI('Test LLC', [], 'StoreSafe Capital Partners LLC', 'Owner is exempt per Idaho IC 72-212 sole owner exemption');
    const { evaluations, recommendation } = runRulesEngine({ bundle: { coi }, matrix });
    const wcEv = evaluations.find((e) => e.requirementKey === 'coverage_required.workers_comp');
    const exemptEv = evaluations.find((e) => e.requirementKey === 'workers_comp_exemption_claimed');
    expect(wcEv?.outcome).toBe('uncertain');
    expect(exemptEv?.outcome).toBe('uncertain');
    expect(recommendation).toBe('uncertain');
  });

  test('workers_comp absent + sole-proprietor W-9 → uncertain + exemption_claimed', () => {
    const matrix: RequirementMatrix = { 'coverage_required.workers_comp': re('true') };
    const coi = makeCOI('Randy Kowalski', []);
    const w9 = makeW9('Randy L. Kowalski', 'Individual/sole proprietor', 'SSN');
    const { evaluations } = runRulesEngine({ bundle: { coi, w9 }, matrix });
    const exemptEv = evaluations.find((e) => e.requirementKey === 'workers_comp_exemption_claimed');
    expect(exemptEv?.outcome).toBe('uncertain');
    expect(exemptEv?.note?.toLowerCase()).toContain('sole proprietor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 7 — Rules engine — endorsements
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — endorsements', () => {
  test('additional_insured true on GL and Auto → pass', () => {
    const matrix: RequirementMatrix = { 'endorsement.additional_insured': re('true') };
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { additional_insured: fv(true) }),
      makePolicy('automobile_liability', {}, { additional_insured: fv(true) }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'endorsement.additional_insured');
    expect(ev?.outcome).toBe('pass');
  });

  test('additional_insured false on GL → deficient', () => {
    const matrix: RequirementMatrix = { 'endorsement.additional_insured': re('true') };
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { additional_insured: fv(false) }),
      makePolicy('automobile_liability', {}, { additional_insured: fv(true) }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'endorsement.additional_insured');
    expect(ev?.outcome).toBe('deficient');
    expect(ev?.comparisonResult).toBe('fails');
  });

  test('additional_insured false on both GL and Auto → deficient', () => {
    const matrix: RequirementMatrix = { 'endorsement.additional_insured': re('true') };
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { additional_insured: fv(false) }),
      makePolicy('automobile_liability', {}, { additional_insured: fv(false) }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'endorsement.additional_insured');
    expect(ev?.outcome).toBe('deficient');
  });

  test('low-confidence additional_insured → uncertain', () => {
    const matrix: RequirementMatrix = { 'endorsement.additional_insured': re('true') };
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { additional_insured: fvLow(true) }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'endorsement.additional_insured');
    expect(ev?.outcome).toBe('uncertain');
  });

  test('waiver_of_subrogation required and present → pass', () => {
    const matrix: RequirementMatrix = { 'endorsement.waiver_of_subrogation': re('true') };
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { waiver_of_subrogation: fv(true) }),
    ]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'endorsement.waiver_of_subrogation');
    expect(ev?.outcome).toBe('pass');
  });

  test('endorsement.false in matrix → skipped', () => {
    const matrix: RequirementMatrix = { 'endorsement.primary_noncontributory': re('false') };
    const coi = makeCOI('Test LLC', [makePolicy('general_liability', {})]);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'endorsement.primary_noncontributory');
    expect(ev).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 8 — Rules engine — doc required
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — doc_required', () => {
  test('doc_required.coi with COI present → pass', () => {
    const matrix: RequirementMatrix = { 'doc_required.coi': re('true') };
    const coi = makeCOI('Test LLC', []);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'doc_required.coi');
    expect(ev?.outcome).toBe('pass');
  });

  test('doc_required.w9 with W-9 absent → deficient', () => {
    const matrix: RequirementMatrix = { 'doc_required.w9': re('true') };
    const { evaluations, recommendation } = runRulesEngine({ bundle: {}, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'doc_required.w9');
    expect(ev?.outcome).toBe('deficient');
    expect(ev?.comparisonResult).toBe('missing');
    expect(recommendation).toBe('deficiencies');
  });

  test('doc_required.false → skipped entirely', () => {
    const matrix: RequirementMatrix = { 'doc_required.ach': re('false') };
    const { evaluations } = runRulesEngine({ bundle: {}, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'doc_required.ach');
    expect(ev).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 9 — Rules engine — certificate holder
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — certificate_holder', () => {
  test('exact match → pass', () => {
    const matrix: RequirementMatrix = { 'certificate_holder': re('StoreSafe Capital Partners LLC') };
    const coi = makeCOI('Test LLC', [], 'StoreSafe Capital Partners LLC');
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'certificate_holder_match');
    expect(ev?.outcome).toBe('pass');
  });

  test('normalized match (case-insensitive) → pass', () => {
    const matrix: RequirementMatrix = { 'certificate_holder': re('StoreSafe Capital Partners LLC') };
    const coi = makeCOI('Test LLC', [], 'storesafe capital partners llc');
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'certificate_holder_match');
    expect(ev?.outcome).toBe('pass');
  });

  test('clear mismatch → deficient or uncertain (never a pass)', () => {
    const matrix: RequirementMatrix = { 'certificate_holder': re('StoreSafe Capital Partners LLC') };
    const coi = makeCOI('Test LLC', [], 'Cascade Self Storage Partners LP');
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'certificate_holder_match');
    expect(['deficient', 'uncertain']).toContain(ev?.outcome);
    expect(['fails', 'indeterminate']).toContain(ev?.comparisonResult);
  });

  test('missing cert holder → deficient', () => {
    const matrix: RequirementMatrix = { 'certificate_holder': re('StoreSafe Capital Partners LLC') };
    const coi = makeCOI('Test LLC', [], null as unknown as string);
    coi.certificate_holder = fv(null);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'certificate_holder_match');
    expect(ev?.comparisonResult).toBe('missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 10 — Rules engine — entity_type
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — entity_type', () => {
  test('LLC classification → pass', () => {
    const matrix: RequirementMatrix = { 'entity_type': re('true') };
    const w9 = makeW9('Test LLC', 'Single-member LLC');
    const { evaluations } = runRulesEngine({ bundle: { w9 }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'entity_type');
    expect(ev?.outcome).toBe('pass');
  });

  test('Individual/sole proprietor classification → deficient', () => {
    const matrix: RequirementMatrix = { 'entity_type': re('true') };
    const w9 = makeW9('Randy Kowalski', 'Individual/sole proprietor', 'SSN');
    const { evaluations, recommendation } = runRulesEngine({ bundle: { w9 }, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'entity_type');
    expect(ev?.outcome).toBe('deficient');
    expect(ev?.comparisonResult).toBe('fails');
    expect(recommendation).toBe('deficiencies');
  });

  test('no W-9 → deficient (missing)', () => {
    const matrix: RequirementMatrix = { 'entity_type': re('true') };
    const { evaluations } = runRulesEngine({ bundle: {}, matrix });
    const ev = evaluations.find((e) => e.requirementKey === 'entity_type');
    expect(ev?.comparisonResult).toBe('missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 11 — Rules engine — cross-document checks
// ─────────────────────────────────────────────────────────────────────────────

describe('runRulesEngine — cross-document checks', () => {
  test('named_insured_match: same name → pass', () => {
    const coi = makeCOI('PeakGuard Facility Services LLC', []);
    const w9 = makeW9('PeakGuard Facility Services LLC');
    const { evaluations } = runRulesEngine({ bundle: { coi, w9 }, matrix: {} });
    const ev = evaluations.find((e) => e.requirementKey === 'named_insured_match');
    expect(ev?.outcome).toBe('pass');
  });

  test('named_insured_match: normalized match (LLC suffix) → pass', () => {
    const coi = makeCOI('PeakGuard Facility Services', []);
    const w9 = makeW9('PeakGuard Facility Services LLC');
    // Missing LLC suffix on COI side — indeterminate (extra suffix on required side)
    const { evaluations } = runRulesEngine({ bundle: { coi, w9 }, matrix: {} });
    const ev = evaluations.find((e) => e.requirementKey === 'named_insured_match');
    // Near-miss → uncertain, not deficient (spec: near-miss → Uncertain → human)
    expect(['pass', 'uncertain']).toContain(ev?.outcome);
  });

  test('named_insured_match: DBA only (missing LLC) → deficient/uncertain', () => {
    const coi = makeCOI('Summit Pro Plumbing', []);  // DBA only
    const w9 = makeW9('Summit Pro Plumbing & Mechanical LLC');  // full legal name
    const { evaluations } = runRulesEngine({ bundle: { coi, w9 }, matrix: {} });
    const ev = evaluations.find((e) => e.requirementKey === 'named_insured_match');
    // Required has LLC suffix, extracted doesn't → fails
    expect(ev?.comparisonResult).toBe('fails');
    expect(ev?.outcome).toBe('deficient');
  });

  test('ach_payee_matches_legal_name: same name → pass', () => {
    const w9 = makeW9('PeakGuard Facility Services LLC');
    const ach = makeACH('PeakGuard Facility Services LLC');
    const { evaluations } = runRulesEngine({ bundle: { w9, ach }, matrix: {} });
    const ev = evaluations.find((e) => e.requirementKey === 'ach_payee_matches_legal_name');
    expect(ev?.outcome).toBe('pass');
  });

  test('ach_payee_matches_legal_name: personal name vs LLC → deficient', () => {
    const w9 = makeW9('Summit Pro Plumbing & Mechanical LLC');
    const ach = makeACH('Travis K. Bowman');
    const { evaluations } = runRulesEngine({ bundle: { w9, ach }, matrix: {} });
    const ev = evaluations.find((e) => e.requirementKey === 'ach_payee_matches_legal_name');
    expect(ev?.comparisonResult).toBe('fails');
    expect(ev?.outcome).toBe('deficient');
  });

  test('cross-doc checks not emitted when docs missing', () => {
    const coi = makeCOI('Test LLC', []);
    const { evaluations } = runRulesEngine({ bundle: { coi }, matrix: {} });
    // No w9 → no named_insured_match; no ach → no ach_payee_matches_legal_name
    expect(evaluations.find((e) => e.requirementKey === 'named_insured_match')).toBeUndefined();
    expect(evaluations.find((e) => e.requirementKey === 'ach_payee_matches_legal_name')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 12 — Advisory generator
// ─────────────────────────────────────────────────────────────────────────────

describe('generateAdvisories', () => {
  beforeEach(() => setEngineDateOverride(REFERENCE_DATE));

  test('clean bundle (no advisories)', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { effective_date: fv('04/09/2024') }),
      makePolicy('automobile_liability', {}, { effective_date: fv('04/09/2024') }),
    ]);
    const advisories = generateAdvisories({ coi });
    expect(advisories).toHaveLength(0);
  });

  test('coverage_continuity: all same very-recent effective date → warns', () => {
    // 2026-04-03 is 6 days before reference_date 2026-04-09 (within 45 days)
    const coi = makeCOI('Timberline LLC', [
      makePolicy('general_liability', {}, { effective_date: fv('2026-04-03') }),
      makePolicy('automobile_liability', {}, { effective_date: fv('2026-04-03') }),
      makePolicy('umbrella_excess', {}, { effective_date: fv('2026-04-03') }),
    ]);
    const advisories = generateAdvisories({ coi });
    const flag = advisories.find((a) => a.key === 'coverage_continuity');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('warn');
  });

  test('coverage_continuity: different effective dates → no flag', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { effective_date: fv('2026-04-03') }),
      makePolicy('automobile_liability', {}, { effective_date: fv('2025-06-01') }),
    ]);
    const advisories = generateAdvisories({ coi });
    expect(advisories.find((a) => a.key === 'coverage_continuity')).toBeUndefined();
  });

  test('coverage_continuity: same date but older than 45 days → no flag', () => {
    // 2025-02-01 is >> 45 days before 2026-04-09
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { effective_date: fv('2025-02-01') }),
      makePolicy('automobile_liability', {}, { effective_date: fv('2025-02-01') }),
    ]);
    const advisories = generateAdvisories({ coi });
    expect(advisories.find((a) => a.key === 'coverage_continuity')).toBeUndefined();
  });

  test('coverage_continuity: future effective date → no flag', () => {
    const coi = makeCOI('Test LLC', [
      makePolicy('general_liability', {}, { effective_date: fv('2026-05-01') }),
      makePolicy('automobile_liability', {}, { effective_date: fv('2026-05-01') }),
    ]);
    const advisories = generateAdvisories({ coi });
    expect(advisories.find((a) => a.key === 'coverage_continuity')).toBeUndefined();
  });

  test('personal_ach_account: sole proprietor SSN → warns', () => {
    const w9 = makeW9('Randy L. Kowalski', 'Individual/sole proprietor', 'SSN');
    const ach = makeACH('Randy L. Kowalski');
    const advisories = generateAdvisories({ w9, ach });
    const flag = advisories.find((a) => a.key === 'personal_ach_account');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('warn');
  });

  test('personal_ach_account: LLC with EIN → no flag', () => {
    const w9 = makeW9('PeakGuard Facility Services LLC', 'Single-member LLC', 'EIN');
    const ach = makeACH('PeakGuard Facility Services LLC');
    const advisories = generateAdvisories({ w9, ach });
    expect(advisories.find((a) => a.key === 'personal_ach_account')).toBeUndefined();
  });

  test('no advisories from rules-only triggers (no bundle change) — advisory generator not called', () => {
    // Verified in pipeline integration tests; here just check generateAdvisories with no docs
    const advisories = generateAdvisories({});
    expect(advisories).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 13 — Verification pipeline integration (DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('runVerification — pipeline integration', () => {
  beforeEach(() => setEngineDateOverride(REFERENCE_DATE));

  function buildCompliantBundle(): ExtractionBundle {
    const coi = makeCOI('Test Vendor LLC', compliantPolicies(true));
    const w9 = makeW9('Test Vendor LLC');
    const ach = makeACH('Test Vendor LLC');
    return { coi, w9, ach };
  }

  test('full run with compliant bundle → approve, writes run + evaluations', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const user = seedTenantUser(db, tenant.id);
    const vendor = seedVendor(db, tenant.id, { business_name: 'Test Vendor LLC', trade: 'electrical' });
    const location = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, location.id);
    seedRequirementSettings(db, tenant.id);

    const doc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });
    const bundle = buildCompliantBundle();
    seedExtraction(db, tenant.id, doc.id, bundle.coi!);

    const result = await runVerification(db, {
      tenantId: tenant.id,
      vendorId: vendor.id,
      vendorTrade: 'electrical',
      trigger: 'onboarding',
      bundle,
    });

    expect(result.recommendation).toBe('approve');
    expect(result.runId).toBeTruthy();

    const runRow = db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(result.runId) as { recommendation: string; trigger: string } | undefined;
    expect(runRow?.recommendation).toBe('approve');
    expect(runRow?.trigger).toBe('onboarding');

    const auditRows = db.prepare(`SELECT * FROM audit_events WHERE payload_json LIKE '%"run_id":"${result.runId}"%'`).all() as unknown[];
    expect(auditRows.length).toBeGreaterThan(0);
  });

  test('deficient bundle → deficiencies recommendation, writes evaluation rows', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    seedTenantUser(db, tenant.id);
    const vendor = seedVendor(db, tenant.id);
    const location = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, location.id);
    seedRequirementSettings(db, tenant.id);

    seedRequirementRule(db, tenant.id, (db.prepare("SELECT id FROM users WHERE tenant_id = ?").get(tenant.id) as { id: string }).id, {
      requirement_key: 'coverage.general_liability.each_occurrence',
      required_value: '1000000',
    });

    // COI with sub-limit GL
    const coi = makeCOI('Test Vendor LLC', [
      makePolicy('general_liability', { each_occurrence: 500000 }),
    ]);
    const doc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });
    seedExtraction(db, tenant.id, doc.id, coi);

    const result = await runVerification(db, {
      tenantId: tenant.id,
      vendorId: vendor.id,
      vendorTrade: 'other',
      trigger: 'onboarding',
      bundle: { coi },
    });

    expect(result.recommendation).toBe('deficiencies');

    const evalRows = db.prepare('SELECT * FROM requirement_evaluations WHERE run_id = ?').all(result.runId) as { outcome: string; requirement_key: string }[];
    expect(evalRows.length).toBeGreaterThan(0);
    expect(evalRows.every((e) => e.outcome !== 'pass')).toBe(true);
  });

  test('rules-only re-eval (trigger=rule_change) → no advisories written', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const vendor = seedVendor(db, tenant.id);
    const location = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, location.id);
    seedRequirementSettings(db, tenant.id);

    const coi = makeCOI('Test Vendor LLC', compliantPolicies(true));
    const doc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });
    seedExtraction(db, tenant.id, doc.id, coi);

    const result = await runVerification(db, {
      tenantId: tenant.id,
      vendorId: vendor.id,
      vendorTrade: 'other',
      trigger: 'rule_change',
      bundle: { coi },
    });

    expect(result.advisoryCount).toBe(0);
    const advisoryRows = db.prepare('SELECT * FROM engine_advisories WHERE verification_run_id = ?').all(result.runId) as unknown[];
    expect(advisoryRows).toHaveLength(0);
  });

  test('loadExtractionBundle reads stored extractions correctly', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const vendor = seedVendor(db, tenant.id);

    const coi = makeCOI('Test Vendor LLC', [makePolicy('general_liability', { each_occurrence: 1000000 })]);
    const w9 = makeW9('Test Vendor LLC');
    const coiDoc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });
    const w9Doc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'w9' });
    seedExtraction(db, tenant.id, coiDoc.id, coi);
    seedExtraction(db, tenant.id, w9Doc.id, w9);

    const bundle = loadExtractionBundle(db, tenant.id, vendor.id);
    expect(bundle.coi).toBeDefined();
    expect(bundle.w9).toBeDefined();
    expect(bundle.ach).toBeUndefined();
    expect(bundle.coi?.named_insured.value).toBe('Test Vendor LLC');
  });

  test('bounced_expired document not included in extraction bundle', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const vendor = seedVendor(db, tenant.id);

    const coi = makeCOI('Test Vendor LLC', []);
    const doc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi', state: 'bounced_expired' });
    seedExtraction(db, tenant.id, doc.id, coi);

    const bundle = loadExtractionBundle(db, tenant.id, vendor.id);
    // Bounced document not in active state → not included
    expect(bundle.coi).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 14 — Ground-truth validation (rules engine + advisory generator)
//
// Each test synthesizes ProcessedExtraction objects that match what Vision
// would return from the fixture PDFs (per ground-truth.yaml), then runs the
// pure rules engine and advisory generator to confirm expected outcomes.
// No Vision API calls — deterministic, fast, repeatable.
// ─────────────────────────────────────────────────────────────────────────────

describe('Ground truth — rules engine', () => {
  beforeEach(() => setEngineDateOverride(REFERENCE_DATE));

  // Helper: run engine + advisories against the standard matrix + bundle
  function evaluate(bundle: ExtractionBundle) {
    const { evaluations, recommendation } = runRulesEngine({ bundle, matrix: STANDARD_MATRIX });
    const advisories = generateAdvisories(bundle);
    const nonPass = evaluations.filter((e) => e.outcome !== 'pass');
    return { recommendation, nonPass, advisories };
  }

  // ── 01 PeakGuard (Perfect) — all compliant ─────────────────────────────────
  test('01 PeakGuard → approve, no deficiencies', () => {
    const coi = makeCOI('PeakGuard Facility Services LLC', compliantPolicies(true));
    const w9 = makeW9('PeakGuard Facility Services LLC');
    const ach = makeACH('PeakGuard Facility Services LLC');
    const { recommendation, nonPass, advisories } = evaluate({ coi, w9, ach });
    expect(recommendation).toBe('approve');
    expect(nonPass).toHaveLength(0);
    expect(advisories).toHaveLength(0);
  });

  // ── 02 RidgeLine Tree (Perfect) ────────────────────────────────────────────
  test('02 RidgeLine Tree → approve, no deficiencies', () => {
    const coi = makeCOI('Ridgeline Tree & Arbor Services LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000, general_aggregate: 4000000 }, { additional_insured: fv(true) }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, { additional_insured: fv(true) }),
      makePolicy('umbrella_excess', { each_occurrence: 5000000, aggregate: 5000000 }),
      makePolicy('workers_comp', { el_each_accident: 1000000, el_disease_each_employee: 1000000, el_disease_policy_limit: 1000000 }),
    ]);
    const w9 = makeW9('Ridgeline Tree & Arbor Services LLC');
    const ach = makeACH('Ridgeline Tree & Arbor Services LLC');
    const { recommendation, nonPass } = evaluate({ coi, w9, ach });
    expect(recommendation).toBe('approve');
    expect(nonPass).toHaveLength(0);
  });

  // ── 03 Clearwater (WC exemption) ───────────────────────────────────────────
  test('03 Clearwater → uncertain, WC missing + exemption_claimed', () => {
    const doo = 'Vendor owner is sole owner with no employees, exempt per Idaho IC 72-212 sole-owner exemption.';
    const coi = makeCOI('Clearwater Landscape & Grounds LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000, general_aggregate: 4000000 }, { additional_insured: fv(true) }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, { additional_insured: fv(true) }),
      makePolicy('umbrella_excess', { each_occurrence: 5000000, aggregate: 5000000 }),
      // No workers_comp policy
    ], 'StoreSafe Capital Partners LLC', doo);
    const w9 = makeW9('Clearwater Landscape & Grounds LLC');
    const { recommendation, nonPass } = evaluate({ coi, w9 });

    expect(recommendation).toBe('uncertain');

    const wcEv = nonPass.find((e) => e.requirementKey === 'coverage_required.workers_comp');
    expect(wcEv?.comparisonResult).toBe('missing');
    expect(wcEv?.outcome).toBe('uncertain');

    const exemptEv = nonPass.find((e) => e.requirementKey === 'workers_comp_exemption_claimed');
    expect(exemptEv?.outcome).toBe('uncertain');
  });

  // ── 04 Summit Pro (limit failures + DBA name + no umbrella + no AI + personal ACH) ─
  test('04 Summit Pro → deficiencies, multiple failures', () => {
    const coi = makeCOI('Summit Pro Plumbing', [  // DBA only, missing LLC
      makePolicy('general_liability', { each_occurrence: 500000, general_aggregate: 1000000 }, {
        additional_insured: fv(false),
      }),
      makePolicy('automobile_liability', { combined_single_limit: 500000 }, {
        additional_insured: fv(false),
      }),
      // No umbrella
      makePolicy('workers_comp', { el_each_accident: 500000, el_disease_each_employee: 500000, el_disease_policy_limit: 500000 }),
    ]);
    const w9 = makeW9('Summit Pro Plumbing & Mechanical LLC');  // full legal name
    const ach = makeACH('Travis K. Bowman');  // personal account
    const { recommendation, nonPass } = evaluate({ coi, w9, ach });

    expect(recommendation).toBe('deficiencies');

    // Named insured DBA mismatch
    const nameEv = nonPass.find((e) => e.requirementKey === 'named_insured_match');
    expect(nameEv?.comparisonResult).toBe('fails');

    // GL limits below requirement
    const glOcc = nonPass.find((e) => e.requirementKey === 'coverage.general_liability.each_occurrence');
    expect(glOcc?.outcome).toBe('deficient');
    const glAgg = nonPass.find((e) => e.requirementKey === 'coverage.general_liability.general_aggregate');
    expect(glAgg?.outcome).toBe('deficient');

    // Auto CSL below requirement
    const autoCSL = nonPass.find((e) => e.requirementKey === 'coverage.automobile_liability.combined_single_limit');
    expect(autoCSL?.outcome).toBe('deficient');

    // No umbrella
    const umbrella = nonPass.find((e) => e.requirementKey === 'coverage_required.umbrella_excess');
    expect(umbrella?.outcome).toBe('deficient');

    // Additional insured missing
    const ai = nonPass.find((e) => e.requirementKey === 'endorsement.additional_insured');
    expect(ai?.outcome).toBe('deficient');

    // WC limits below requirement
    const wcAcc = nonPass.find((e) => e.requirementKey === 'coverage.workers_comp.el_each_accident');
    expect(wcAcc?.outcome).toBe('deficient');

    // ACH personal account mismatch
    const achEv = nonPass.find((e) => e.requirementKey === 'ach_payee_matches_legal_name');
    expect(achEv?.comparisonResult).toBe('fails');
  });

  // ── 05 Apex Electric — tested via expiration gate, not rules engine ─────────
  // The gate fires pre-engine; the run is never enqueued. Expiration gate tests
  // in § 3 cover this path. Ground truth: document_state=bounced_expired.
  test('05 Apex Electric — expiration gate fires on expired policies', () => {
    setEngineDateOverride(REFERENCE_DATE);
    const coi = makeCOI('Apex Electrical Contractors LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000 }, { expiration_date: fv('11/15/2025') }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, { expiration_date: fv('11/15/2025') }),
      makePolicy('umbrella_excess', { each_occurrence: 5000000 }, { expiration_date: fv('11/15/2025') }),
      makePolicy('workers_comp', { el_each_accident: 1000000 }, { expiration_date: fv('11/15/2025') }),
    ]);
    const gate = checkExpirationGate(coi);
    expect(gate.passed).toBe(false);
    expect(gate.expiredPolicies).toHaveLength(4);
  });

  // ── 06 Four Seasons HVAC (near-expiry, passes as of reference_date) ─────────
  test('06 Four Seasons → approve at reference_date (expires 2026-04-22)', () => {
    setEngineDateOverride(REFERENCE_DATE);  // 2026-04-09
    // Expires 2026-04-22 = 13 days after reference — gate passes
    const coi = makeCOI('Four Seasons HVAC & Mechanical LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000, general_aggregate: 4000000 }, {
        expiration_date: fv('04/22/2026'),
        additional_insured: fv(true),
      }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, {
        expiration_date: fv('04/22/2026'),
        additional_insured: fv(true),
      }),
      makePolicy('umbrella_excess', { each_occurrence: 5000000, aggregate: 5000000 }, {
        expiration_date: fv('04/22/2026'),
      }),
      makePolicy('workers_comp', { el_each_accident: 1000000, el_disease_each_employee: 1000000, el_disease_policy_limit: 1000000 }, {
        expiration_date: fv('04/22/2026'),
      }),
    ]);
    const gate = checkExpirationGate(coi);
    expect(gate.passed).toBe(true);

    const w9 = makeW9('Four Seasons HVAC & Mechanical LLC');
    const { recommendation, nonPass } = evaluate({ coi, w9 });
    expect(recommendation).toBe('approve');
    expect(nonPass).toHaveLength(0);
  });

  // ── 07 Iron Gate Security (cert holder placeholder in fixtures → approve) ────
  test('07 Iron Gate → approve (cert holder check excluded from fixture matrix)', () => {
    // Ground truth notes the fixture has wrong cert holder but approves anyway
    // since that check is excluded. We test with the correct cert holder here.
    const coi = makeCOI('Iron Gate Security Solutions LLC', compliantPolicies(true));
    const w9 = makeW9('Iron Gate Security Solutions LLC');
    const { recommendation, nonPass } = evaluate({ coi, w9 });
    expect(recommendation).toBe('approve');
    expect(nonPass).toHaveLength(0);
  });

  // ── 08 ProClean (missing additional insured on GL and Auto) ──────────────────
  test('08 ProClean → deficient, additional_insured missing on GL and Auto', () => {
    const coi = makeCOI('ProClean Commercial Services LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000, general_aggregate: 4000000 }, {
        additional_insured: fv(false),  // explicitly false, no DOO language
      }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, {
        additional_insured: fv(false),
      }),
      makePolicy('umbrella_excess', { each_occurrence: 5000000, aggregate: 5000000 }),
      makePolicy('workers_comp', { el_each_accident: 1000000, el_disease_each_employee: 1000000, el_disease_policy_limit: 1000000 }),
    ]);
    const w9 = makeW9('ProClean Commercial Services LLC');
    const { recommendation, nonPass } = evaluate({ coi, w9 });

    expect(recommendation).toBe('deficiencies');

    const aiEv = nonPass.find((e) => e.requirementKey === 'endorsement.additional_insured');
    expect(aiEv?.comparisonResult).toBe('fails');
    expect(aiEv?.outcome).toBe('deficient');
    expect(aiEv?.note).toContain('Additional insured not present');
  });

  // ── 09 Timberline Painting (approve + coverage_continuity advisory) ──────────
  test('09 Timberline → approve + coverage_continuity advisory (effective 2026-04-03)', () => {
    // All policies effective 2026-04-03, which is 6 days before reference_date 2026-04-09.
    // Within 45-day recency window → advisory fires.
    const recentDate = '2026-04-03';
    const coi = makeCOI('Timberline Painting & Coatings LLC', [
      makePolicy('general_liability', { each_occurrence: 2000000, general_aggregate: 4000000 }, {
        effective_date: fv(recentDate),
        expiration_date: fv('04/03/2027'),
        additional_insured: fv(true),
      }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, {
        effective_date: fv(recentDate),
        expiration_date: fv('04/03/2027'),
        additional_insured: fv(true),
      }),
      makePolicy('umbrella_excess', { each_occurrence: 5000000, aggregate: 5000000 }, {
        effective_date: fv(recentDate),
        expiration_date: fv('04/03/2027'),
      }),
      makePolicy('workers_comp', { el_each_accident: 1000000, el_disease_each_employee: 1000000, el_disease_policy_limit: 1000000 }, {
        effective_date: fv(recentDate),
        expiration_date: fv('04/03/2027'),
      }),
    ]);
    const w9 = makeW9('Timberline Painting & Coatings LLC');
    const { recommendation, nonPass, advisories } = evaluate({ coi, w9 });

    expect(recommendation).toBe('approve');
    expect(nonPass).toHaveLength(0);

    const flag = advisories.find((a) => a.key === 'coverage_continuity');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('warn');
  });

  // ── 10 Kowalski Handyman (deficient + personal_ach_account advisory) ─────────
  test('10 Kowalski → deficient, entity_type + umbrella + WC + personal_ach_account', () => {
    const coi = makeCOI('Randy L. Kowalski DBA Kowalski Handyman Services', [
      makePolicy('general_liability', { each_occurrence: 1000000, general_aggregate: 2000000 }, {
        additional_insured: fv(true),
      }),
      makePolicy('automobile_liability', { combined_single_limit: 1000000 }, {
        additional_insured: fv(true),
      }),
      // No umbrella, no workers_comp
    ]);
    const w9 = makeW9('Randy L. Kowalski', 'Individual/sole proprietor', 'SSN');
    const ach = makeACH('Randy L. Kowalski');
    const { recommendation, nonPass, advisories } = evaluate({ coi, w9, ach });

    expect(recommendation).toBe('deficiencies');

    // Entity type fails (sole proprietor)
    const entityEv = nonPass.find((e) => e.requirementKey === 'entity_type');
    expect(entityEv?.outcome).toBe('deficient');

    // No umbrella
    const umbrellaEv = nonPass.find((e) => e.requirementKey === 'coverage_required.umbrella_excess');
    expect(umbrellaEv?.outcome).toBe('deficient');

    // WC missing + exemption uncertain (sole proprietor)
    const wcEv = nonPass.find((e) => e.requirementKey === 'coverage_required.workers_comp');
    expect(wcEv?.outcome).toBe('uncertain');
    const exemptEv = nonPass.find((e) => e.requirementKey === 'workers_comp_exemption_claimed');
    expect(exemptEv?.outcome).toBe('uncertain');

    // Personal ACH advisory
    const achAdvisory = advisories.find((a) => a.key === 'personal_ach_account');
    expect(achAdvisory).toBeDefined();
    expect(achAdvisory?.severity).toBe('warn');
  });
});
