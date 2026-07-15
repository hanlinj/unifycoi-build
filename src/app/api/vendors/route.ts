// GET /api/vendors
// Vendor list — Admin/District audience (Command Center's own audience; Store Managers keep
// /dashboard and get 403 here, not just a hidden nav entry).
//
// Scope-clamped identically to Command Center's stat cards: same resolveScope() clamp, same
// isDeclinedOnly() exclusion (imported from command-center.ts, not re-derived) — so the
// UNFILTERED list contains exactly the vendors "Total vendors" counts. Filters (?status=,
// ?location=, ?trade=, ?invitedBy= — src/lib/vendors/filters.ts) narrow within that same scoped,
// declined-excluded set; they can never widen it. No pagination yet (see the handoff note).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { isDeclinedOnly } from '@/lib/services/command-center';
import { deriveOverallStatus, type OverallStatus } from '@/lib/vendors/status';
import {
  STATUS_OPTIONS,
  TRADE_OPTIONS,
  evaluateFilter,
  filtersFromSearchParams,
  type FilterOption,
} from '@/lib/vendors/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VLocRow {
  vendor_id: string;
  location_id: string;
  status: string;
}

interface VendorRow {
  id: string;
  business_name: string;
  trade: string;
  created_at: string;
}

interface InviteRow {
  vendor_id: string;
  inviter_user_id: string;
  inviter_name: string | null;
  inviter_role: string;
}

interface UserLocRow {
  user_id: string;
  location_name: string;
}

interface LocationRow {
  id: string;
  name: string;
}

export interface VendorListRow {
  id: string;
  businessName: string;
  trade: string;
  primaryFacility: string;
  invitedBy: string;
  invitedAt: string;
  status: OverallStatus;
}

export interface VendorFilterOptions {
  status: FilterOption[];
  location: FilterOption[];
  trade: FilterOption[];
  invitedBy: FilterOption[];
}

export interface VendorsApiData {
  vendors: VendorListRow[];
  total: number;
  unfilteredTotal: number;
  filterOptions: VendorFilterOptions;
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  // Same audience as Command Center (admin/district-manager oversight); Store Manager keeps
  // /dashboard and has no reason to reach a portfolio-wide vendor list.
  if (auth.role !== 'admin' && auth.role !== 'district_manager') return forbidden();

  const db = getDb();
  const tenantId = auth.tenantId;
  const tdb = new TenantDB(db, tenantId);
  const scope = await resolveScope(db, tenantId, auth.sub, auth.role);
  const filters = filtersFromSearchParams(new URL(request.url).searchParams);

  const emptyOptions: VendorFilterOptions = { status: STATUS_OPTIONS, location: [], trade: TRADE_OPTIONS, invitedBy: [] };
  const empty = { vendors: [] as VendorListRow[], total: 0, unfilteredTotal: 0, filterOptions: emptyOptions };
  if (scope.locationIds !== null && scope.locationIds.length === 0) {
    return NextResponse.json({ data: empty });
  }

  const scoped = scope.locationIds !== null;
  const locParams = scoped ? scope.locationIds! : [];
  // tenant_id is $1 (TenantDB's contract); the location IN-list (if scoped) starts at $2 —
  // same scope-clause shape buildCommandCenter uses.
  const locPlaceholders = locParams.map((_, i) => `$${i + 2}`).join(', ');
  const locFilter = scoped ? ` AND vl.location_id IN (${locPlaceholders})` : '';

  // 1. Scoped vendor_locations (status AND location_id) — the same base aggregation Command
  // Center's totalVendorsInScope is built from, used here for the declined-only exclusion and
  // for both the Status and Location filter attributes' per-vendor match sets.
  const vlocs = await tdb.all<VLocRow>(
    `SELECT vl.vendor_id, vl.location_id, vl.status FROM vendor_locations vl WHERE vl.tenant_id = $1${locFilter}`,
    locParams
  );
  const statusesByVendor = new Map<string, string[]>();
  const locationIdsByVendor = new Map<string, string[]>();
  for (const r of vlocs) {
    const s = statusesByVendor.get(r.vendor_id);
    if (s) s.push(r.status); else statusesByVendor.set(r.vendor_id, [r.status]);
    const l = locationIdsByVendor.get(r.vendor_id);
    if (l) l.push(r.location_id); else locationIdsByVendor.set(r.vendor_id, [r.location_id]);
  }

  const inScopeVendorIds = [...statusesByVendor.keys()].filter(
    (id) => !isDeclinedOnly(statusesByVendor.get(id)!)
  );

  // Scoped, active locations — the Location filter's option list. Fetched even when zero
  // vendors are in scope: the option list is still meaningful (a district's facilities exist
  // whether or not a vendor happens to be assigned to one yet). A district manager sees only
  // their region's facilities (same query shape as facilitiesInScope in command-center.ts) —
  // independent of which locations vendors actually happen to be at, and independent of any
  // currently-applied filter (options are always the full scoped universe, never narrowed by
  // sibling filters — so picking one filter never makes another's options disappear).
  const locationRows = await tdb.all<LocationRow>(
    scoped
      ? `SELECT id, name FROM locations WHERE tenant_id = $1 AND status = 'active' AND id IN (${locPlaceholders}) ORDER BY name`
      : `SELECT id, name FROM locations WHERE tenant_id = $1 AND status = 'active' ORDER BY name`,
    locParams
  );
  const locationOptions: FilterOption[] = locationRows.map((l) => ({ value: l.id, label: l.name }));

  if (inScopeVendorIds.length === 0) {
    return NextResponse.json({
      data: { ...empty, filterOptions: { status: STATUS_OPTIONS, location: locationOptions, trade: TRADE_OPTIONS, invitedBy: [] } },
    });
  }

  // 2. Vendor identity.
  const vendorIdPlaceholders = inScopeVendorIds.map((_, i) => `$${i + 2}`).join(', ');
  const vendors = await tdb.all<VendorRow>(
    `SELECT id, business_name, trade, created_at
     FROM vendors WHERE tenant_id = $1 AND id IN (${vendorIdPlaceholders})
     ORDER BY business_name`,
    inScopeVendorIds
  );

  // 3. Original onboarding invite (never renewal/correction) -> inviter identity + role.
  // DISTINCT ON + ORDER BY created_at ASC is defensive determinism (createVendorInvite is the
  // ONLY code path that inserts a vendors row, and it mints exactly one purpose='onboarding'
  // invite atomically with it — this can never actually pick among two rows in practice).
  const invites = await tdb.all<InviteRow>(
    `SELECT DISTINCT ON (i.vendor_id) i.vendor_id, i.inviter_user_id,
            u.name AS inviter_name, u.role AS inviter_role
     FROM invites i
     JOIN users u ON u.id = i.inviter_user_id AND u.tenant_id = i.tenant_id
     WHERE i.tenant_id = $1 AND i.purpose = 'onboarding' AND i.vendor_id IN (${vendorIdPlaceholders})
     ORDER BY i.vendor_id, i.created_at ASC`,
    inScopeVendorIds
  );
  const inviteByVendor = new Map(invites.map((i) => [i.vendor_id, i]));

  // Invited-by filter options — the distinct inviters actually present among THIS scoped
  // vendor set, not a broader "all users in my region" query. This is deliberate: it can never
  // leak an out-of-scope user's existence (it's a strict subset of data this response already
  // returns per-row), and it never offers an option that's guaranteed to return zero results.
  const invitedByOptions: FilterOption[] = [
    ...new Map(invites.map((i) => [i.inviter_user_id, i.inviter_name ?? 'Unknown user'])),
  ].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));

  // 4. Inviter's CURRENT assigned locations — only matters for store_manager inviters (admin
  // is org-wide, district_manager is region-not-facility; both always render "Corporate").
  const storeManagerInviterIds = [
    ...new Set(invites.filter((i) => i.inviter_role === 'store_manager').map((i) => i.inviter_user_id)),
  ];
  const locNamesByUser = new Map<string, string[]>();
  if (storeManagerInviterIds.length > 0) {
    const userPlaceholders = storeManagerInviterIds.map((_, i) => `$${i + 2}`).join(', ');
    const userLocs = await tdb.all<UserLocRow>(
      `SELECT ul.user_id, l.name AS location_name
       FROM user_locations ul
       JOIN locations l ON l.id = ul.location_id AND l.tenant_id = ul.tenant_id
       WHERE ul.tenant_id = $1 AND ul.user_id IN (${userPlaceholders})`,
      storeManagerInviterIds
    );
    for (const r of userLocs) {
      const arr = locNamesByUser.get(r.user_id);
      if (arr) arr.push(r.location_name);
      else locNamesByUser.set(r.user_id, [r.location_name]);
    }
  }

  const rows: VendorListRow[] = vendors.map((v) => {
    const invite = inviteByVendor.get(v.id);
    // "Invited by" — never a raw UUID. u.name is NOT NULL and inviter_user_id is a required FK,
    // so this join can only miss on a genuinely orphaned row; 'Unknown user' matches the same
    // fallback decidedByName() already uses in /api/vendors/[id]/route.ts.
    const invitedBy = invite?.inviter_name ?? 'Unknown user';

    // Primary facility — three explicit, mutually exclusive cases. No default: each branch
    // assigns its own value so a future missed case fails loudly (undefined) instead of
    // silently inheriting a meaningful-looking one. 'Corporate' must only ever mean "the
    // inviter has no single facility" — never "we don't know".
    let primaryFacility: string;
    if (!invite) {
      primaryFacility = '—';
    } else if (invite.inviter_role === 'store_manager') {
      const locs = locNamesByUser.get(invite.inviter_user_id) ?? [];
      primaryFacility = locs.length === 1 ? locs[0] : 'Corporate';
    } else {
      primaryFacility = 'Corporate';
    }

    return {
      id: v.id,
      businessName: v.business_name,
      trade: v.trade,
      primaryFacility,
      invitedBy,
      invitedAt: v.created_at,
      status: deriveOverallStatus((statusesByVendor.get(v.id) ?? []).map((status) => ({ status }))),
    };
  });

  // Per-vendor match set for each filter attribute — Status/Location are per-location (a
  // vendor can have several), Trade/Invited by are vendor-level (wrapped as 0-or-1 element so
  // evaluateFilter's any-of/none-of logic is identical across all four).
  function matchSet(vendorId: string, attribute: string): string[] {
    switch (attribute) {
      case 'status': return statusesByVendor.get(vendorId) ?? [];
      case 'location': return locationIdsByVendor.get(vendorId) ?? [];
      case 'trade': {
        const v = vendors.find((x) => x.id === vendorId);
        return v ? [v.trade] : [];
      }
      case 'invitedBy': {
        const invite = inviteByVendor.get(vendorId);
        return invite ? [invite.inviter_user_id] : [];
      }
      default: return [];
    }
  }

  const filteredRows = filters.length === 0
    ? rows
    : rows.filter((r) => filters.every((f) => evaluateFilter(matchSet(r.id, f.attribute), f.operator, f.values)));

  const filterOptions: VendorFilterOptions = {
    status: STATUS_OPTIONS,
    location: locationOptions,
    trade: TRADE_OPTIONS,
    invitedBy: invitedByOptions,
  };

  const data: VendorsApiData = {
    vendors: filteredRows,
    total: filteredRows.length,
    unfilteredTotal: rows.length,
    filterOptions,
  };
  return NextResponse.json({ data });
}
