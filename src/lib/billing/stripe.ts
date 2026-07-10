// Real Stripe billing provider (OPS-10). Only constructed when STRIPE_SECRET_KEY is set
// (see defaultBillingProvider); dev/test/CI use the NoOp provider, so this never runs — and
// never hits the network — without a key.

import Stripe from 'stripe';
import { env } from '@/lib/env';
import type {
  BillingProvider,
  BillingCustomer,
  BillingSetupIntent,
  BillingSubscription,
  BillingSetupIntentState,
  BillingFinalizeResult,
} from './provider';
import { NoOpBillingProvider } from './provider';

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;
  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async createCustomer(input: { tenantId: string; name: string; email: string; idempotencyKey: string }): Promise<BillingCustomer> {
    // idempotencyKey (provision:<tenantId>) makes a retry reuse the same customer — no dupes.
    const customer = await this.stripe.customers.create(
      { name: input.name, email: input.email, metadata: { tenant_id: input.tenantId } },
      { idempotencyKey: input.idempotencyKey }
    );
    return { customerId: customer.id };
  }

  async createSetupIntent(input: { customerId: string }): Promise<BillingSetupIntent> {
    const si = await this.stripe.setupIntents.create({ customer: input.customerId, usage: 'off_session' });
    return { setupIntentId: si.id, clientSecret: si.client_secret ?? '' };
  }

  async createSubscription(input: {
    customerId: string;
    unitAmountCents: number;
    quantity: number;
    setupFeeCents?: number | null;
    idempotencyKey: string;
  }): Promise<BillingSubscription> {
    // Setup fee first, as a PENDING invoice item — Stripe sweeps any pending items for this
    // customer into the next invoice it generates, which for a brand-new subscription is
    // exactly the first one. Nothing here yet if there's no fee.
    if (input.setupFeeCents) {
      await this.stripe.invoiceItems.create(
        { customer: input.customerId, amount: input.setupFeeCents, currency: 'usd', description: 'One-time setup fee' },
        { idempotencyKey: `${input.idempotencyKey}:setup-fee` }
      );
    }

    // This SDK's subscription-item price_data requires an EXISTING product id (no inline
    // product_data there) — so create the Price (with its Product) first via prices.create,
    // which does support inline product_data, then reference the resulting price id.
    const price = await this.stripe.prices.create(
      {
        currency: 'usd',
        unit_amount: input.unitAmountCents,
        recurring: { interval: 'month' },
        product_data: { name: 'Per-location monthly fee' },
      },
      { idempotencyKey: `${input.idempotencyKey}:price` }
    );

    const subscription = await this.stripe.subscriptions.create(
      {
        customer: input.customerId,
        items: [{ price: price.id, quantity: input.quantity }],
        // Card isn't attached yet at this point (the customer confirms the SetupIntent later,
        // on the /billing/setup page) — don't hard-fail subscription creation on that; the
        // invoice sits open until a payment method attaches and finalizeCardSetup pays it,
        // which is what fires the invoice.paid webhook.
        payment_behavior: 'default_incomplete',
      },
      { idempotencyKey: input.idempotencyKey }
    );

    return { subscriptionId: subscription.id };
  }

  async updateSubscriptionQuantity(input: { subscriptionId: string; quantity: number }): Promise<void> {
    const subscription = await this.stripe.subscriptions.retrieve(input.subscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) return;
    await this.stripe.subscriptions.update(input.subscriptionId, {
      items: [{ id: itemId, quantity: input.quantity }],
      proration_behavior: 'none', // next cycle only — never a mid-month partial charge
    });
  }

  async retrieveSetupIntent(input: { setupIntentId: string }): Promise<BillingSetupIntentState> {
    const si = await this.stripe.setupIntents.retrieve(input.setupIntentId);
    const paymentMethodId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method?.id ?? null);
    return { clientSecret: si.client_secret ?? '', status: si.status, paymentMethodId };
  }

  async finalizeCardSetup(input: { customerId: string; paymentMethodId: string }): Promise<BillingFinalizeResult> {
    await this.stripe.customers.update(input.customerId, {
      invoice_settings: { default_payment_method: input.paymentMethodId },
    });

    const openInvoices = await this.stripe.invoices.list({ customer: input.customerId, status: 'open', limit: 1 });
    const invoice = openInvoices.data[0];
    if (!invoice?.id) return { paid: false, error: 'No open invoice found for this tenant.' };

    try {
      const paid = await this.stripe.invoices.pay(invoice.id);
      return { paid: paid.status === 'paid' };
    } catch (err) {
      // Card declined, insufficient funds, etc. — a structured result, never thrown further:
      // the card IS attached fine (the SetupIntent already succeeded), only the charge failed.
      return { paid: false, error: (err as Error).message };
    }
  }
}

/** Stripe when a key is configured; otherwise the NoOp provider (dev/test/CI). */
export const defaultBillingProvider: BillingProvider = env.billing.stripeSecretKey
  ? new StripeBillingProvider(env.billing.stripeSecretKey)
  : new NoOpBillingProvider();
