// POST /api/vendors/:id/locations
// Add-to-locations (collect-once reuse within a tenant).
// Admin-only. Delegates to addVendorToLocations() service.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, notFound, conflict } from '@/lib/api';
import { addVendorToLocations, AddToLocationsError } from '@/lib/services/add-to-locations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  if (auth.role !== 'admin') return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body required');
  }

  const b = body as Record<string, unknown>;
  const locationIds: string[] = Array.isArray(b.location_ids) ? (b.location_ids as string[]) : [];

  if (locationIds.length === 0) return badRequest('location_ids must contain at least one location');

  try {
    const result = await addVendorToLocations({
      db: getDb(),
      tenantId: auth.tenantId,
      vendorId: params.id,
      actorUserId: auth.sub,
      locationIds,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof AddToLocationsError) {
      if (err.code === 'NOT_FOUND') return notFound(err.message);
      if (err.code === 'BAD_LOCATION') return badRequest(err.message);
      if (err.code === 'ALREADY_ASSOCIATED') return conflict(err.message);
    }
    throw err;
  }
}
