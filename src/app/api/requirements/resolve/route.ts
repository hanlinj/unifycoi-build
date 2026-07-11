// GET /api/requirements/resolve?trade=&location= — preview the resolved effective matrix for a
// (trade, location) pair, with source-scope provenance (org / trade / location / floor).
// Read-only; reuses the Phase 3 resolver. Admin-only.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, ok } from '@/lib/api';
import { resolveRequirements, type Precedence } from '@/lib/requirements/resolver';
import { getPrecedence } from '@/lib/services/requirements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  const url = new URL(request.url);
  const trade = url.searchParams.get('trade');
  const location = url.searchParams.get('location');
  if (!trade || !location) return badRequest('trade and location are required');

  const db = getDb();
  const precedence = (await getPrecedence(db, auth.tenantId)) as Precedence;
  const matrix = await resolveRequirements(db, { tenantId: auth.tenantId, vendorTrade: trade, locationId: location, precedence });

  const entries = Object.entries(matrix).map(([requirement_key, e]) => ({
    requirement_key, required_value: e.required_value, source: e.scope, rule_id: e.rule_id,
  })).sort((a, b) => a.requirement_key.localeCompare(b.requirement_key));

  return ok({ trade, location, precedence, entries });
}
