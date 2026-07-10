// POST /api/locations/import/parse — parses an uploaded .csv/.xlsx into editable table rows for
// the tenant-Admin bulk-add-locations screen. Read-only: nothing is created here (Slice 12/5b,
// Feature 1 — the editable-form UX, not a preview-and-approve gate).

import { NextResponse } from 'next/server';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden } from '@/lib/api';
import { parseSpreadsheetFile } from '@/lib/import/parse-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let formData: FormData;
  try { formData = await request.formData(); } catch { return badRequest('Provide the file as multipart/form-data (field: "file")'); }
  const file = formData.get('file');
  if (!file || typeof file === 'string') return badRequest('Missing file field');

  const result = await parseSpreadsheetFile((file as File).name, await (file as File).arrayBuffer());
  if (result.headerErrors.length > 0) return badRequest(result.headerErrors.join('; '));
  return ok(result.rows);
}
