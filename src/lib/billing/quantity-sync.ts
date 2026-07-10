// Location-count → Stripe subscription quantity sync (Slice 5a, ADR-012-05).
//
// Why this is a separate poller and not inline in createLocation/updateLocation: those
// functions run (in the provisioning path) INSIDE provisionTenant's db.transaction() callback,
// and better-sqlite3 requires that callback to be fully synchronous — it throws
// `TypeError('Transaction function cannot return a promise')` if it isn't (confirmed straight
// from node_modules/better-sqlite3/lib/methods/transaction.js). A Stripe network call cannot
// live inside that callback. So instead: createLocation/updateLocation/bulkImportLocations
// keep doing exactly what they already did (an unconditional/conditional write to
// billing_snapshots via recordBillingSnapshot, unchanged) — that write IS the trigger this
// worker polls for. Same "commit synchronously, push to the external system afterward on a
// separate cadence" shape as attachBilling's DB/Stripe boundary, just recurring instead of
// one-shot.
//
// Quantity, not delta: a snapshot row is a point-in-time billable_locations count, not an
// increment. Only the LATEST unsynced row per tenant needs a Stripe call — any earlier unsynced
// row for the same tenant is a superseded intermediate value and is marked synced without its
// own API call.

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';
import type { BillingProvider } from './provider';

export interface QuantitySyncResult {
  synced: number;
  failed: number;
}

interface UnsyncedSnapshot {
  tenant_id: string;
  billable_locations: number;
  stripe_subscription_id: string;
}

/**
 * Push any billing_snapshots quantity change not yet reflected on the tenant's live Stripe
 * subscription. Only tenants that already HAVE a subscription are eligible — pre-activation
 * snapshot rows are marked synced by attachBilling itself (its subscription's initial quantity
 * already accounts for them), so this never fires before a tenant has gone live.
 *
 * Stripe-side proration is OFF (see StripeBillingProvider.updateSubscriptionQuantity) — the new
 * quantity takes effect at the tenant's NEXT billing cycle, never a mid-month partial charge.
 */
export async function syncBillingQuantities(
  db: Database.Database,
  billing: BillingProvider,
  now: Date = new Date()
): Promise<QuantitySyncResult> {
  // Ordered by rowid, not created_at: multiple snapshot rows for a tenant can land in the same
  // millisecond, and ISO-string created_at ties resolve arbitrarily — rowid is a reliable,
  // monotonically-increasing insertion-order tiebreaker (see provisioning.ts's attachBilling
  // for the same fix).
  const rows = db
    .prepare(
      `SELECT bs.tenant_id, bs.billable_locations, t.stripe_subscription_id
       FROM billing_snapshots bs
       JOIN tenants t ON t.id = bs.tenant_id
       WHERE bs.changed = 1 AND bs.stripe_synced_at IS NULL AND t.stripe_subscription_id IS NOT NULL
       ORDER BY bs.rowid ASC`
    )
    .all() as UnsyncedSnapshot[];

  // Collapse to the latest row per tenant (rows are ASC, so a later Map.set wins).
  const latestByTenant = new Map<string, UnsyncedSnapshot>();
  for (const row of rows) latestByTenant.set(row.tenant_id, row);

  let synced = 0;
  let failed = 0;
  const nowIso = now.toISOString();

  for (const row of latestByTenant.values()) {
    try {
      await billing.updateSubscriptionQuantity({
        subscriptionId: row.stripe_subscription_id,
        quantity: row.billable_locations,
      });
      db.prepare(`UPDATE billing_snapshots SET stripe_synced_at = ? WHERE tenant_id = ? AND stripe_synced_at IS NULL`).run(
        nowIso,
        row.tenant_id
      );
      logAudit(db, {
        tenantId: row.tenant_id,
        actorType: 'system',
        actorId: 'billing-sync-worker',
        eventType: 'billing.quantity_synced',
        targetType: 'tenant',
        targetId: row.tenant_id,
        payload: { quantity: row.billable_locations },
      });
      synced++;
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`[billing-sync] tenant ${row.tenant_id} quantity sync failed:`, err);
    }
  }

  return { synced, failed };
}
