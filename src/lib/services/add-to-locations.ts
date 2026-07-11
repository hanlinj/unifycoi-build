// Add-to-locations service — collect-once reuse within a tenant.
// Creates vendor_locations rows at status='under_review', then runs rules-only re-eval.

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { runRulesOnlyReeval, type RunResult } from '@/lib/verification/run';

export interface AddToLocationsInput {
  db: Db;
  tenantId: string;
  vendorId: string;
  actorUserId: string;
  locationIds: string[];
}

export interface AddToLocationsResult {
  vendorId: string;
  locationsAdded: string[];
  verificationRun: Pick<RunResult, 'runId' | 'recommendation'>;
}

export class AddToLocationsError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'BAD_LOCATION' | 'ALREADY_ASSOCIATED'
  ) {
    super(message);
  }
}

export async function addVendorToLocations(
  input: AddToLocationsInput
): Promise<AddToLocationsResult> {
  const { db, tenantId, vendorId, actorUserId, locationIds } = input;
  const tdb = new TenantDB(db, tenantId);
  const now = new Date();

  interface VendorRow { id: string; trade: string }
  const vendor = await tdb.get<VendorRow>(
    'SELECT id, trade FROM vendors WHERE tenant_id = $1 AND id = $2',
    [vendorId]
  );
  if (!vendor) throw new AddToLocationsError('Vendor not found', 'NOT_FOUND');

  const added: string[] = [];

  for (const locId of locationIds) {
    const loc = await tdb.get<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
      [locId]
    );
    if (!loc) throw new AddToLocationsError(`Location not found or not active: ${locId}`, 'BAD_LOCATION');

    const existing = await tdb.get<{ id: string }>(
      'SELECT id FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2 AND location_id = $3',
      [vendorId, locId]
    );
    if (existing) {
      throw new AddToLocationsError(`Vendor already associated with location: ${locId}`, 'ALREADY_ASSOCIATED');
    }

    await tdb.insert('vendor_locations', {
      id: randomUUID(),
      vendor_id: vendorId,
      location_id: locId,
      status: 'under_review',
      flags_json: null,
      approved_by: null,
      approved_at: null,
      created_at: now,
    });

    added.push(locId);
  }

  // Rules-only re-eval: reads stored extractions, no Vision call (invariant #7). Its own
  // multi-write (verification_runs/requirement_evaluations/engine_advisories/audit) is
  // atomic internally (runVerification's own withTransaction) — this function doesn't need
  // its own wrapping transaction beyond that, matching the original (pre-Stage-7) structure.
  const runResult = await runRulesOnlyReeval(db, {
    tenantId,
    vendorId,
    vendorTrade: vendor.trade,
    trigger: 'location_add',
  });

  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId: actorUserId,
    eventType: 'vendor.location_added',
    targetType: 'vendor',
    targetId: vendorId,
    payload: {
      location_ids: added,
      run_id: runResult.runId,
      recommendation: runResult.recommendation,
    },
  });

  return {
    vendorId,
    locationsAdded: added,
    verificationRun: { runId: runResult.runId, recommendation: runResult.recommendation },
  };
}
