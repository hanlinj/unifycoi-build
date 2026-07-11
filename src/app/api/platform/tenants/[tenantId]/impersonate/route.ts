import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { impersonateTenant } from '@/lib/services/tenants';
import { requirePlatformAuth, isResponse, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { tenantId: string } }
): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  const db = getDb();
  try {
    const token = await impersonateTenant(db, params.tenantId, auth.sub);
    return ok({ token, impersonatedTenantId: params.tenantId, impersonatedBy: auth.sub });
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
