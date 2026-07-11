import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { createLocation, listLocations } from '@/lib/services/locations';
import { resolveScope } from '@/lib/scope';
import { requireTenantAuth, isResponse, ok, created, badRequest, forbidden } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const db = getDb();
  const scope = await resolveScope(db, auth.tenantId, auth.sub, auth.role);
  return ok(await listLocations(db, auth.tenantId, scope));
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  // Only Admin can create locations
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const { name, address, regionId } = body as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    return badRequest('name is required');
  }

  const db = getDb();
  try {
    const location = await createLocation(db, auth.tenantId, {
      name,
      address: typeof address === 'string' ? address : undefined,
      regionId: typeof regionId === 'string' ? regionId : undefined,
    }, auth.sub);
    return created(location);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
