// GET /api/exports/:id — audit export metadata (Admin-only, tenant-isolated).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role !== 'admin') return forbidden();

  const tdb = new TenantDB(getDb(), auth.tenantId);
  const row = await tdb.get<{ id: string; scope_type: string; scope_ref: string | null; format: string; includes_sensitive: boolean; status: string; created_at: string; completed_at: string | null }>(
    'SELECT id, scope_type, scope_ref, format, includes_sensitive, status, created_at, completed_at FROM audit_exports WHERE tenant_id = $1 AND id = $2',
    [params.id]
  );
  if (!row) return notFound('Export not found'); // tenant-isolated → cross-tenant is a 404

  return ok({
    export_id: row.id,
    scope: row.scope_type,
    scope_ref: row.scope_ref,
    format: row.format,
    includes_sensitive: row.includes_sensitive,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  });
}
