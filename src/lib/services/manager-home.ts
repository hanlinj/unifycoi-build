// Manager Home Dashboard — the operational "who can I hire right now?" surface (Slice B).
//
// Approved vendors in the viewer's scope, at ACTIVE locations, grouped by trade, with each
// vendor's next COI expiration (from the chase schedule) and a <30-day urgency flag. Trade
// facet filter + name search (simple matcher). Scope-clamped server-side.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { chaseExpiryByVendor } from '@/lib/notifications/chase';
import { simpleVendorNameMatcher, type VendorNameMatcher } from '@/lib/search/vendor-name';

const DAY_MS = 24 * 60 * 60 * 1000;
const URGENCY_DAYS = 30; // expiring within 30 days → highlighted

export interface ApprovedVendorRow {
  vendorId: string;
  name: string;
  trade: string;
  locations: { id: string; name: string }[]; // in-scope active locations this vendor is approved at
  expiresAt: string | null;
  daysToExpiry: number | null;
  expiringSoon: boolean; // <= URGENCY_DAYS
}

export interface ManagerHomeResult {
  groups: { trade: string; vendors: ApprovedVendorRow[] }[];
  trades: string[];               // all trades present among in-scope approved vendors (for filter chips)
  totalApproved: number;          // count after filters
  facilitiesInScope: number;
  activeFilters: { trade: string | null; q: string | null };
}

export interface ManagerHomeScope {
  locationIds: string[] | null; // null = org-wide
}

interface Row { vendor_id: string; business_name: string; trade: string; location_id: string; location_name: string }

export async function buildManagerHome(
  db: Db,
  tenantId: string,
  scope: ManagerHomeScope,
  filters: { trade?: string | null; q?: string | null } = {},
  nowMs: number = Date.now(),
  matcher: VendorNameMatcher = simpleVendorNameMatcher
): Promise<ManagerHomeResult> {
  const empty: ManagerHomeResult = {
    groups: [], trades: [], totalApproved: 0, facilitiesInScope: 0,
    activeFilters: { trade: filters.trade ?? null, q: filters.q ?? null },
  };
  if (scope.locationIds !== null && scope.locationIds.length === 0) return empty;

  const tdb = new TenantDB(db, tenantId);
  const scoped = scope.locationIds !== null;
  const locParams = scoped ? scope.locationIds! : [];
  // tenant_id is bound as $1 (TenantDB's contract); the IN-list starts at $2.
  const locPlaceholders = locParams.map((_, i) => `$${i + 2}`).join(', ');
  const locFilter = scoped ? ` AND vl.location_id IN (${locPlaceholders})` : '';

  // COUNT(*) returns as a string (Postgres bigint precision safety) — cast before using as a number.
  const facilitiesInScope = scoped
    ? Number(
        (await tdb.get<{ n: string }>(
          `SELECT COUNT(*) AS n FROM locations WHERE tenant_id = $1 AND status = 'active' AND id IN (${locPlaceholders})`,
          locParams
        ))!.n
      )
    : Number((await tdb.get<{ n: string }>(`SELECT COUNT(*) AS n FROM locations WHERE tenant_id = $1 AND status = 'active'`))!.n);

  // Approved vendor-locations at ACTIVE locations only (archived locations aren't hireable).
  const rows = await tdb.all<Row>(
    `SELECT vl.vendor_id, v.business_name, v.trade, vl.location_id, l.name AS location_name
     FROM vendor_locations vl
     JOIN vendors v   ON v.id = vl.vendor_id   AND v.tenant_id = vl.tenant_id
     JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
     WHERE vl.tenant_id = $1 AND vl.status = 'approved' AND l.status = 'active'${locFilter}`,
    locParams
  );
  if (rows.length === 0) return { ...empty, facilitiesInScope };

  const expiryMap = await chaseExpiryByVendor(db, tenantId);

  // Aggregate to one row per vendor.
  const byVendor = new Map<string, ApprovedVendorRow>();
  for (const r of rows) {
    let v = byVendor.get(r.vendor_id);
    if (!v) {
      const expiresAt = expiryMap.get(r.vendor_id) ?? null;
      const daysToExpiry = expiresAt ? Math.floor((Date.parse(expiresAt) - nowMs) / DAY_MS) : null;
      v = {
        vendorId: r.vendor_id, name: r.business_name, trade: r.trade, locations: [],
        expiresAt, daysToExpiry,
        expiringSoon: daysToExpiry !== null && daysToExpiry <= URGENCY_DAYS,
      };
      byVendor.set(r.vendor_id, v);
    }
    if (!v.locations.some((l) => l.id === r.location_id)) v.locations.push({ id: r.location_id, name: r.location_name });
  }

  const allVendors = [...byVendor.values()];
  const trades = [...new Set(allVendors.map((v) => v.trade))].sort();

  // Apply filters.
  const tradeFilter = filters.trade?.trim() || null;
  const q = filters.q?.trim() || null;
  let filtered = allVendors;
  if (tradeFilter) filtered = filtered.filter((v) => v.trade === tradeFilter);
  if (q) filtered = filtered.filter((v) => matcher.matches(v.name, q));

  // Group by trade, alpha within group, urgent vendors first inside a trade.
  const groupMap = new Map<string, ApprovedVendorRow[]>();
  for (const v of filtered) {
    const g = groupMap.get(v.trade) ?? [];
    g.push(v);
    groupMap.set(v.trade, g);
  }
  const groups = [...groupMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([trade, vendors]) => ({
      trade,
      vendors: vendors.sort((a, b) =>
        a.expiringSoon === b.expiringSoon ? a.name.localeCompare(b.name) : a.expiringSoon ? -1 : 1
      ),
    }));

  return {
    groups,
    trades,
    totalApproved: filtered.length,
    facilitiesInScope,
    activeFilters: { trade: tradeFilter, q },
  };
}
