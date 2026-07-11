// Location-count → Stripe subscription quantity sync (Slice 5a, ADR-012-05).
//
// Why this is a separate poller and not inline in createLocation/updateLocation: those
// functions run (in the provisioning path) inside provisionTenant's transaction, and this
// split was originally forced by better-sqlite3 requiring that callback to be fully
// synchronous — a Stripe call couldn't live inside one. Kysely/Postgres transactions ARE
// async-capable (Phase 13 migration), so that specific constraint no longer applies, but the
// separate-poller architecture is kept as-is this pass (foundation only — see provisioning.ts's
// matching note). createLocation/updateLocation/bulkImportLocations keep doing exactly what
// they already did (an unconditional/conditional write to billing_snapshots via
// recordBillingSnapshot, unchanged) — that write IS the trigger this worker polls for. Same
// "commit, push to the external system afterward on a separate cadence" shape as attachBilling's
// DB/Stripe boundary, just recurring instead of one-shot.
//
// Quantity, not delta: a snapshot row is a point-in-time billable_locations count, not an
// increment. Only the LATEST unsynced row per tenant needs a Stripe call — any earlier unsynced
// row for the same tenant is a superseded intermediate value and is marked synced without its
// own API call.

import type { Db } from '@/lib/db/client';
import { logAudit } from '@/lib/audit';
import type { BillingProvider } from './provider';

export interface QuantitySyncResult {
  synced: number;
  failed: number;
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
  db: Db,
  billing: BillingProvider,
  now: Date = new Date()
): Promise<QuantitySyncResult> {
  // Ordered by seq, not created_at: multiple snapshot rows for a tenant can land in the same
  // millisecond, and timestamp ties resolve arbitrarily — seq (bigserial, Stage 4's rowid
  // replacement — Postgres has no stable implicit row-order id) is a reliable, monotonically-
  // increasing insertion-order tiebreaker (see provisioning.ts's attachBilling for the same fix).
  const rows = await db
    .selectFrom('billing_snapshots as bs')
    .innerJoin('tenants as t', 't.id', 'bs.tenant_id')
    .select(['bs.tenant_id', 'bs.billable_locations', 't.stripe_subscription_id'])
    .where('bs.changed', '=', true)
    .where('bs.stripe_synced_at', 'is', null)
    .where('t.stripe_subscription_id', 'is not', null)
    .orderBy('bs.seq', 'asc')
    .execute();

  // Collapse to the latest row per tenant (rows are ASC, so a later Map.set wins).
  const latestByTenant = new Map<string, { tenant_id: string; billable_locations: number; stripe_subscription_id: string }>();
  for (const row of rows) latestByTenant.set(row.tenant_id, row as { tenant_id: string; billable_locations: number; stripe_subscription_id: string });

  let synced = 0;
  let failed = 0;

  for (const row of latestByTenant.values()) {
    try {
      await billing.updateSubscriptionQuantity({
        subscriptionId: row.stripe_subscription_id,
        quantity: row.billable_locations,
      });
      await db
        .updateTable('billing_snapshots')
        .set({ stripe_synced_at: now })
        .where('tenant_id', '=', row.tenant_id)
        .where('stripe_synced_at', 'is', null)
        .execute();
      await logAudit(db, {
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
