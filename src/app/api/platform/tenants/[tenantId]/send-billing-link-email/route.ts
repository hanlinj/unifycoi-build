// POST /api/platform/tenants/:tenantId/send-billing-link-email — the provisioning-wizard
// completion step's "Send via email" action. Operator-triggered only (never auto-sent).
// Sends synchronously via the real Mailer and returns the true delivery outcome (sent/failed +
// recipient) — not a queued/fire-and-forget result, so the button can reflect what actually
// happened.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sendBillingSetupLinkEmail } from '@/lib/services/provisioning';
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
    const result = await sendBillingSetupLinkEmail(getDb(), params.tenantId, defaultMailer, auth.sub);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) return apiError((err as Error).message, status);
    captureError(err, { where: 'sendBillingSetupLinkEmail' });
    return apiError('Could not send the billing-setup email', 500);
  }
}
