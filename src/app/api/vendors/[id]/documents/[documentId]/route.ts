// GET /api/vendors/:id/documents/:documentId — serve a stored document's decrypted bytes for
// in-page viewing (Gate 2, Stage 3). Admin-only; every view is an audited access event.
//
// Decrypt pattern: BlobStore.get() + decrypt, same shape as /api/exports/[id]/download — but
// documents use a DIFFERENT encryption scheme than exports. Exports are packed with
// packEncrypted()/unpackEncrypted() (src/lib/crypto/envelope-file.ts), a self-contained format
// with the key material embedded in the blob itself. Documents are encrypted per-row via
// encryptForStorage()/decryptFromStorage() (src/lib/crypto/envelope.ts) — a separate data key
// wrapped by the master KEK, with the wrap metadata stored in documents.encryption_json, not
// in the blob. This route uses decryptFromStorage() + encryption_json, the same pair the
// upload route (src/app/api/v/[token]/documents/route.ts) and the verification worker
// (src/lib/verification/worker.ts) already use to write/read this exact data — not
// unpackEncrypted(), which is the wrong function for this table's encryption format.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound } from '@/lib/api';
import { getBlobStore } from '@/lib/blob';
import { decryptFromStorage, type EncryptionMeta } from '@/lib/crypto/envelope';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DocRow {
  id: string;
  vendor_id: string;
  doc_type: string;
  storage_key: string;
  encryption_json: EncryptionMeta; // jsonb — already parsed (invariant 2)
}

export async function GET(
  request: Request,
  { params }: { params: { id: string; documentId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();
  if (auth.role !== 'admin') return forbidden();

  const db = getDb();
  const tdb = new TenantDB(db, auth.tenantId);

  // vendor_id in the WHERE (not just tenant_id) — a documentId belonging to a different vendor
  // in the SAME tenant must 404 here too, not just cross-tenant ones.
  const doc = await tdb.get<DocRow>(
    `SELECT id, vendor_id, doc_type, storage_key, encryption_json
     FROM documents
     WHERE tenant_id = $1 AND id = $2 AND vendor_id = $3`,
    [params.documentId, params.id]
  );
  if (!doc) return notFound('Document not found');

  const ciphertext = await getBlobStore().get(doc.storage_key);
  const pdfBytes = decryptFromStorage(ciphertext, doc.encryption_json);

  // Viewing a document's contents is itself an audited access event (defensibility) — distinct
  // from vendor.viewed (viewing the vendor RECORD page), which already exists.
  await logAudit(db, {
    tenantId: auth.tenantId,
    actorType: 'user',
    actorId: auth.sub,
    eventType: 'document.viewed',
    targetType: 'document',
    targetId: doc.id,
    payload: { vendor_id: doc.vendor_id, doc_type: doc.doc_type },
  });

  return new NextResponse(new Uint8Array(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      // inline, not attachment: this is rendered in-page (the profile's document accordion),
      // not downloaded.
      'Content-Disposition': `inline; filename="${doc.doc_type}-${doc.id}.pdf"`,
    },
  });
}
