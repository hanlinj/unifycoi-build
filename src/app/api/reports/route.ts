// GET /api/reports — the report catalog the caller may run.
// Admin + District only; Store Managers have no Reports access (Reports_and_Analytics.md).

import { NextResponse } from 'next/server';
import { requireTenantAuth, isResponse, forbidden, ok } from '@/lib/api';
import { REPORTS } from '@/lib/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role === 'store_manager') return forbidden();

  return ok({ reports: REPORTS, role: auth.role });
}
