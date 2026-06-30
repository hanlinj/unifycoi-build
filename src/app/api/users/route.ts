import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { createUser, usersForManagement } from '@/lib/services/users';
import { resolveScope } from '@/lib/scope';
import { requireTenantAuth, isResponse, ok, created, badRequest, forbidden } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  if (auth.role === 'store_manager') return forbidden();
  if (!auth.tenantId) return forbidden();

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);
  return ok(usersForManagement(db, auth.tenantId, scope, auth.role));
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  if (auth.role === 'store_manager') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);

  try {
    const user = createUser(db, auth.tenantId, body as Record<string, unknown> as never, auth.sub, scope, auth.role);
    return created(user);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
