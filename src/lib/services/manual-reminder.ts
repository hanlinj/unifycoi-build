// Send a renewal reminder to a specific vendor on demand (Location Record action), bypassing
// the daily digest. Reuses the Phase 7 notification queue. Admin-only is enforced at the route.

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { queueNotification } from '@/lib/notifications/queue';
import { vendorExpiry } from '@/lib/notifications/chase';
import { logAudit } from '@/lib/audit';

export class ManualReminderError extends Error {
  constructor(message: string, public readonly code: 'NOT_AT_LOCATION' | 'NO_EMAIL') {
    super(message);
  }
}

/**
 * Queue an immediate (exception-tier) renewal reminder for `vendorId`, scoped to the store the
 * Admin is looking at. Requires the vendor to actually be associated with `locationId`.
 */
export function sendManualRenewalReminder(
  db: Database.Database,
  tenantId: string,
  locationId: string,
  vendorId: string,
  actorUserId: string
): { notificationId: string } {
  const tdb = new TenantDB(db, tenantId);

  const vl = tdb.get<{ id: string }>(
    'SELECT id FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
    [vendorId, locationId]
  );
  if (!vl) throw new ManualReminderError('Vendor is not associated with this location', 'NOT_AT_LOCATION');

  const vendor = tdb.get<{ business_name: string; contact_email: string | null }>(
    'SELECT business_name, contact_email FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  if (!vendor?.contact_email) throw new ManualReminderError('Vendor has no contact email', 'NO_EMAIL');

  const expiresAt = vendorExpiry(db, tenantId, vendorId);

  const notificationId = queueNotification(db, tenantId, {
    recipientType: 'vendor',
    recipientRef: vendor.contact_email,
    kind: 'exception', // immediate — explicitly bypasses the digest
    payload: {
      type: 'renewal_reminder',
      vendor_id: vendorId,
      vendor_name: vendor.business_name,
      location_id: locationId,
      expiration_date: expiresAt,
      manual: true,
    },
  });

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId: actorUserId,
    eventType: 'vendor.renewal_reminder_sent',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { location_id: locationId, manual: true },
  });

  return { notificationId };
}
