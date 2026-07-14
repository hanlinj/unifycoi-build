// POST /api/vendors/:id/documents/:documentId/copy — audit-only endpoint for the click-to-copy
// control on a revealed Sensitive field (Gate 2 restyle). The clipboard write itself happens
// entirely client-side (navigator.clipboard.writeText); this route's only job is to record that
// it happened — the copy action previously had no audit trail at all (a real gap: an Admin
// could reveal AND copy a TIN/account number and only the reveal was ever logged). Admin-only,
// same vendor/tenant/field validation as the reveal route, so a copy can't be logged for a
// field/document this session was never authorized to reveal.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound, badRequest } from '@/lib/api';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVEALABLE_FIELDS: Record<string, { docType: 'w9' | 'ach'; label: string }> = {
  tin_value: { docType: 'w9', label: 'TIN' },
  routing_number: { docType: 'ach', label: 'Routing Number' },
  account_number: { docType: 'ach', label: 'Account Number' },
};

interface DocRow {
  id: string;
  vendor_id: string;
  doc_type: string;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string; documentId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role !== 'admin') return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body required');
  }
  const field = typeof (body as Record<string, unknown>)['field'] === 'string'
    ? ((body as Record<string, unknown>)['field'] as string)
    : '';
  const spec = REVEALABLE_FIELDS[field];
  if (!spec) {
    return badRequest(`field must be one of: ${Object.keys(REVEALABLE_FIELDS).join(', ')}`);
  }

  const db = getDb();
  const tdb = new TenantDB(db, auth.tenantId);

  const doc = await tdb.get<DocRow>(
    `SELECT id, vendor_id, doc_type FROM documents WHERE tenant_id = $1 AND id = $2 AND vendor_id = $3`,
    [params.documentId, params.id]
  );
  if (!doc) return notFound('Document not found');
  if (doc.doc_type !== spec.docType) {
    return badRequest(`field '${field}' is not applicable to a ${doc.doc_type} document`);
  }

  // Never log the value — only which field, on which document, by whom, when.
  await logAudit(db, {
    tenantId: auth.tenantId,
    actorType: 'user',
    actorId: auth.sub,
    eventType: 'document.sensitive_field_copied',
    targetType: 'document',
    targetId: doc.id,
    payload: { field, label: spec.label },
  });

  return NextResponse.json({ data: { ok: true } });
}
