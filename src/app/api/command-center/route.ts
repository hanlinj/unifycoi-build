// GET /api/command-center
// The exception-first triage queue, scope-clamped server-side. All tenant roles may view;
// District/Store are clamped to their resolveScope() locations.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { buildCommandCenter, countNewVendorsThisMonth } from '@/lib/services/command-center';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const db = getDb();
  const scope = await resolveScope(db, auth.tenantId, auth.sub, auth.role);
  const ccScope = { locationIds: scope.locationIds };
  const result = await buildCommandCenter(db, auth.tenantId, ccScope);
  const newVendorsThisMonth = await countNewVendorsThisMonth(db, auth.tenantId, ccScope);

  // Stat-strip numbers, sourced from the same scoped taxonomy result the tiers below render —
  // expiredVendors in particular is a filter over result.tier1 (not a second expiry query), so
  // the card and the Tier 1 queue can never disagree.
  const stats = {
    totalVendors: result.totalVendorsInScope,
    totalLocations: result.facilitiesInScope,
    newVendorsThisMonth,
    expiredVendors: result.tier1.filter((r) => r.condition === 'expired').length,
  };

  return NextResponse.json({ data: { ...result, stats } });
}
