// GET /api/reports/:reportKey?region=&location=&trade=&from=&to=&format=
//
// Single-endpoint pattern (chosen over a separate POST /export): a report's view, CSV, and PDF
// are the same scoped query rendered three ways, so format is just a parameter on the one
// read route — fewer surfaces to scope-clamp and audit, and the URL stays bookmarkable.
// No format → JSON view (Slice B). format=csv|pdf → generated file (Slice C): stored to
// BlobStore (envelope-encrypted) and returned inline. Admin + District only.

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, notFound, badRequest, ok } from '@/lib/api';
import { resolveScope } from '@/lib/scope';
import { logAudit } from '@/lib/audit';
import { getBlobStore } from '@/lib/blob';
import { packEncrypted } from '@/lib/crypto/envelope-file';
import { reportMeta, type ReportFilters } from '@/lib/reports';
import { runReport } from '@/lib/reports/builders';
import { projectReport } from '@/lib/reports/project';
import { toCsv } from '@/lib/reports/csv';
import { renderReportPdf } from '@/lib/reports/pdf';

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
  const format = url.searchParams.get('format');
  if (format !== null && format !== 'csv' && format !== 'pdf') return badRequest("format must be 'csv' or 'pdf'");

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

  // ── JSON view ─────────────────────────────────────────────────────────────────
  if (format === null) {
    logAudit(db, {
      tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
      eventType: 'report.viewed', targetType: 'report', targetId: meta.key,
      payload: { filters, format: 'view' },
    });
    return ok(result);
  }

  // ── Generated file (csv | pdf) ──────────────────────────────────────────────────
  const table = projectReport(meta.key, result);
  const bytes: Buffer = format === 'csv'
    ? Buffer.from(toCsv(table.columns, table.rows), 'utf-8')
    : Buffer.from(await renderReportPdf({ tenantName: tenantName(db, auth.tenantId), table, generatedAt: result.generatedAt, filters }));

  // Persist to BlobStore (envelope-encrypted, self-contained), retained per the doc schedule.
  const generationId = randomUUID();
  const storageKey = `tenants/${auth.tenantId}/reports/${meta.key}/${generationId}.${format}`;
  await getBlobStore().put(storageKey, packEncrypted(bytes));

  logAudit(db, {
    tenantId: auth.tenantId, actorType: 'user', actorId: auth.sub,
    eventType: 'report.generated', targetType: 'report', targetId: meta.key,
    payload: { report_key: meta.key, filters, format, row_count: table.rows.length, storage_key: storageKey },
  });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      'Content-Disposition': `attachment; filename="${meta.key}-${result.generatedAt.slice(0, 10)}.${format}"`,
    },
  });
}

function tenantName(db: ReturnType<typeof getRawDb>, tenantId: string): string {
  const row = db.prepare('SELECT name FROM tenants WHERE id = ?').get(tenantId) as { name: string } | undefined;
  return row?.name ?? 'UnifyCOI';
}
