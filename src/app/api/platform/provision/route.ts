// POST /api/platform/provision — the white-glove provisioning transaction (OPS-8 core +
// OPS-7 input + billing-attach). Platform-authed. Creates tenant + first Admin + locations +
// template + validated timezone in one audited DB commit, then attaches the Stripe customer.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { provisionTenant, type ProvisionInput } from '@/lib/services/provisioning';
import { defaultBillingProvider } from '@/lib/billing/stripe';
import { requirePlatformAuth, isResponse, created, badRequest, apiError } from '@/lib/api';
import { captureError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  try {
    const result = await provisionTenant(getRawDb(), body as ProvisionInput, auth.sub, defaultBillingProvider);
    return created(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status); // validation / conflict
    captureError(err, { where: 'provisionTenant' }); // unexpected → ops alert (scrubbed)
    return apiError('Provisioning failed', 500);
  }
}
