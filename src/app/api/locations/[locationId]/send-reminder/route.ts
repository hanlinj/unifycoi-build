// POST /api/locations/:id/send-reminder  body: { vendorId }
// Admin-only Location Record action: send an immediate renewal reminder to a vendor at this
// location, bypassing the digest. Reuses the notification queue.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, notFound, conflict } from '@/lib/api';
import { sendManualRenewalReminder, ManualReminderError } from '@/lib/services/manual-reminder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { locationId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }
  const vendorId = (body as Record<string, unknown>).vendorId;
  if (typeof vendorId !== 'string' || !vendorId) return badRequest('vendorId is required');

  try {
    const result = sendManualRenewalReminder(getRawDb(), auth.tenantId, params.locationId, vendorId, auth.sub);
    return NextResponse.json({ data: { notification_id: result.notificationId } });
  } catch (err) {
    if (err instanceof ManualReminderError) {
      if (err.code === 'NOT_AT_LOCATION') return notFound('Vendor is not at this location');
      if (err.code === 'NO_EMAIL') return conflict(err.message);
    }
    throw err;
  }
}
