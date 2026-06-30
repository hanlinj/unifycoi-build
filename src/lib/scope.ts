// Resolves what a user can see / act on, given their role.
// Admin = null (all). District = their region's locations. Store = their assigned locations.
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';

export interface Scope {
  locationIds: string[] | null; // null = admin (all)
  regionIds: string[] | null;   // null = admin (all)
}

export function resolveScope(
  db: Database.Database,
  tenantId: string,
  userId: string,
  role: string
): Scope {
  if (role === 'admin') {
    return { locationIds: null, regionIds: null };
  }

  const tdb = new TenantDB(db, tenantId);

  if (role === 'district_manager') {
    const regionRows = tdb.all<{ region_id: string }>(
      'SELECT region_id FROM user_regions WHERE tenant_id = ? AND user_id = ?',
      [userId]
    );
    const regionIds = regionRows.map((r) => r.region_id);

    if (regionIds.length === 0) return { locationIds: [], regionIds: [] };

    const locRows = tdb.all<{ id: string }>(
      `SELECT DISTINCT l.id
       FROM locations l
       JOIN user_regions ur ON ur.region_id = l.region_id AND ur.tenant_id = l.tenant_id
       WHERE l.tenant_id = ? AND ur.user_id = ?`,
      [userId]
    );

    return { locationIds: locRows.map((r) => r.id), regionIds };
  }

  // store_manager
  const locRows = tdb.all<{ location_id: string }>(
    'SELECT location_id FROM user_locations WHERE tenant_id = ? AND user_id = ?',
    [userId]
  );
  return { locationIds: locRows.map((r) => r.location_id), regionIds: null };
}

export function scopeIncludesLocation(scope: Scope, locationId: string): boolean {
  return scope.locationIds === null || scope.locationIds.includes(locationId);
}

export function scopeIncludesRegion(scope: Scope, regionId: string): boolean {
  return scope.regionIds === null || scope.regionIds.includes(regionId);
}

export interface UserManageCheck {
  exists: boolean;
  inScope: boolean;
}

/**
 * Can a caller with `callerScope` manage (PATCH / invite) the target user? Within-tenant
 * authorization for user management (Regional_District_View.md: District manages users
 * region-scoped).
 *
 * Rules:
 *  - Admin caller (regionIds === null, org-wide) → manages anyone in the tenant.
 *  - A non-Admin (District) caller can NEVER manage an Admin (org-wide, unbounded scope).
 *  - Otherwise the target's region set must be fully contained within the caller's regions
 *    (⊆). Partial overlap or disjoint → out of scope. An unassigned target (no regions) is
 *    out of scope. (Containment satisfies "fully within their scope"; partial overlap fails.)
 *
 * Returns {exists} so the caller can keep the response uniform (404 for both
 * not-found and out-of-scope) while logging a scope violation only when a real record was
 * targeted.
 */
export function userManageableByScope(
  db: Database.Database,
  tenantId: string,
  callerScope: Scope,
  targetUserId: string
): UserManageCheck {
  const tdb = new TenantDB(db, tenantId);
  const target = tdb.get<{ role: string }>(
    'SELECT role FROM users WHERE tenant_id = ? AND id = ?',
    [targetUserId]
  );
  if (!target) return { exists: false, inScope: false };

  // Admin caller — org-wide.
  if (callerScope.regionIds === null) return { exists: true, inScope: true };

  // A District can never manage an Admin.
  if (target.role === 'admin') return { exists: true, inScope: false };

  let targetRegions: string[];
  if (target.role === 'district_manager') {
    targetRegions = tdb
      .all<{ region_id: string }>('SELECT region_id FROM user_regions WHERE tenant_id = ? AND user_id = ?', [targetUserId])
      .map((r) => r.region_id);
  } else {
    // store_manager: the regions of their assigned locations
    targetRegions = tdb
      .all<{ region_id: string }>(
        `SELECT DISTINCT l.region_id
         FROM user_locations ul
         JOIN locations l ON l.id = ul.location_id AND l.tenant_id = ul.tenant_id
         WHERE ul.tenant_id = ? AND ul.user_id = ? AND l.region_id IS NOT NULL`,
        [targetUserId]
      )
      .map((r) => r.region_id);
  }

  const callerRegions = new Set(callerScope.regionIds);
  const inScope = targetRegions.length > 0 && targetRegions.every((r) => callerRegions.has(r));
  return { exists: true, inScope };
}
