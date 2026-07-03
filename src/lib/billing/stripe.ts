// Real Stripe billing provider (OPS-10). Only constructed when STRIPE_SECRET_KEY is set
// (see defaultBillingProvider); dev/test/CI use the NoOp provider, so this never runs — and
// never hits the network — without a key.

import Stripe from 'stripe';
import { env } from '@/lib/env';
import type { BillingProvider, BillingCustomer, BillingSetupIntent } from './provider';
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
}

/** Stripe when a key is configured; otherwise the NoOp provider (dev/test/CI). */
export const defaultBillingProvider: BillingProvider = env.billing.stripeSecretKey
  ? new StripeBillingProvider(env.billing.stripeSecretKey)
  : new NoOpBillingProvider();
