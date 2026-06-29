// GET /api/command-center
// The exception-first triage queue, scope-clamped server-side. All tenant roles may view;
// District/Store are clamped to their resolveScope() locations.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { buildCommandCenter } from '@/lib/services/command-center';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);
  const data = buildCommandCenter(db, auth.tenantId, { locationIds: scope.locationIds });
  return NextResponse.json({ data });
}
