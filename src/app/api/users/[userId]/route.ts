import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { updateUser } from '@/lib/services/users';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden, notFound } from '@/lib/api';
import { resolveScope, userManageableByScope } from '@/lib/scope';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: { userId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  if (auth.role === 'store_manager') return forbidden();
  if (!auth.tenantId) return forbidden();

  const db = getDb();

  // Within-tenant scope clamp (Slice C security pass): a District may manage a user only if
  // the target is fully within their region scope; never an Admin. Out-of-scope OR missing →
  // uniform 404 (enumeration-resistant); a real out-of-scope target logs a scope violation.
  if (auth.role !== 'admin') {
    const scope = await resolveScope(db, auth.tenantId, auth.sub, auth.role);
    const check = await userManageableByScope(db, auth.tenantId, scope, params.userId);
    if (!check.inScope) {
      if (check.exists) {
        await logAudit(db, {
          tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
          eventType: 'security.scope_violation', targetType: 'user', targetId: params.userId,
          payload: { role: auth.role, scope_region_ids: scope.regionIds, attempted: 'PATCH /api/users/:id' },
        });
      }
      return notFound('User not found');
    }
  }

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  try {
    const user = await updateUser(db, auth.tenantId, params.userId, body as Record<string, unknown> as never, auth.sub);
    return ok(user);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
