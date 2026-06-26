import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { updateLocation } from '@/lib/services/locations';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: { locationId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  // Only Admin can update/archive locations
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const db = getRawDb();
  try {
    const location = updateLocation(db, auth.tenantId, params.locationId, body as Record<string, unknown> as never, auth.sub);
    return ok(location);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
