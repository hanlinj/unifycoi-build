// POST /api/exports — request an audit export (Admin-only).
// body: { scope, scope_ref, format, includes_sensitive, reason }
// Sync (vendor/location) → generated inline, returns { export_id, status: 'ready' }.
// Async (region/org/tenant_offboard) → { export_id, status: 'queued' } (worker generates).

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, unprocessable } from '@/lib/api';
import { createAuditExport, AuditExportError, type ExportScope, type ExportFormat } from '@/lib/exports/audit-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role !== 'admin') return forbidden(); // audit export is Admin-only (kickoff)

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }
  const b = body as Record<string, unknown>;

  try {
    const result = await createAuditExport({
      db: getRawDb(),
      tenantId: auth.tenantId,
      requestedBy: auth.sub,
      scope: b.scope as ExportScope,
      scopeRef: typeof b.scope_ref === 'string' ? b.scope_ref : null,
      format: b.format as ExportFormat,
      includesSensitive: b.includes_sensitive === true,
      reason: typeof b.reason === 'string' ? b.reason : null,
    });
    return NextResponse.json({ data: { export_id: result.exportId, status: result.status } }, { status: result.status === 'ready' ? 200 : 202 });
  } catch (err) {
    if (err instanceof AuditExportError) {
      if (err.code === 'REASON_REQUIRED') return unprocessable(err.message);
      return badRequest(err.message);
    }
    throw err;
  }
}
