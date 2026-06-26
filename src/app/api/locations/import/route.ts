import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { bulkImportLocations } from '@/lib/services/locations';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;

  // Only Admin can bulk-import
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  const contentType = request.headers.get('Content-Type') ?? '';
  let csvText: string;

  if (contentType.includes('multipart/form-data')) {
    let formData: FormData;
    try { formData = await request.formData(); } catch { return badRequest('Invalid form data'); }
    const file = formData.get('file');
    if (!file || typeof file === 'string') return badRequest('Missing file field');
    csvText = await (file as File).text();
  } else if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
    csvText = await request.text();
  } else {
    return badRequest('Provide the CSV as multipart/form-data (field: "file") or as Content-Type: text/csv');
  }

  if (!csvText.trim()) return badRequest('Empty file');

  const db = getRawDb();
  try {
    const result = bulkImportLocations(db, auth.tenantId, csvText, auth.sub);
    return ok(result);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
