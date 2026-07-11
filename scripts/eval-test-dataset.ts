/**
 * eval-test-dataset.ts
 *
 * Runs the AI Verification Engine against the 10-vendor test dataset and produces:
 *   - Confusion matrix (overall recommendation: approve / deficiencies / uncertain / bounced_expired)
 *   - Per-requirement_key accuracy (expected outcome vs. actual)
 *   - Per-advisory accuracy (expected vs. actual advisory flags)
 *   - Mismatch list
 *   - (Vision API spend is not tracked here — Anthropic Console shows usage)
 *
 * Usage:
 *   dotenv -- tsx scripts/eval-test-dataset.ts
 *
 * Requires a local Postgres server (same PG_HOST/PG_PORT/PG_USER/PG_PASSWORD +
 * PG_TEST_TEMPLATE_DATABASE as the test suite — see .env). Phase 13 migration: this used to
 * spin up a throwaway better-sqlite3 :memory: database; there's no zero-setup in-memory
 * equivalent under Postgres, so it now clones the same schema-only template the test suite
 * uses (src/lib/db/test-isolation.ts) into a fresh ephemeral database, and drops it when done.
 *
 * The script freezes the engine clock to the reference_date from ground-truth.yaml
 * so expiration-sensitive vendors (four_seasons, apex) evaluate correctly.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import { createEphemeralTestDatabase, dropEphemeralTestDatabase } from '../src/lib/db/test-isolation';
import type { Db } from '../src/lib/db/client';

process.env['STORAGE_DRIVER'] = 'filesystem';
process.env['STORAGE_PATH'] = '/tmp/unifycoi-eval-blobs';

import { extractDocument, setEngineDateOverride, checkExpirationGate, getUsage, resetUsage } from '../src/lib/extraction/extractor';
import { runRulesEngine } from '../src/lib/verification/engine';
import { generateAdvisories } from '../src/lib/verification/advisories';
import { resolveRequirements } from '../src/lib/requirements/resolver';
import type { ExtractionBundle, DocType, ProcessedCOIExtraction } from '../src/lib/extraction/types';
import type { EvaluationResult } from '../src/lib/verification/engine';

// ── Ground truth types ─────────────────────────────────────────────────────────

interface GroundTruthEvaluation {
  requirement_key: string;
  expected_outcome: 'fails' | 'missing' | 'uncertain';
  reason: string;
}

interface GroundTruthAdvisory {
  key: string;
  severity: string;
  message: string;
  evidence: string;
}

interface VendorGroundTruth {
  display_name: string;
  fixture_dir: string;
  fixture_status?: string;
  expected_overall: string;
  expected_gate?: string;
  expected_evaluations: GroundTruthEvaluation[];
  expected_artifacts?: {
    extraction: string;
    verification_run: string;
    requirement_evaluations: string[];
    document_state: string;
  };
  advisory_flags?: GroundTruthAdvisory[];
}

interface GroundTruth {
  reference_date: string;
  vendors: Record<string, VendorGroundTruth>;
}

// ── Result tracking ────────────────────────────────────────────────────────────

// Pricing constants (USD per token) — claude-sonnet-4-6 primary, claude-opus-4-8 escalation
const PRICE = {
  sonnet: { in: 3.0 / 1_000_000, out: 15.0 / 1_000_000 },
  opus:   { in: 15.0 / 1_000_000, out: 75.0 / 1_000_000 },
};

interface VendorResult {
  vendorKey: string;
  displayName: string;
  expectedOverall: string;
  actualOverall: string;
  correct: boolean;
  evalMismatches: string[];
  advisoryMismatches: string[];
  error?: string;
  skipped?: boolean;
  usage?: { calls: number; input_tokens: number; output_tokens: number; escalated: boolean };
}

// ── Main ───────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, '..', 'test-fixtures', 'vendors');
const GROUND_TRUTH_PATH = path.join(__dirname, '..', 'test-fixtures', 'ground-truth.yaml');

// Org-level requirement rules from ground-truth.yaml
const ORG_REQUIREMENTS: Record<string, string> = {
  'coverage.general_liability.each_occurrence': '1000000',
  'coverage.general_liability.general_aggregate': '2000000',
  'coverage.automobile_liability.combined_single_limit': '1000000',
  'coverage.umbrella_excess.each_occurrence': '5000000',
  'coverage.umbrella_excess.aggregate': '5000000',
  'coverage.workers_comp.el_each_accident': '1000000',
  'coverage.workers_comp.el_disease_each_employee': '1000000',
  'coverage.workers_comp.el_disease_policy_limit': '1000000',
  'coverage_required.general_liability': 'true',
  'coverage_required.automobile_liability': 'true',
  'coverage_required.workers_comp': 'true',
  'coverage_required.umbrella_excess': 'true',
  'endorsement.additional_insured': 'true',
  'certificate_holder': 'StoreSafe Capital Partners LLC',
  'entity_type': 'llc_or_corp',
};

const EVAL_TENANT_ID = 'eval-tenant-001';
const EVAL_LOCATION_ID = 'eval-location-001';
const EVAL_ADMIN_ID = 'eval-admin-001';

async function setupDb(): Promise<{ name: string; db: Db }> {
  const { name, db } = await createEphemeralTestDatabase();

  const now = new Date();
  await db.insertInto('tenants').values({
    id: EVAL_TENANT_ID, name: 'Eval Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: now,
  }).execute();

  await db.insertInto('users').values({
    id: EVAL_ADMIN_ID, tenant_id: EVAL_TENANT_ID, email: 'admin@eval.test', name: 'Eval Admin',
    role: 'admin', password_hash: 'x', status: 'active', created_at: now,
  }).execute();

  await db.insertInto('locations').values({
    id: EVAL_LOCATION_ID, tenant_id: EVAL_TENANT_ID, name: 'Eval Store', address: '1234 Storage Blvd', status: 'active', created_at: now,
  }).execute();

  await db.insertInto('requirement_settings').values({
    tenant_id: EVAL_TENANT_ID, precedence_policy: 'strictest',
  }).execute();

  for (const [key, value] of Object.entries(ORG_REQUIREMENTS)) {
    await db.insertInto('requirement_rules').values({
      id: randomUUID(), tenant_id: EVAL_TENANT_ID, scope_type: 'org', scope_ref: null,
      requirement_key: key, required_value: value, created_by: EVAL_ADMIN_ID, reason: 'eval seed', created_at: now,
    }).execute();
  }

  return { name, db };
}

function detectDocType(filename: string): DocType | null {
  const lower = filename.toLowerCase();
  if (lower.includes('acord25') || lower.includes('coi')) return 'coi';
  if (lower.includes('w9') || lower.includes('w-9')) return 'w9';
  if (lower.includes('ach') || lower.includes('directdeposit') || lower.includes('direct_deposit')) return 'ach';
  return null;
}

function findFixtureFiles(fixtureDir: string): Array<{ path: string; docType: DocType }> {
  const dirPath = path.join(FIXTURES_DIR, fixtureDir);
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((f) => f.endsWith('.pdf'))
    .map((f) => ({ filename: f, docType: detectDocType(f) }))
    .filter((f): f is { filename: string; docType: DocType } => f.docType !== null)
    .map((f) => ({ path: path.join(dirPath, f.filename), docType: f.docType }));
}

// Map ground-truth expected_outcome to actual evaluation check.
// 'missing' checks comparisonResult (not outcome) because WC-exemption makes
// comparison_result='missing' produce outcome='uncertain', not 'deficient'.
function expectedOutcomeMatches(expected: string, actual: EvaluationResult): boolean {
  if (expected === 'uncertain') return actual.outcome === 'uncertain';
  if (expected === 'fails') return actual.outcome === 'deficient';
  if (expected === 'missing') return actual.comparisonResult === 'missing';
  return false;
}

async function evalVendor(
  vendorKey: string,
  gt: VendorGroundTruth,
  db: Db,
  referenceDate: Date
): Promise<VendorResult> {
  const result: VendorResult = {
    vendorKey,
    displayName: gt.display_name,
    expectedOverall: gt.expected_overall,
    actualOverall: '',
    correct: false,
    evalMismatches: [],
    advisoryMismatches: [],
  };

  if (gt.fixture_status === 'MISSING') {
    result.skipped = true;
    result.actualOverall = 'SKIPPED';
    result.correct = false;
    console.log(`  [SKIP] ${gt.display_name} — fixtures missing`);
    return result;
  }

  const files = findFixtureFiles(gt.fixture_dir);
  if (files.length === 0) {
    result.error = `No fixture PDFs found in ${gt.fixture_dir}`;
    result.actualOverall = 'ERROR';
    return result;
  }

  // Extract all documents — track per-vendor usage
  const bundle: ExtractionBundle = {};
  let coiExtraction: ProcessedCOIExtraction | null = null;
  let vendorEscalated = false;

  resetUsage();
  try {
    for (const file of files) {
      const pdfBytes = fs.readFileSync(file.path);
      const { payload, escalated } = await extractDocument(pdfBytes, file.docType);
      if (escalated) vendorEscalated = true;
      if (file.docType === 'coi') {
        bundle.coi = payload as ProcessedCOIExtraction;
        coiExtraction = payload as ProcessedCOIExtraction;
      } else if (file.docType === 'w9') {
        bundle.w9 = payload as typeof bundle.w9;
      } else if (file.docType === 'ach') {
        bundle.ach = payload as typeof bundle.ach;
      }
    }
  } catch (err) {
    result.error = `Extraction failed: ${(err as Error).message}`;
    result.actualOverall = 'ERROR';
    return result;
  }
  result.usage = { ...getUsage(), escalated: vendorEscalated };

  // Check expiration gate for COI
  if (coiExtraction) {
    const gate = checkExpirationGate(coiExtraction);
    if (!gate.passed) {
      result.actualOverall = 'bounced_expired';
      result.correct = gt.expected_overall === 'bounced_expired';
      if (!result.correct) {
        result.evalMismatches.push(`Overall: expected ${gt.expected_overall}, got bounced_expired`);
      }
      return result;
    }
  }

  // Load requirements from DB for the eval location
  const matrix = await resolveRequirements(db, {
    tenantId: EVAL_TENANT_ID,
    vendorTrade: 'other',
    locationId: EVAL_LOCATION_ID,
    precedence: 'strictest',
  });

  // Run rules engine
  const engineOutput = runRulesEngine({ bundle, matrix });
  const { evaluations, recommendation } = engineOutput;

  // Map recommendation to expected_overall format
  const actualOverall = recommendation === 'approve' ? 'approve'
    : recommendation === 'deficiencies' ? 'deficient'
    : 'uncertain';

  result.actualOverall = actualOverall;
  result.correct = actualOverall === gt.expected_overall;

  if (!result.correct) {
    result.evalMismatches.push(`Overall: expected '${gt.expected_overall}', got '${actualOverall}'`);
  }

  // Check per-requirement evaluations
  const expectedNonPass = gt.expected_evaluations ?? [];
  for (const expected of expectedNonPass) {
    const actual = evaluations.find((e) => e.requirementKey === expected.requirement_key);
    if (!actual) {
      result.evalMismatches.push(`Missing evaluation for ${expected.requirement_key} (expected: ${expected.expected_outcome})`);
    } else if (!expectedOutcomeMatches(expected.expected_outcome, actual)) {
      result.evalMismatches.push(
        `${expected.requirement_key}: expected outcome=${expected.expected_outcome}, got outcome=${actual.outcome} (comparison=${actual.comparisonResult})`
      );
    }
  }

  // Check for unexpected non-pass evaluations (false positives)
  const expectedKeys = new Set(expectedNonPass.map((e) => e.requirement_key));
  const unexpectedFails = evaluations.filter(
    (e) => e.outcome !== 'pass' && !expectedKeys.has(e.requirementKey)
  );
  for (const unexp of unexpectedFails) {
    result.evalMismatches.push(
      `Unexpected non-pass: ${unexp.requirementKey} → outcome=${unexp.outcome} (comparison=${unexp.comparisonResult})`
    );
  }

  // Check advisory flags
  const advisories = generateAdvisories(bundle);
  const expectedAdvisories = gt.advisory_flags ?? [];
  for (const expAdv of expectedAdvisories) {
    const actual = advisories.find((a) => a.key === expAdv.key);
    if (!actual) {
      result.advisoryMismatches.push(`Missing advisory: ${expAdv.key} (severity: ${expAdv.severity})`);
    } else if (actual.severity !== expAdv.severity) {
      result.advisoryMismatches.push(`${expAdv.key}: expected severity=${expAdv.severity}, got=${actual.severity}`);
    }
  }
  const expectedAdvKeys = new Set(expectedAdvisories.map((a) => a.key));
  for (const actual of advisories) {
    if (!expectedAdvKeys.has(actual.key)) {
      result.advisoryMismatches.push(`Unexpected advisory: ${actual.key} (${actual.severity})`);
    }
  }

  return result;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  UnifyCOI — AI Verification Engine Eval');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const groundTruth = yaml.load(fs.readFileSync(GROUND_TRUTH_PATH, 'utf-8')) as GroundTruth;
  const referenceDate = new Date(groundTruth.reference_date + 'T00:00:00Z');

  // Freeze engine clock to reference_date
  setEngineDateOverride(referenceDate);
  console.log(`\nClock frozen to: ${referenceDate.toISOString().slice(0, 10)}`);

  const { name: dbName, db } = await setupDb();

  try {
    const results: VendorResult[] = [];
    const vendors = groundTruth.vendors;

    for (const [vendorKey, gt] of Object.entries(vendors)) {
      console.log(`\n── ${gt.display_name} ──`);
      const result = await evalVendor(vendorKey, gt, db, referenceDate);
      results.push(result);

      const icon = result.skipped ? '⏭' : result.correct && result.evalMismatches.length === 0 && result.advisoryMismatches.length === 0 ? '✓' : '✗';
      console.log(`  ${icon} Overall: expected=${result.expectedOverall} actual=${result.actualOverall}`);
      if (result.usage) {
        const u = result.usage;
        // Primary (sonnet) cost vs escalation (opus) cost; escalated docs use opus for the extra pass only
        const primaryCost = u.input_tokens * PRICE.sonnet.in + u.output_tokens * PRICE.sonnet.out;
        console.log(`     API calls=${u.calls} in=${u.input_tokens.toLocaleString()} out=${u.output_tokens.toLocaleString()} ~$${primaryCost.toFixed(4)}${u.escalated ? ' [ESCALATED]' : ''}`);
      }
      if (result.evalMismatches.length > 0) {
        console.log('  Evaluation mismatches:');
        result.evalMismatches.forEach((m) => console.log(`    - ${m}`));
      }
      if (result.advisoryMismatches.length > 0) {
        console.log('  Advisory mismatches:');
        result.advisoryMismatches.forEach((m) => console.log(`    - ${m}`));
      }
      if (result.error) console.log(`  ERROR: ${result.error}`);
    }

    // ── Confusion matrix ─────────────────────────────────────────────────────────
    const nonSkipped = results.filter((r) => !r.skipped && !r.error);
    const allOveralls = ['approve', 'deficient', 'uncertain', 'bounced_expired'];
    const matrix: Record<string, Record<string, number>> = {};
    for (const exp of allOveralls) {
      matrix[exp] = {};
      for (const act of allOveralls) matrix[exp][act] = 0;
    }
    for (const r of nonSkipped) {
      const exp = r.expectedOverall;
      const act = r.actualOverall;
      if (!matrix[exp]) matrix[exp] = {};
      matrix[exp][act] = (matrix[exp][act] ?? 0) + 1;
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Confusion Matrix (expected → actual)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const header = [''].concat(allOveralls).map((s) => s.padEnd(18)).join(' ');
    console.log('  ' + header);
    for (const exp of allOveralls) {
      const row = [exp].concat(allOveralls.map((act) => String(matrix[exp]?.[act] ?? 0))).map((s) => s.padEnd(18)).join(' ');
      console.log('  ' + row);
    }

    // ── Accuracy summary ──────────────────────────────────────────────────────────
    const totalEvaluated = nonSkipped.length;
    const overallCorrect = nonSkipped.filter((r) => r.correct).length;
    const evalCorrect = nonSkipped.filter((r) => r.evalMismatches.length === 0).length;
    const advCorrect = nonSkipped.filter((r) => r.advisoryMismatches.length === 0).length;
    const fullyCorrect = nonSkipped.filter(
      (r) => r.correct && r.evalMismatches.length === 0 && r.advisoryMismatches.length === 0
    ).length;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Accuracy Summary');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Vendors evaluated:     ${totalEvaluated} / ${results.length} (${results.filter((r) => r.skipped).length} skipped)`);
    console.log(`  Overall correct:       ${overallCorrect} / ${totalEvaluated} (${pct(overallCorrect, totalEvaluated)})`);
    console.log(`  Eval key accuracy:     ${evalCorrect} / ${totalEvaluated} (${pct(evalCorrect, totalEvaluated)})`);
    console.log(`  Advisory accuracy:     ${advCorrect} / ${totalEvaluated} (${pct(advCorrect, totalEvaluated)})`);
    console.log(`  Fully correct:         ${fullyCorrect} / ${totalEvaluated} (${pct(fullyCorrect, totalEvaluated)})`);

    // ── Per-document Vision spend breakdown ───────────────────────────────────────
    const spendRows = nonSkipped.filter((r) => r.usage);
    if (spendRows.length > 0) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  Vision API Spend (primary model pricing; escalated=Opus 4.8 extra pass)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  Vendor'.padEnd(42) + 'Calls'.padEnd(8) + 'In tok'.padEnd(10) + 'Out tok'.padEnd(10) + 'Cost (USD)');
      console.log('  ' + '─'.repeat(78));
      let totalIn = 0, totalOut = 0, totalCost = 0, totalCalls = 0;
      for (const r of spendRows) {
        const u = r.usage!;
        const cost = u.input_tokens * PRICE.sonnet.in + u.output_tokens * PRICE.sonnet.out;
        const esc = u.escalated ? '*' : ' ';
        console.log(`  ${(r.displayName.slice(0, 39) + esc).padEnd(42)}${String(u.calls).padEnd(8)}${u.input_tokens.toLocaleString().padEnd(10)}${u.output_tokens.toLocaleString().padEnd(10)}$${cost.toFixed(4)}`);
        totalIn += u.input_tokens;
        totalOut += u.output_tokens;
        totalCost += cost;
        totalCalls += u.calls;
      }
      console.log('  ' + '─'.repeat(78));
      console.log(`  ${'TOTAL'.padEnd(42)}${String(totalCalls).padEnd(8)}${totalIn.toLocaleString().padEnd(10)}${totalOut.toLocaleString().padEnd(10)}$${totalCost.toFixed(4)}`);
      console.log('  (* = escalated: one extra Opus 4.8 corroboration pass on low-confidence critical fields)');
    }

    // ── Mismatch report ───────────────────────────────────────────────────────────
    const mismatches = nonSkipped.filter(
      (r) => !r.correct || r.evalMismatches.length > 0 || r.advisoryMismatches.length > 0
    );
    if (mismatches.length > 0) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  Mismatches');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      for (const r of mismatches) {
        console.log(`\n  ${r.displayName}:`);
        r.evalMismatches.forEach((m) => console.log(`    [eval]     ${m}`));
        r.advisoryMismatches.forEach((m) => console.log(`    [advisory] ${m}`));
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Reset clock override
    setEngineDateOverride(null);

    process.exitCode = fullyCorrect === totalEvaluated ? 0 : 1;
  } finally {
    await dropEphemeralTestDatabase(dbName, db);
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
