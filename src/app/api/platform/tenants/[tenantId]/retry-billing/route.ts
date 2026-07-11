// POST /api/platform/tenants/:tenantId/retry-billing — the wizard's "Retry billing" action for
// a tenant provisioned with stripe_customer_id NULL (the DB-commit/Stripe-call boundary's
// recoverable path). Calls the SAME attachBilling() the initial provision-time attach used —
// idempotent via the provision:<tenantId> key, so a retry reuses the customer, never dupes.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { attachBilling } from '@/lib/services/provisioning';
import { defaultBillingProvider } from '@/lib/billing/stripe';
import { requirePlatformAuth, isResponse, ok, apiError } from '@/lib/api';
import { captureError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { tenantId: string } }
): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  try {
    const result = await attachBilling(getDb(), params.tenantId, defaultBillingProvider, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'attachBilling' });
    return apiError('Billing retry failed', 500);
  }
}
