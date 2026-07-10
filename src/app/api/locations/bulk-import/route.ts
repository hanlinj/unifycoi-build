// POST /api/locations/bulk-import — creates locations + dormant managers from an already-edited,
// already-validated table (Slice 12/5b, Feature 1). Distinct from the older
// /api/locations/import (CSV-text-in, creates-in-one-shot behind a preview-and-approve gate,
// Phase 2, left untouched) — this is the "submit" side of the new editable-form UX. Rows are
// JSON, not a raw file: the operator may have hand-edited them after an upload, or typed them
// from scratch.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden } from '@/lib/api';
import { validateTable, type ImportLocationRow } from '@/lib/import/location-rows';
import { bulkCreateLocationsWithManagers } from '@/lib/services/bulk-onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return badRequest('rows (array) is required');

  // Defensive re-validation — never trust the client's own inline validation alone.
  const table = validateTable(rows as ImportLocationRow[]);
  if (!table.isClean) return badRequest('Some rows are invalid — fix them before submitting.');
  if (table.nonBlankRows.length === 0) return badRequest('Add at least one location.');

  const db = getRawDb();
  const result = bulkCreateLocationsWithManagers(db, auth.tenantId, table.nonBlankRows, auth.sub);
  return ok(result);
}
