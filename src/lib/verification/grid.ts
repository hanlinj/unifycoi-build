// Compliance grid — a READ-TIME recompute for display only. Does not write anything, does not
// change what the verification worker persists (requirement_evaluations keeps holding only the
// point-in-time exceptions record — untouched). Reuses the exact same pure functions the
// worker/rules-only re-eval path already use (loadExtractionBundle, resolveRequirements,
// runRulesEngine) — no Vision call, same inputs always yield the same outputs, so this is safe
// to recompute on every profile view.
//
// Why recompute instead of reading requirement_evaluations: run.ts deliberately discards
// 'pass' evaluations before writing (only exceptions are persisted — see run.ts's own comment
// at the insert loop). The engine itself always returns every evaluation, including passes;
// this module just doesn't throw them away.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { resolveRequirements, type Precedence } from '@/lib/requirements/resolver';
import { runRulesEngine, type ComparisonResult } from './engine';
import { loadExtractionBundle } from './run';

export type GridStatus = 'green' | 'red';

export interface GridRow {
  requirementKey: string;
  requiredValue: string | null;
  extractedValue: string | null;
  comparisonResult: ComparisonResult | 'not_evaluated';
  status: GridStatus;
  note: string | null;
}

export interface LocationGrid {
  locationId: string;
  locationName: string;
  rows: GridRow[];
}

export interface ComplianceGrid {
  locations: LocationGrid[];
  countMeets: number;
  countBelowOrMissing: number;
}

// Mirrors engine.ts's own key-pattern recognizers (parseCoverageKey, parseCoverageRequiredKey,
// parseEndorsementKey, the doc_required./certificate_holder/entity_type checks) — this display
// module duplicates the narrow pattern check rather than exporting engine.ts's internals, so
// the worker's/decision path's import graph stays untouched. Keep in sync if engine.ts ever
// adds a new requirement-key shape.
function isRecognizedRequirementKey(key: string): boolean {
  if (/^coverage\.[^.]+\..+$/.test(key)) return true;
  if (/^coverage_required\..+$/.test(key)) return true;
  if (/^endorsement\..+$/.test(key)) return true;
  if (key.startsWith('doc_required.')) return true;
  if (key === 'certificate_holder' || key === 'entity_type') return true;
  return false;
}

// The engine renames certificate_holder's evaluation to certificate_holder_match — map that
// explicitly so it isn't mistaken for an unevaluated key.
const REQUIREMENT_KEY_RENAMES: Record<string, string> = {
  certificate_holder: 'certificate_holder_match',
};

function statusFor(cr: ComparisonResult | 'not_evaluated'): GridStatus {
  return cr === 'meets' ? 'green' : 'red';
}

export async function computeComplianceGrid(
  db: Db,
  tenantId: string,
  vendorId: string,
  vendorTrade: string,
  locations: { location_id: string; location_name: string }[]
): Promise<ComplianceGrid> {
  const tdb = new TenantDB(db, tenantId);
  const bundle = await loadExtractionBundle(db, tenantId, vendorId);

  const settings = await tdb.get<{ precedence_policy: string }>(
    'SELECT precedence_policy FROM requirement_settings WHERE tenant_id = $1'
  );
  const precedence = (settings?.precedence_policy as Precedence) ?? 'strictest';

  const locationGrids: LocationGrid[] = [];
  let countMeets = 0;
  let countBelowOrMissing = 0;

  for (const loc of locations) {
    const matrix = await resolveRequirements(db, {
      tenantId,
      vendorTrade,
      locationId: loc.location_id,
      precedence,
    });

    const { evaluations } = runRulesEngine({ bundle, matrix, vendorTrade });
    const evaluatedKeys = new Set(evaluations.map((e) => e.requirementKey));

    const rows: GridRow[] = [];

    // Matrix keys the engine never produced a row for: recognized-but-not-applicable (e.g. the
    // operator set required=false, or a coverage_required companion already covers the gap) is
    // silent by design — no row. Unrecognized key shapes get an explicit row instead of vanishing.
    for (const [key, entry] of Object.entries(matrix)) {
      const outputKey = REQUIREMENT_KEY_RENAMES[key] ?? key;
      if (evaluatedKeys.has(outputKey)) continue;
      if (!isRecognizedRequirementKey(key)) {
        rows.push({
          requirementKey: key,
          requiredValue: entry.required_value,
          extractedValue: null,
          comparisonResult: 'not_evaluated',
          status: 'red',
          note: 'Not evaluated — unrecognized requirement key',
        });
      }
    }

    for (const ev of evaluations) {
      rows.push({
        requirementKey: ev.requirementKey,
        requiredValue: ev.requiredValue,
        extractedValue: ev.extractedValueRef,
        comparisonResult: ev.comparisonResult,
        status: statusFor(ev.comparisonResult),
        note: ev.note,
      });
    }

    for (const r of rows) {
      if (r.status === 'green') countMeets++;
      else countBelowOrMissing++;
    }

    locationGrids.push({ locationId: loc.location_id, locationName: loc.location_name, rows });
  }

  return { locations: locationGrids, countMeets, countBelowOrMissing };
}
