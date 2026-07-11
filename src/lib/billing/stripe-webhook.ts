// Stripe invoice.paid webhook handler (Slice 5a, ADR-012-05 — activation-on-payment). Net-new:
// no Stripe webhook of any kind existed before this. Logic lives here; the route
// (src/app/api/webhooks/stripe/route.ts) is thin wiring, same split as the Resend webhook.
//
// Gate: only the FIRST invoice for a subscription (billing_reason === 'subscription_create')
// activates the tenant + issues the Admin invite — a monthly renewal invoice
// ('subscription_cycle') is a routine recurring charge, not an activation event.
//
// Idempotent by construction: activateTenantOnFirstPayment no-ops for a tenant that isn't
// still 'provisioning', so a redelivered webhook event (Stripe retries on anything but a 2xx,
// and can occasionally redeliver even after one) never double-activates or double-invites.

import type Stripe from 'stripe';
import type { Db } from '@/lib/db/client';
import { activateTenantOnFirstPayment } from '@/lib/services/provisioning';

export interface StripeWebhookResult {
  handled: boolean;
  reason?: string;
}

export async function handleStripeEvent(db: Db, event: Stripe.Event): Promise<StripeWebhookResult> {
  if (event.type !== 'invoice.paid') {
    return { handled: false, reason: `ignored event type: ${event.type}` };
  }

  const invoice = event.data.object as Stripe.Invoice;
  if (invoice.billing_reason !== 'subscription_create') {
    return { handled: false, reason: `ignored billing_reason: ${invoice.billing_reason} (not the first invoice)` };
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return { handled: false, reason: 'invoice has no customer' };

  const tenant = await db.selectFrom('tenants').select('id').where('stripe_customer_id', '=', customerId).executeTakeFirst();
  if (!tenant) return { handled: false, reason: 'no tenant for this Stripe customer' };

  const result = await activateTenantOnFirstPayment(db, tenant.id);
  if (!result) return { handled: false, reason: 'tenant already active (idempotent no-op) or has no admin' };

  return { handled: true };
}
