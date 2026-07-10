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
export interface BillingSetupIntentState {
  clientSecret: string;
  status: string;
  /** Attached once the customer has confirmed the SetupIntent with a card; null until then. */
  paymentMethodId: string | null;
}
export interface BillingFinalizeResult {
  paid: boolean;
  /** Present only when paid=false — e.g. a card_declined message. Never thrown. */
  error?: string;
}
export interface BillingInvoice {
  id: string;
  status: string | null; // 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'
  amountPaidCents: number;
  createdAt: string; // ISO — converted from Stripe's unix seconds
  hostedInvoiceUrl: string | null;
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
  /**
   * Re-fetch a SetupIntent's live state (Slice 5a.1 — the card-entry page) — the client secret
   * from the original createSetupIntent call is never persisted, so a link opened later needs
   * a fresh one for the same underlying SetupIntent.
   */
  retrieveSetupIntent(input: { setupIntentId: string }): Promise<BillingSetupIntentState>;
  /**
   * After the customer confirms their card: set it as the customer's default payment method and
   * attempt to pay the tenant's open (first) invoice. Never throws — a decline is a structured
   * `{ paid: false, error }` result, same non-throwing shape as attachBilling, so the card-entry
   * page can show the customer an error and let them retry without the tenant ending up in a
   * half-activated state (actual activation stays the invoice.paid webhook's job either way).
   */
  finalizeCardSetup(input: { customerId: string; paymentMethodId: string }): Promise<BillingFinalizeResult>;
  /**
   * Recent invoices for the tenant's cockpit billing-history view (Slice 6). Stripe is the
   * source of truth for invoice/payment history — this is a read-through, not a local mirror
   * (billing_snapshots is location-count history, a different thing entirely, and is never
   * conflated with this).
   */
  listRecentInvoices(input: { customerId: string; limit?: number }): Promise<BillingInvoice[]>;
  /**
   * Swap the live subscription's per-location rate onto a NEW Price (Slice 6 — Stripe Prices
   * are immutable, so a rate change is always create-new-Price + point-the-item-at-it, never an
   * edit of the existing Price). `proration_behavior: 'none'` — same rule as
   * updateSubscriptionQuantity — so the new rate takes effect at the NEXT billing cycle, never
   * a mid-month partial charge. Deliberately does NOT touch the item's `quantity` field: Stripe
   * subscription-item updates are partial (only the fields you pass change), so the
   * quantity-sync worker's last-pushed quantity survives a rate swap untouched.
   */
  updateSubscriptionPrice(input: { subscriptionId: string; unitAmountCents: number; idempotencyKey: string }): Promise<void>;
  /** Live subscription status (active/past_due/canceled/...) for the cockpit billing panel — a
   *  customer whose card failed should read past_due here, not a stale locally-derived "active". */
  getSubscriptionStatus(input: { subscriptionId: string }): Promise<{ status: string }>;
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
  async retrieveSetupIntent(input: { setupIntentId: string }): Promise<BillingSetupIntentState> {
    return { clientSecret: `${input.setupIntentId}_secret`, status: 'requires_payment_method', paymentMethodId: null };
  }
  async finalizeCardSetup(): Promise<BillingFinalizeResult> {
    return { paid: true }; // deterministic success — no real invoice to decline
  }
  async listRecentInvoices(): Promise<BillingInvoice[]> {
    return []; // no real Stripe customer behind this id — nothing to list
  }
  async updateSubscriptionPrice(): Promise<void> {
    // No real subscription behind this id — nothing to update.
  }
  async getSubscriptionStatus(): Promise<{ status: string }> {
    return { status: 'active' }; // deterministic — no real Stripe subscription to be out of sync with
  }
}
