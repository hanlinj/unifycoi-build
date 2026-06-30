// POST /api/exports — request an audit export.
// body: { scope, scope_ref, format, includes_sensitive, reason }
//
// Authority (Audit_Export_Generation.md / Regional_District_View.md):
//   Admin           — any scope; may opt into Sensitive (with reason).
//   District Manager — scope='region' within their assigned regions only; Standard-only
//                      (includes_sensitive coerced to false). org/tenant_offboard, out-of-region
//                      regions, and a Sensitive attempt each log security.scope_violation.
//   Store Manager   — no export rights (403 + violation).
// Sync (vendor/location) → 200 ready; async (region/org/tenant_offboard) → 202 queued.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, unprocessable } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { logAudit } from '@/lib/audit';
import { createAuditExport, AuditExportError, type ExportScope, type ExportFormat } from '@/lib/exports/audit-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  const tenantId = auth.tenantId;
  const db = getRawDb();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }
  const b = body as Record<string, unknown>;
  const scope = b.scope as ExportScope;
  const scopeRef = typeof b.scope_ref === 'string' ? b.scope_ref : null;
  const format = b.format as ExportFormat;
  let includesSensitive = b.includes_sensitive === true;
  const reason = typeof b.reason === 'string' ? b.reason : null;

  const logViolation = (detail: Record<string, unknown>) =>
    logAudit(db, {
      tenantId, actorType: 'user', actorId: auth.sub,
      eventType: 'security.scope_violation', targetType: 'audit_export', targetId: null,
      payload: { role: auth.role, attempted: 'POST /api/exports', ...detail },
    });

  // ── Authority ────────────────────────────────────────────────────────────────────
  if (auth.role === 'store_manager') {
    logViolation({ scope });
    return forbidden();
  }
  if (auth.role === 'district_manager') {
    if (scope !== 'region') { logViolation({ scope, reason: 'scope_not_allowed_for_district' }); return forbidden(); }
    const callerScope = resolveScope(db, tenantId, auth.sub, auth.role);
    if (!scopeRef || callerScope.regionIds === null || !callerScope.regionIds.includes(scopeRef)) {
      logViolation({ scope, scope_ref: scopeRef, reason: 'region_out_of_scope' });
      return forbidden();
    }
    if (includesSensitive) {
      // Standard-only for District — coerce to false and log the attempt (don't reject).
      logViolation({ scope, scope_ref: scopeRef, reason: 'sensitive_not_permitted_for_district' });
      includesSensitive = false;
    }
  }

  try {
    const result = await createAuditExport({
      db, tenantId, requestedBy: auth.sub, scope, scopeRef, format, includesSensitive, reason,
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
