// Shared renewal/expiration chase queries.
//
// The COI expiration date is not persisted on a row — it lives in the Phase 7 renewal
// notification payloads (expiration_date + scheduled_for), maintained by supersession
// (canceled on renewal). This module is the SINGLE definition of "the chase rows for a
// vendor," consumed by both the Command Center taxonomy (Slice A) and the day-0 expired
// flip worker (Slice E), so the two never drift.

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';

// Payload `type` values that represent an active chase against a COI. 'renewal_reminder'
// is the Phase 7 ladder; 'coi_expiration' is the Slice E day-0 flip job (added here now so
// both slices share one definition even before Slice E lands).
export const CHASE_PAYLOAD_TYPES = ['renewal_reminder', 'coi_expiration'] as const;

const TYPE_LIST = CHASE_PAYLOAD_TYPES.map((t) => `'${t}'`).join(', ');

export interface ChaseRow {
  id: string;
  vendor_id: string | null;
  document_id: string | null;
  scheduled_for: string | null;
  expiration_date: string | null;
  days_before: number | null;
  payload_type: string;
}

/**
 * The unfired (status='queued') chase rows for one vendor. Used by Slice E to target the
 * day-0 flip, and available for per-vendor expiry lookups.
 */
export function findChaseRows(
  db: Database.Database,
  tenantId: string,
  vendorId: string
): ChaseRow[] {
  const tdb = new TenantDB(db, tenantId);
  return tdb.all<ChaseRow>(
    `SELECT id,
            json_extract(payload_json,'$.vendor_id')       AS vendor_id,
            document_id,
            scheduled_for,
            json_extract(payload_json,'$.expiration_date')  AS expiration_date,
            json_extract(payload_json,'$.days_before')      AS days_before,
            json_extract(payload_json,'$.type')             AS payload_type
     FROM notifications
     WHERE tenant_id = ? AND status = 'queued'
       AND json_extract(payload_json,'$.type') IN (${TYPE_LIST})
       AND json_extract(payload_json,'$.vendor_id') = ?
     ORDER BY scheduled_for`,
    [vendorId]
  );
}

/** The vendor's current COI expiration = earliest expiration_date among its queued chase rows. */
export function vendorExpiry(db: Database.Database, tenantId: string, vendorId: string): string | null {
  const rows = findChaseRows(db, tenantId, vendorId);
  let earliest: string | null = null;
  for (const r of rows) {
    if (r.expiration_date && (earliest === null || r.expiration_date < earliest)) {
      earliest = r.expiration_date;
    }
  }
  return earliest;
}

/**
 * Tenant-wide map of vendor_id → earliest queued chase expiration. One query for the whole
 * Command Center (vs N per-vendor lookups). MIN over ISO date strings is a correct
 * chronological min.
 */
export function chaseExpiryByVendor(db: Database.Database, tenantId: string): Map<string, string> {
  const tdb = new TenantDB(db, tenantId);
  const rows = tdb.all<{ vendor_id: string | null; exp: string | null }>(
    `SELECT json_extract(payload_json,'$.vendor_id')             AS vendor_id,
            MIN(json_extract(payload_json,'$.expiration_date'))  AS exp
     FROM notifications
     WHERE tenant_id = ? AND status = 'queued'
       AND json_extract(payload_json,'$.type') IN (${TYPE_LIST})
     GROUP BY json_extract(payload_json,'$.vendor_id')`
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.vendor_id && r.exp) map.set(r.vendor_id, r.exp);
  }
  return map;
}
