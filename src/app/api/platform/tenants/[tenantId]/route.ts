import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { getTenantById, updateTenant } from '@/lib/services/tenants';
import { requirePlatformAuth, isResponse, ok, notFound, badRequest } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { tenantId: string } }
): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  const db = getRawDb();
  const tenant = getTenantById(db, params.tenantId);
  if (!tenant) return notFound('Tenant not found');
  return ok(tenant);
}

export async function PATCH(
  request: Request,
  { params }: { params: { tenantId: string } }
): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const db = getRawDb();
  try {
    const tenant = updateTenant(db, params.tenantId, body as Record<string, unknown>, auth.sub);
    return ok(tenant);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
