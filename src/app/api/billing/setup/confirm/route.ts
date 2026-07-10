// POST /api/billing/setup/confirm — called by the card-entry page right after the customer's
// SetupIntent confirms client-side. This route ONLY triggers the charge attempt (default
// payment method + pay the open invoice) and reports paid/declined for immediate UI feedback —
// it does NOT flip the tenant to active itself. Activation stays exclusively the invoice.paid
// webhook's job (stripe-webhook.ts), so there is only ever one activation path, and Stripe
// redelivery/retry semantics on the webhook remain the single source of truth.
//
// Cookie-less, unauthenticated (the billing-setup token in the body is the credential) — same
// posture as /api/auth/password-reset/confirm; structurally CSRF-exempt (ADR-011-06).

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { getTenantById } from '@/lib/services/tenants';
import { resolveBillingSetupToken } from '@/lib/services/password-reset';
import { defaultBillingProvider } from '@/lib/billing/stripe';
import { ok, badRequest, apiError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be JSON');
  }
  const { token } = body as Record<string, unknown>;
  if (typeof token !== 'string' || !token) return badRequest('token is required');

  const db = getRawDb();
  const peek = resolveBillingSetupToken(db, token);
  if (peek.status !== 'valid') return apiError('This billing link is invalid or has expired.', 400);

  const tenant = getTenantById(db, peek.tenantId as string);
  if (!tenant || !tenant.stripe_customer_id || !tenant.stripe_setup_intent_id) {
    return apiError('Billing setup is not ready for this tenant.', 409);
  }
  if (tenant.lifecycle_state === 'active') {
    return ok({ paid: true }); // already done — idempotent for a page reload/resubmit
  }

  const setupIntent = await defaultBillingProvider.retrieveSetupIntent({ setupIntentId: tenant.stripe_setup_intent_id });
  if (setupIntent.status !== 'succeeded' || !setupIntent.paymentMethodId) {
    return apiError('Card setup has not completed yet.', 409);
  }

  const result = await defaultBillingProvider.finalizeCardSetup({
    customerId: tenant.stripe_customer_id,
    paymentMethodId: setupIntent.paymentMethodId,
  });
  return ok(result);
}
