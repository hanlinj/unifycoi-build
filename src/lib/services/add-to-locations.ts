// Add-to-locations service — collect-once reuse within a tenant.
// Creates vendor_locations rows at status='under_review', then runs rules-only re-eval.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { runRulesOnlyReeval, type RunResult } from '@/lib/verification/run';

export interface AddToLocationsInput {
  db: Database.Database;
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
  const now = new Date().toISOString();

  interface VendorRow { id: string; trade: string }
  const vendor = tdb.get<VendorRow>(
    'SELECT id, trade FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  if (!vendor) throw new AddToLocationsError('Vendor not found', 'NOT_FOUND');

  const added: string[] = [];

  for (const locId of locationIds) {
    const loc = tdb.get<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = ? AND id = ? AND status = 'active'`,
      [locId]
    );
    if (!loc) throw new AddToLocationsError(`Location not found or not active: ${locId}`, 'BAD_LOCATION');

    const existing = tdb.get<{ id: string }>(
      'SELECT id FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendorId, locId]
    );
    if (existing) {
      throw new AddToLocationsError(`Vendor already associated with location: ${locId}`, 'ALREADY_ASSOCIATED');
    }

    tdb.insert('vendor_locations', {
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

  // Rules-only re-eval: reads stored extractions, no Vision call (invariant #7)
  const runResult = await runRulesOnlyReeval(db, {
    tenantId,
    vendorId,
    vendorTrade: vendor.trade,
    trigger: 'location_add',
  });

  logAudit(db, {
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
