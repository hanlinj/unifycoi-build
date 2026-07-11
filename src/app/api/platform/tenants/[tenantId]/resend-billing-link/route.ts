// POST /api/platform/tenants/:tenantId/resend-billing-link — tenant cockpit control (Slice 6),
// closes the OPS-14 remainder. Reuses resendBillingSetupLink, which reuses
// issueBillingSetupToken verbatim (same issuer attachBilling calls).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { resendBillingSetupLink } from '@/lib/services/provisioning';
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
    const result = await resendBillingSetupLink(getDb(), params.tenantId, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'resendBillingSetupLink' });
    return apiError('Could not resend the billing-setup link', 500);
  }
}
