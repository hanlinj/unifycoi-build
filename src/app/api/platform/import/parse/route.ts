// POST /api/platform/import/parse — parses an uploaded .csv/.xlsx into editable table rows for
// the ProvisioningWizard's Locations step. Read-only: nothing is created here (Slice 12/5b,
// Feature 1 — the editable-form UX, not a preview-and-approve gate). Platform-authed since this
// runs before any tenant exists.

import { NextResponse } from 'next/server';
import { requirePlatformAuth, isResponse, ok, badRequest } from '@/lib/api';
import { parseSpreadsheetFile } from '@/lib/import/parse-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  let formData: FormData;
  try { formData = await request.formData(); } catch { return badRequest('Provide the file as multipart/form-data (field: "file")'); }
  const file = formData.get('file');
  if (!file || typeof file === 'string') return badRequest('Missing file field');

  const result = await parseSpreadsheetFile((file as File).name, await (file as File).arrayBuffer());
  if (result.headerErrors.length > 0) return badRequest(result.headerErrors.join('; '));
  return ok(result.rows);
}
