// GET /api/reports/:reportKey?region=&location=&trade=&from=&to=
// On-demand report data, scope-clamped server-side. Admin + District only.
// (PDF/CSV export via ?format= is added in Slice C.)

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, notFound, ok } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { logAudit } from '@/lib/audit';
import { reportMeta, type ReportFilters } from '@/lib/reports';
import { runReport } from '@/lib/reports/builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { reportKey: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role === 'store_manager') return forbidden(); // not a Reports audience

  const meta = reportMeta(params.reportKey);
  if (!meta) return notFound('Report not found');

  const url = new URL(request.url);
  const filters: ReportFilters = {
    region: url.searchParams.get('region'),
    location: url.searchParams.get('location'),
    trade: url.searchParams.get('trade'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  };

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);
  const result = runReport(db, auth.tenantId, { locationIds: scope.locationIds }, meta.key, filters);

  // Every report view is a logged access event (Reports_and_Analytics.md).
  logAudit(db, {
    tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
    eventType: 'report.viewed', targetType: 'report', targetId: meta.key,
    payload: { filters, format: 'view' },
  });

  return ok(result);
}
