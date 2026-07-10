// Billing provider seam (OPS-10, ⚠ owner-approved spec deviation from "no in-app payment
// processor" — flagged in decisions.md). Same swap-seam pattern as Mailer/BlobStore: the
// provisioning service depends on this interface, not Stripe directly, so it is testable
// without the network and the transport is injectable. Real impl in ./stripe.ts.

export interface BillingCustomer {
  customerId: string;
}
export interface BillingSetupIntent {
  setupIntentId: string;
  clientSecret: string; // handed to the Slice-5 wizard's Stripe Elements card entry
}
export interface BillingSubscription {
  subscriptionId: string;
}

export interface BillingProvider {
  /** Create (or, via idempotencyKey, reuse) the customer for a tenant. */
  createCustomer(input: { tenantId: string; name: string; email: string; idempotencyKey: string }): Promise<BillingCustomer>;
  /** A SetupIntent to attach a payment method (card on file) to the customer. */
  createSetupIntent(input: { customerId: string }): Promise<BillingSetupIntent>;
  /**
   * Create the recurring per-location subscription (Slice 5a, ADR-012-05 — automatic billing).
   * If setupFeeCents is set, a one-time charge rides the subscription's FIRST invoice only.
   */
  createSubscription(input: {
    customerId: string;
    unitAmountCents: number;
    quantity: number;
    setupFeeCents?: number | null;
    idempotencyKey: string;
  }): Promise<BillingSubscription>;
  /**
   * Update the live subscription's quantity — takes effect at the NEXT billing cycle, with NO
   * proration, so a mid-month location add/remove never generates a partial charge.
   */
  updateSubscriptionQuantity(input: { subscriptionId: string; quantity: number }): Promise<void>;
}

/**
 * No-op provider (dev/test/CI, no Stripe key). Returns deterministic synthetic ids keyed off
 * the idempotency key, so a retry with the same key yields the same customer id — mirroring
 * Stripe's idempotency contract and letting the failure/idempotency paths be tested offline.
 */
export class NoOpBillingProvider implements BillingProvider {
  async createCustomer(input: { tenantId: string; idempotencyKey: string }): Promise<BillingCustomer> {
    return { customerId: `cus_noop_${input.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '_')}` };
  }
  async createSetupIntent(input: { customerId: string }): Promise<BillingSetupIntent> {
    return { setupIntentId: `seti_noop_${input.customerId}`, clientSecret: `seti_noop_${input.customerId}_secret` };
  }
  async createSubscription(input: { idempotencyKey: string }): Promise<BillingSubscription> {
    return { subscriptionId: `sub_noop_${input.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '_')}` };
  }
  async updateSubscriptionQuantity(): Promise<void> {
    // No real subscription behind this id — nothing to update.
  }
}
