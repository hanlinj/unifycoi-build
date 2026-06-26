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
