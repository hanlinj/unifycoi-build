// POST /api/platform/tenants/:tenantId/resend-admin-invite — tenant cockpit control (Slice 6).
// Actually sends the invite email (not just mint-and-return) via sendAdminInviteEmail, using
// the same send pattern as sendBillingSetupLinkEmail.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sendAdminInviteEmail } from '@/lib/services/provisioning';
import { defaultMailer } from '@/lib/notifications/mailer';
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
    const result = await sendAdminInviteEmail(getDb(), params.tenantId, defaultMailer, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'sendAdminInviteEmail' });
    return apiError('Could not resend the admin invite', 500);
  }
}
