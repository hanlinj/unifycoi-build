// GET /api/vendors
// Vendor list — Admin/District audience (Command Center's own audience; Store Managers keep
// /dashboard and get 403 here, not just a hidden nav entry).
//
// Scope-clamped identically to Command Center's stat cards: same resolveScope() clamp, same
// isDeclinedOnly() exclusion (imported from command-center.ts, not re-derived) — so this list
// contains exactly the vendors "Total vendors" counts. No filters, no pagination (out of scope
// for this slice — see the handoff note).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { isDeclinedOnly } from '@/lib/services/command-center';
import { deriveOverallStatus, type OverallStatus } from '@/lib/vendors/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VLocRow {
  vendor_id: string;
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

export interface VendorListRow {
  id: string;
  businessName: string;
  trade: string;
  primaryFacility: string;
  invitedBy: string;
  invitedAt: string;
  status: OverallStatus;
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

  const empty = { vendors: [] as VendorListRow[], total: 0 };
  if (scope.locationIds !== null && scope.locationIds.length === 0) {
    return NextResponse.json({ data: empty });
  }

  const scoped = scope.locationIds !== null;
  const locParams = scoped ? scope.locationIds! : [];
  // tenant_id is $1 (TenantDB's contract); the location IN-list (if scoped) starts at $2 —
  // same scope-clause shape buildCommandCenter uses.
  const locPlaceholders = locParams.map((_, i) => `$${i + 2}`).join(', ');
  const locFilter = scoped ? ` AND vl.location_id IN (${locPlaceholders})` : '';

  // 1. Scoped vendor_locations statuses — the same base aggregation Command Center's
  // totalVendorsInScope is built from, used here for both the declined-only exclusion and the
  // per-vendor status derivation.
  const vlocs = await tdb.all<VLocRow>(
    `SELECT vl.vendor_id, vl.status FROM vendor_locations vl WHERE vl.tenant_id = $1${locFilter}`,
    locParams
  );
  const statusesByVendor = new Map<string, string[]>();
  for (const r of vlocs) {
    const arr = statusesByVendor.get(r.vendor_id);
    if (arr) arr.push(r.status);
    else statusesByVendor.set(r.vendor_id, [r.status]);
  }

  const inScopeVendorIds = [...statusesByVendor.keys()].filter(
    (id) => !isDeclinedOnly(statusesByVendor.get(id)!)
  );
  if (inScopeVendorIds.length === 0) {
    return NextResponse.json({ data: empty });
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
    // inviter has no single facility" — never "we don't know" (that was the bug: this used to
    // start at 'Corporate' and only get overwritten inside the store_manager branch, so a
    // vendor with no invite on record rendered identically to a real admin/district invite).
    let primaryFacility: string;
    if (!invite) {
      // No invite on record at all — unknown, not a classification.
      primaryFacility = '—';
    } else if (invite.inviter_role === 'store_manager') {
      const locs = locNamesByUser.get(invite.inviter_user_id) ?? [];
      // Exactly one assigned location -> that facility; zero or multiple -> no single facility.
      primaryFacility = locs.length === 1 ? locs[0] : 'Corporate';
    } else {
      // admin or district_manager — org-wide / region-scoped, never a single facility.
      primaryFacility = 'Corporate';
    }

    const statuses = statusesByVendor.get(v.id) ?? [];
    return {
      id: v.id,
      businessName: v.business_name,
      trade: v.trade,
      primaryFacility,
      invitedBy,
      invitedAt: v.created_at,
      status: deriveOverallStatus(statuses.map((status) => ({ status }))),
    };
  });

  return NextResponse.json({ data: { vendors: rows, total: rows.length } });
}
