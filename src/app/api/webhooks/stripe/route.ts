// Stripe webhook (Slice 5a — automatic billing, ADR-012-05). Cookie-less and
// signature-authenticated (NOT session-authed) — structurally CSRF-exempt already (ADR-011-06:
// cookie-less POST to a non-login path is exempt by construction, no allowlist to maintain).
// All logic lives in lib/billing/stripe-webhook.ts; this is thin wiring, same split as the
// Resend webhook (src/app/api/webhooks/resend/route.ts).

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getDb } from '@/lib/db/client';
import { env } from '@/lib/env';
import { handleStripeEvent } from '@/lib/billing/stripe-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // No secret configured → cannot verify signatures → fail closed (never process unverified
  // Stripe payloads, which would let anyone POST a fake "invoice.paid" and activate a tenant).
  if (!env.billing.stripeWebhookSecret) {
    return NextResponse.json({ error: 'Stripe webhook not configured' }, { status: 503 });
  }

  const rawBody = await request.text(); // raw body required for signature verification
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'missing signature' }, { status: 400 });

  // constructEvent doesn't call the network — the API secret key isn't actually needed for
  // verification, only the webhook signing secret is. A placeholder key when unset (dev/test
  // without a real Stripe key configured) is fine here.
  const stripeClient = new Stripe(env.billing.stripeSecretKey || 'sk_webhook_verify_only');

  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(rawBody, signature, env.billing.stripeWebhookSecret);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  const result = await handleStripeEvent(getDb(), event);
  // Always 2xx once authenticated so Stripe doesn't retry-storm on an ignored/unknown event.
  return NextResponse.json(result, { status: 200 });
}
