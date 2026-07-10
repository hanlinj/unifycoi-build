// PATCH /api/platform/tenants/:tenantId/rate — tenant cockpit rate edit (Slice 6). If a live
// Stripe subscription exists, the price swap happens FIRST; the local rate column only changes
// once Stripe confirms. A Stripe failure is a 200 with { pushedToStripe: false, error } (same
// non-throwing shape as attachBilling/retry-billing) — never a local rate Stripe isn't charging.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { updateTenantRate } from '@/lib/services/provisioning';
import { defaultBillingProvider } from '@/lib/billing/stripe';
import { requirePlatformAuth, isResponse, ok, badRequest, apiError } from '@/lib/api';
import { captureError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: { tenantId: string } }
): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }
  const monthlyRateCents = (body as { monthlyRateCents?: unknown }).monthlyRateCents;
  if (typeof monthlyRateCents !== 'number') return badRequest('monthlyRateCents (number) is required');

  try {
    const result = await updateTenantRate(getRawDb(), params.tenantId, monthlyRateCents, defaultBillingProvider, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'updateTenantRate' });
    return apiError('Could not update the rate', 500);
  }
}
