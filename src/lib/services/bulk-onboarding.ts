// Bulk store + manager creation (Slice 12/5b, Feature 1) — the "submit" side of the editable
// import table. Deliberately separate from the Phase-2 bulkImportLocations/parseImportCSV in
// locations.ts: that function is CSV-text-in/creates-in-one-shot behind a preview-and-approve
// gate (the old Bulk_Location_Import.md flow), left untouched. This is fresh code for the new
// editable-form UX (see the ADR in docs/decisions.md) — rows arrive already validated by the
// caller (src/lib/import/location-rows.ts) via manual typing, a file upload, or both.
//
// Reused from two call sites: provisionTenant's transaction (brand-new tenant, platform actor)
// and the tenant-Admin bulk-add-locations screen (existing tenant, Admin actor). Both need the
// identical dedupe-by-email + dormant-manager + billing-snapshot behavior, so it lives once.

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { withTransaction } from '@/lib/db/transaction';
import { logAudit } from '@/lib/audit';
import { createLocation } from './locations';
import type { ImportLocationRow } from '@/lib/import/location-rows';

export interface BulkOnboardingResult {
  locationIds: string[];
  managerUserIds: string[];
  managersCreated: number;
  managersReused: number;
}

/**
 * Create one location per row, plus a dormant manager (status='invited', no password, no
 * notification queued — Send/Resend invite happens later from the Users panel, Feature 2) per
 * unique manager email. The same email on multiple rows consolidates to one manager linked to
 * every one of those locations — never a duplicate user. An existing tenant user with that email
 * (any role) is reused as-is, not recreated. Wrapped in withTransaction() (never opened
 * directly, see src/lib/db/transaction.ts) — safe to call from inside provisionTenant's outer
 * transaction too, since withTransaction takes a SAVEPOINT when already nested.
 */
export async function bulkCreateLocationsWithManagers(
  db: Db,
  tenantId: string,
  rows: ImportLocationRow[],
  actorId: string
): Promise<BulkOnboardingResult> {
  return withTransaction(db, async (trx): Promise<BulkOnboardingResult> => {
    const tdb = new TenantDB(trx, tenantId);
    const locationIds: string[] = [];
    const managerUserIdByEmail = new Map<string, string>();
    const managerUserIds: string[] = [];
    let managersCreated = 0;
    let managersReused = 0;

    for (const row of rows) {
      const location = await createLocation(trx, tenantId, { name: row.storeName.trim(), address: row.address.trim() || undefined }, actorId);
      locationIds.push(location.id);

      const email = row.managerEmail.trim().toLowerCase();
      if (!email) continue;

      let managerId = managerUserIdByEmail.get(email);
      if (!managerId) {
        // COLLATE NOCASE -> lower() (Stage 0's catalogued rework spot)
        const existing = await tdb.get<{ id: string }>('SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)', [email]);
        if (existing) {
          managerId = existing.id;
          managersReused++;
        } else {
          managerId = randomUUID();
          const name = [row.managerFirstName.trim(), row.managerLastName.trim()].filter(Boolean).join(' ') || email;
          await tdb.insert('users', {
            id: managerId,
            email,
            name,
            role: 'store_manager',
            password_hash: null,
            status: 'invited',
            created_at: new Date(),
          });
          managersCreated++;
        }
        managerUserIdByEmail.set(email, managerId);
        managerUserIds.push(managerId);
      }

      await tdb.insert('user_locations', { user_id: managerId, location_id: location.id }, { orIgnore: true });
    }

    if (locationIds.length > 0) {
      await logAudit(trx, {
        tenantId,
        actorType: 'user',
        actorId,
        eventType: 'locations.bulk_imported',
        payload: { created: locationIds.length, managers_created: managersCreated, managers_reused: managersReused },
      });
    }

    return { locationIds, managerUserIds, managersCreated, managersReused };
  });
}
