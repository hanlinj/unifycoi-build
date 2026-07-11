// GET /api/exports/:id/download — stream the generated export file (Admin-only, tenant-isolated).
// The download is itself audited (export.downloaded). Returns 409 if not yet ready.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound, conflict } from '@/lib/api';
import { getBlobStore } from '@/lib/blob';
import { unpackEncrypted } from '@/lib/crypto/envelope-file';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role !== 'admin') return forbidden();

  const db = getDb();
  const tdb = new TenantDB(db, auth.tenantId);
  const row = await tdb.get<{ id: string; format: string; status: string; storage_key: string | null }>(
    'SELECT id, format, status, storage_key FROM audit_exports WHERE tenant_id = $1 AND id = $2',
    [params.id]
  );
  if (!row) return notFound('Export not found'); // tenant-isolated → cross-tenant 404
  if (row.status !== 'ready' || !row.storage_key) return conflict(`Export is ${row.status}, not ready`);

  const blob = await getBlobStore().get(row.storage_key);
  const bytes = unpackEncrypted(blob);

  // Downloading an export is itself an audited access event (defensibility).
  await logAudit(db, {
    tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
    eventType: 'export.downloaded', targetType: 'audit_export', targetId: row.id,
    payload: { format: row.format },
  });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': row.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      'Content-Disposition': `attachment; filename="audit-export-${row.id}.${row.format}"`,
    },
  });
}
