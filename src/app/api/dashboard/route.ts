// GET /api/dashboard?trade=&q=
// Manager Home Dashboard data — "who can I hire right now", scope-clamped server-side.
// All tenant roles; District/Store clamped to their resolveScope() locations.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { buildManagerHome } from '@/lib/services/manager-home';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const url = new URL(request.url);
  const trade = url.searchParams.get('trade');
  const q = url.searchParams.get('q');

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);
  const data = buildManagerHome(db, auth.tenantId, { locationIds: scope.locationIds }, { trade, q });
  return NextResponse.json({ data });
}
