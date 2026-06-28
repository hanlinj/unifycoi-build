// Verification run orchestrator — Phase 4.
//
// Coordinates the full pipeline:
//   1. Load documents + stored extractions from DB
//   2. For each vendor-location: resolve requirements
//   3. Run rules engine (pure function)
//   4. Roll up recommendation across all locations
//   5. Generate advisories (full pipeline only — not rules-only re-eval)
//   6. Write verification_run, requirement_evaluations, engine_advisories rows
//   7. Emit audit events

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { resolveRequirements } from '@/lib/requirements/resolver';
import { runRulesEngine, rollUp } from './engine';
import { generateAdvisories } from './advisories';
import { env } from '@/lib/env';
import type { ExtractionBundle, ProcessedCOIExtraction, ProcessedW9Extraction, ProcessedACHExtraction } from '@/lib/extraction/types';
import type { EvaluationResult } from './engine';

const ENGINE_VERSION = '1.0.0';

export type VerificationTrigger = 'onboarding' | 'resubmission' | 'renewal' | 'rule_change' | 'location_add';

interface VendorLocation {
  id: string;
  location_id: string;
  status: string;
}

interface DocumentRow {
  id: string;
  doc_type: 'coi' | 'w9' | 'ach' | 'license';
  state: string;
}

interface ExtractionRow {
  id: string;
  document_id: string;
  doc_type: string;
  payload_json: string;
  created_at: string;
}

// ── Load stored extractions for a vendor ─────────────────────────────────────

export function loadExtractionBundle(
  db: Database.Database,
  tenantId: string,
  vendorId: string
): ExtractionBundle {
  const tdb = new TenantDB(db, tenantId);

  // Get active documents for this vendor
  const docs = tdb.all<DocumentRow>(
    `SELECT d.id, d.doc_type, d.state
     FROM documents d
     WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
    [vendorId]
  );

  const bundle: ExtractionBundle = {};

  for (const doc of docs) {
    if (doc.doc_type !== 'coi' && doc.doc_type !== 'w9' && doc.doc_type !== 'ach') continue;

    // Get the latest extraction for this document
    const extraction = tdb.get<ExtractionRow>(
      `SELECT id, document_id, doc_type, payload_json, created_at
       FROM extractions
       WHERE tenant_id = ? AND document_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [doc.id]
    );

    if (!extraction) continue;

    const payload = JSON.parse(extraction.payload_json);
    if (doc.doc_type === 'coi') bundle.coi = payload as ProcessedCOIExtraction;
    else if (doc.doc_type === 'w9') bundle.w9 = payload as ProcessedW9Extraction;
    else if (doc.doc_type === 'ach') bundle.ach = payload as ProcessedACHExtraction;
  }

  return bundle;
}

// ── Full pipeline run ─────────────────────────────────────────────────────────

export interface RunResult {
  runId: string;
  recommendation: 'approve' | 'deficiencies' | 'uncertain';
  evaluationCount: number;
  advisoryCount: number;
}

export async function runVerification(
  db: Database.Database,
  input: {
    tenantId: string;
    vendorId: string;
    vendorTrade: string;
    trigger: VerificationTrigger;
    bundle?: ExtractionBundle;  // if not provided, loads from DB
  }
): Promise<RunResult> {
  const { tenantId, vendorId, vendorTrade, trigger } = input;
  const tdb = new TenantDB(db, tenantId);

  // Load bundle (extraction results) — from DB if not supplied directly
  const bundle = input.bundle ?? loadExtractionBundle(db, tenantId, vendorId);

  // Load vendor's assigned locations
  const vendorLocations = tdb.all<VendorLocation>(
    `SELECT id, location_id, status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ?`,
    [vendorId]
  );

  if (vendorLocations.length === 0) {
    // No locations assigned — run against empty matrix for the trigger
    vendorLocations.push({ id: 'none', location_id: 'none', status: 'onboarding' });
  }

  // Load precedence policy
  const settings = tdb.get<{ precedence_policy: string }>(
    'SELECT precedence_policy FROM requirement_settings WHERE tenant_id = ?'
  );
  const precedence = (settings?.precedence_policy as 'strictest' | 'location' | 'trade') ?? 'strictest';

  // Run rules engine for each location — collect all evaluations
  const allEvaluations: Array<{ locationId: string; evaluations: EvaluationResult[] }> = [];

  for (const vl of vendorLocations) {
    let matrix = {};
    if (vl.location_id !== 'none') {
      matrix = resolveRequirements(db, {
        tenantId,
        vendorTrade,
        locationId: vl.location_id,
        precedence,
      });
    }

    const result = runRulesEngine({ bundle, matrix, vendorTrade });
    allEvaluations.push({ locationId: vl.location_id, evaluations: result.evaluations });
  }

  // Flatten evaluations for recommendation roll-up
  const flatEvals = allEvaluations.flatMap((e) => e.evaluations);
  const recommendation = rollUp(flatEvals);

  // Generate advisories (full pipeline only)
  const advisories = trigger === 'rule_change' || trigger === 'location_add'
    ? []
    : generateAdvisories(bundle);

  // Write verification_run row
  const runId = randomUUID();
  tdb.insert('verification_runs', {
    id: runId,
    vendor_id: vendorId,
    trigger,
    engine_version: ENGINE_VERSION,
    recommendation,
    created_at: new Date().toISOString(),
  });

  // Write requirement_evaluations rows (one per requirement per location)
  for (const { locationId, evaluations } of allEvaluations) {
    for (const ev of evaluations) {
      if (ev.outcome === 'pass') continue; // only write non-pass evaluations
      tdb.insert('requirement_evaluations', {
        id: randomUUID(),
        run_id: runId,
        vendor_id: vendorId,
        location_id: locationId === 'none' ? vendorId : locationId, // fallback
        requirement_key: ev.requirementKey,
        required_value: ev.requiredValue,
        extracted_value_ref: ev.extractedValueRef,
        comparison_result: ev.comparisonResult,
        confidence_band: ev.confidenceBand,
        outcome: ev.outcome,
        note: ev.note,
      });
    }
  }

  // Write engine_advisories rows
  for (const adv of advisories) {
    tdb.insert('engine_advisories', {
      id: randomUUID(),
      vendor_id: vendorId,
      verification_run_id: runId,
      key: adv.key,
      severity: adv.severity,
      message: adv.message,
      evidence_json: JSON.stringify({ evidence: adv.evidence }),
      created_at: new Date().toISOString(),
    });
  }

  // Audit: ai.recommendation
  logAudit(db, {
    tenantId,
    actorType: 'ai',
    actorId: `engine/${ENGINE_VERSION}`,
    eventType: 'ai.recommendation',
    targetType: 'vendor',
    targetId: vendorId,
    payload: {
      run_id: runId,
      trigger,
      recommendation,
      evaluation_count: flatEvals.length,
      advisory_count: advisories.length,
      escalated: false,
    },
  });

  // Audit: ai.advisory for each advisory
  for (const adv of advisories) {
    logAudit(db, {
      tenantId,
      actorType: 'ai',
      actorId: `engine/${ENGINE_VERSION}`,
      eventType: 'ai.advisory',
      targetType: 'vendor',
      targetId: vendorId,
      payload: {
        run_id: runId,
        key: adv.key,
        severity: adv.severity,
        message: adv.message,
        // evidence is not sensitive; log it for traceability
        evidence: adv.evidence,
      },
    });
  }

  return {
    runId,
    recommendation,
    evaluationCount: flatEvals.length,
    advisoryCount: advisories.length,
  };
}

// ── Rules-only re-evaluation (trigger: rule_change or location_add) ───────────
// No Vision call. No advisory generation. Reads stored extractions only.

export async function runRulesOnlyReeval(
  db: Database.Database,
  input: {
    tenantId: string;
    vendorId: string;
    vendorTrade: string;
    trigger: 'rule_change' | 'location_add';
    locationId?: string;  // for location_add: only evaluate this location
  }
): Promise<RunResult> {
  return runVerification(db, {
    tenantId: input.tenantId,
    vendorId: input.vendorId,
    vendorTrade: input.vendorTrade,
    trigger: input.trigger,
  });
}
