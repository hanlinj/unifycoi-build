// GET /api/search?q= — global command-palette search, scope-clamped server-side.
// Empty q → the caller's recently-viewed entities. Query strings are NOT audit-logged
// (Search.md). Tenant users only (vendors have no app).

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, ok } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { searchEntities } from '@/lib/search/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);
  const query = new URL(request.url).searchParams.get('q') ?? '';

  const results = searchEntities(db, auth.tenantId, {
    scope: { locationIds: scope.locationIds },
    role: auth.role,
    actorId: auth.sub,
    query,
  });
  return ok(results);
}
