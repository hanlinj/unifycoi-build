// POST /api/vendors/:id/documents/:documentId/reveal — decrypt and return ONE Sensitive field
// from a document's stored extraction (W-9 TIN, ACH routing/account number). Gate 2, Stage 3.
// Admin-only. Masked is the default state on every page load; this is the explicit click-to-
// reveal action, and every reveal is its own audited event — never the mask/view itself.
//
// Reuses decryptField() (src/lib/crypto/field.ts), the same field-level decrypt the audit
// export's Sensitive-included manifest already uses (src/lib/exports/content.ts's
// decryptedSensitiveFor) — same ciphertext, same key, just a single named field instead of a
// whole-document manifest line.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound, badRequest } from '@/lib/api';
import { decryptField } from '@/lib/crypto/field';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Explicit allow-list — never reveal an arbitrary payload_json path, only these three known
// Sensitive leaves, and only from the doc_type they actually belong to.
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

interface ExtractionRow {
  payload_json: Record<string, { value?: string | null }>; // jsonb — already parsed (invariant 2)
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

  const extraction = await tdb.get<ExtractionRow>(
    `SELECT payload_json FROM extractions WHERE tenant_id = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [doc.id]
  );
  const ciphertext = extraction?.payload_json?.[field]?.value ?? null;
  if (!ciphertext) return notFound('Field not extracted for this document');

  let value: string;
  try {
    value = decryptField(ciphertext);
  } catch {
    return NextResponse.json({ error: 'Could not decrypt field' }, { status: 500 });
  }

  // Never log the decrypted (or ciphertext) value — only which field, on which document, by
  // whom, when (invariants #8/#10).
  await logAudit(db, {
    tenantId: auth.tenantId,
    actorType: 'user',
    actorId: auth.sub,
    eventType: 'document.sensitive_field_revealed',
    targetType: 'document',
    targetId: doc.id,
    payload: { field, label: spec.label },
  });

  return NextResponse.json({ data: { value } });
}
