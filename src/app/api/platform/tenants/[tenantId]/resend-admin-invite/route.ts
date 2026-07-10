// POST /api/platform/tenants/:tenantId/resend-admin-invite — tenant cockpit control (Slice 6),
// closes the OPS-14 remainder. Reuses resendFirstAdminInvite, which reuses issueInviteToken
// verbatim (same path the wizard's invite and activateTenantOnFirstPayment use).

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { resendFirstAdminInvite } from '@/lib/services/provisioning';
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
    const result = resendFirstAdminInvite(getRawDb(), params.tenantId, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'resendFirstAdminInvite' });
    return apiError('Could not resend the admin invite', 500);
  }
}
