// PATCH /api/platform/tenants/:tenantId/setup-fee — tenant cockpit setup-fee edit (Slice 6).
// Editable only pre-attach (no live subscription yet); once billing has attached, the fee is
// already queued/paid on Stripe's invoice and this returns { updated: false, blockedReason }
// instead of silently no-op'ing — the operator sees why.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { updateTenantSetupFee } from '@/lib/services/provisioning';
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
  const setupFeeCents = (body as { setupFeeCents?: unknown }).setupFeeCents;
  if (setupFeeCents !== null && typeof setupFeeCents !== 'number') {
    return badRequest('setupFeeCents (number or null) is required');
  }

  try {
    const result = await updateTenantSetupFee(getDb(), params.tenantId, setupFeeCents, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'updateTenantSetupFee' });
    return apiError('Could not update the setup fee', 500);
  }
}
