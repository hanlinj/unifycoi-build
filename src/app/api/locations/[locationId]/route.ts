import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { updateLocation } from '@/lib/services/locations';
import { buildLocationRecord } from '@/lib/services/location-record';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden, notFound } from '@/lib/api';
import { resolveScope, scopeIncludesLocation } from '@/lib/scope';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/locations/:id — Location Record (read-only summary + vendor list), scope-clamped.
export async function GET(
  request: Request,
  { params }: { params: { locationId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const db = getRawDb();
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const trade = url.searchParams.get('trade');

  // Within-tenant scope clamp (inherits the Slice C pattern). A non-Admin must have this
  // location in scope; otherwise uniform 404 + a logged scope violation. Admin sees any.
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);
  if (scope.locationIds !== null && !scopeIncludesLocation(scope, params.locationId)) {
    const exists = db.prepare('SELECT 1 FROM locations WHERE tenant_id = ? AND id = ?').get(auth.tenantId, params.locationId);
    if (exists) {
      logAudit(db, {
        tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
        eventType: 'security.scope_violation', targetType: 'location', targetId: params.locationId,
        payload: { role: auth.role, scope_location_ids: scope.locationIds, attempted: 'GET /api/locations/:id' },
      });
    }
    return notFound('Location not found');
  }

  const record = buildLocationRecord(db, auth.tenantId, params.locationId, { status, trade });
  if (!record) return notFound('Location not found');

  // Record the in-scope view (standard-access grain) — powers Search recent-viewed.
  logAudit(db, {
    tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
    eventType: 'location.viewed', targetType: 'location', targetId: params.locationId,
    payload: { role: auth.role },
  });

  return ok({ ...record, role: auth.role });
}

// PATCH /api/locations/:id — Admin-only profile edit / archive (status='archived').
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
