// Location Record — the single-store compliance view (Slice D).
//
// Read-only summary: identity + the vendors at this location with their PER-LOCATION status,
// trade, last approval, and next COI expiration (from the chase schedule). Facet filters by
// status + trade. Access is gated by the caller's scope at the route layer (a non-Admin must
// have this location in scope); within a single in-scope location there is no further row
// clamp — every vendor at that location is in the caller's scope.

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { getLocationById, type LocationWithRegion } from '@/lib/services/locations';
import { chaseExpiryByVendor } from '@/lib/notifications/chase';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LocationVendorRow {
  vendorId: string;
  name: string;
  trade: string;
  status: string;
  approvedAt: string | null;
  expiresAt: string | null;
  daysToExpiry: number | null;
}

export interface LocationRecordResult {
  location: { id: string; name: string; address: string | null; region_name: string | null; status: string };
  vendors: LocationVendorRow[];
  trades: string[];
  statuses: string[];
  activeFilters: { status: string | null; trade: string | null };
}

export function buildLocationRecord(
  db: Database.Database,
  tenantId: string,
  locationId: string,
  filters: { status?: string | null; trade?: string | null } = {},
  nowMs: number = Date.now()
): LocationRecordResult | null {
  const loc = getLocationById(db, tenantId, locationId) as LocationWithRegion | null;
  if (!loc) return null;

  const tdb = new TenantDB(db, tenantId);
  const rows = tdb.all<{ vendor_id: string; business_name: string; trade: string; status: string; approved_at: string | null }>(
    `SELECT vl.vendor_id, v.business_name, v.trade, vl.status, vl.approved_at
     FROM vendor_locations vl
     JOIN vendors v ON v.id = vl.vendor_id AND v.tenant_id = vl.tenant_id
     WHERE vl.tenant_id = ? AND vl.location_id = ?
     ORDER BY v.business_name`,
    [locationId]
  );

  const expiryMap = chaseExpiryByVendor(db, tenantId);

  const all: LocationVendorRow[] = rows.map((r) => {
    const expiresAt = expiryMap.get(r.vendor_id) ?? null;
    const daysToExpiry = expiresAt ? Math.floor((Date.parse(expiresAt) - nowMs) / DAY_MS) : null;
    return { vendorId: r.vendor_id, name: r.business_name, trade: r.trade, status: r.status, approvedAt: r.approved_at, expiresAt, daysToExpiry };
  });

  const trades = [...new Set(all.map((v) => v.trade))].sort();
  const statuses = [...new Set(all.map((v) => v.status))].sort();

  const statusFilter = filters.status?.trim() || null;
  const tradeFilter = filters.trade?.trim() || null;
  let vendors = all;
  if (statusFilter) vendors = vendors.filter((v) => v.status === statusFilter);
  if (tradeFilter) vendors = vendors.filter((v) => v.trade === tradeFilter);

  return {
    location: { id: loc.id, name: loc.name, address: loc.address, region_name: loc.region_name, status: loc.status },
    vendors,
    trades,
    statuses,
    activeFilters: { status: statusFilter, trade: tradeFilter },
  };
}
