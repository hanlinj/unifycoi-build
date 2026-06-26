import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { inviteUser } from '@/lib/services/users';
import { requireTenantAuth, isResponse, ok, forbidden } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { userId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  if (auth.role === 'store_manager') return forbidden();
  if (!auth.tenantId) return forbidden();

  const db = getRawDb();
  try {
    const user = inviteUser(db, auth.tenantId, params.userId, auth.sub);
    return ok(user);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
