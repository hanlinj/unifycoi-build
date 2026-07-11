import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { inviteUser } from '@/lib/services/users';
import { requireTenantAuth, isResponse, ok, forbidden, notFound } from '@/lib/api';
import { resolveScope, userManageableByScope } from '@/lib/scope';
import { logAudit } from '@/lib/audit';

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

  const db = getDb();

  // Within-tenant scope clamp (Slice C security pass) — same rule as PATCH.
  if (auth.role !== 'admin') {
    const scope = await resolveScope(db, auth.tenantId, auth.sub, auth.role);
    const check = await userManageableByScope(db, auth.tenantId, scope, params.userId);
    if (!check.inScope) {
      if (check.exists) {
        await logAudit(db, {
          tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
          eventType: 'security.scope_violation', targetType: 'user', targetId: params.userId,
          payload: { role: auth.role, scope_region_ids: scope.regionIds, attempted: 'POST /api/users/:id/invite' },
        });
      }
      return notFound('User not found');
    }
  }

  try {
    const user = await inviteUser(db, auth.tenantId, params.userId, auth.sub);
    return ok(user);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
