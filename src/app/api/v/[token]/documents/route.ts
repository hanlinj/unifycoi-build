// POST /api/v/:token/documents
// Vendor document upload (tokenized — no login required).
// Token lookup is always by SHA-256 hash of the raw bearer token.
//
// Flow (store only, fast — the vendor never waits on Vision):
//   1. Validate invite token (hash lookup, uniform 401 on failure)
//   2. Parse multipart/form-data (fields: file, doc_type)
//   3. Enforce size cap (25 MB); detect file type by magic bytes — cheap, synchronous, so a
//      bad file still gets instant feedback
//   4. If image (JPEG/PNG/HEIC): convert to single-page PDF via sharp + pdf-lib
//   5. Envelope-encrypt PDF → BlobStore.put (ciphertext only; plaintext never at rest)
//   6. Write documents row
//   7. Return 201 with document_id
//
// Vision extraction (extractDocument), the expiration gate, and renewal-chase scheduling all
// moved to the background verification worker (src/lib/verification/worker.ts) — they used to
// run inline here (await extractDocument(...), 20-40s per file) and now run once per submit,
// after the vendor has already moved on. See that file's module doc for the expiration-gate
// bounce-back behavior this relocation required.

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { getBlobStore, documentKey } from '@/lib/blob';
import { encryptForStorage } from '@/lib/crypto/envelope';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import {
  detectFileType,
  withinSizeLimit,
  MAX_UPLOAD_BYTES,
  ERR_FILE_SIZE,
  ERR_FILE_TYPE,
} from '@/lib/upload/validate';
import { convertImageToPdf } from '@/lib/upload/convert';
import type { DocType } from '@/lib/extraction/types';

const ALLOWED_DOC_TYPES: DocType[] = ['coi', 'w9', 'ach'];

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getDb();
  const validated = await validateInviteToken(db, params.token);

  if (!validated) {
    return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 401 });
  }

  const { invite } = validated;
  const tenantId = invite.tenant_id;
  const vendorId = invite.vendor_id;

  // Parse multipart upload
  let rawBytes: Buffer;
  let docType: DocType;
  let originalFilename: string | null = null;

  try {
    const formData = await request.formData();
    const fileEntry = formData.get('file');
    const docTypeEntry = formData.get('doc_type') as string | null;

    if (!fileEntry || !(fileEntry instanceof Blob)) {
      return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
    }
    if (!docTypeEntry || !ALLOWED_DOC_TYPES.includes(docTypeEntry as DocType)) {
      return NextResponse.json(
        { error: `doc_type must be one of: ${ALLOWED_DOC_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    rawBytes = Buffer.from(await fileEntry.arrayBuffer());
    docType = docTypeEntry as DocType;
    if (fileEntry instanceof File) originalFilename = fileEntry.name ?? null;
  } catch {
    return NextResponse.json({ error: 'Failed to parse upload' }, { status: 400 });
  }

  // Size cap — checked before any further processing (25 MB; headroom for phone photos)
  if (!withinSizeLimit(rawBytes)) {
    return NextResponse.json({ error: ERR_FILE_SIZE }, { status: 413 });
  }

  // File-type detection by magic bytes — extension and Content-Type header are ignored
  const fileType = detectFileType(rawBytes);
  if (!fileType) {
    return NextResponse.json({ error: ERR_FILE_TYPE }, { status: 422 });
  }

  // Normalise to PDF — every downstream artifact (extraction, storage, engine) is PDF-only
  let pdfBytes: Buffer;
  try {
    pdfBytes = fileType === 'pdf' ? rawBytes : await convertImageToPdf(rawBytes);
  } catch (err) {
    return NextResponse.json(
      { error: 'Could not process image', detail: (err as Error).message },
      { status: 422 }
    );
  }

  const tdb = new TenantDB(db, tenantId);
  const documentId = randomUUID();

  // Envelope-encrypt and write to BlobStore (ciphertext only; plaintext never at rest)
  const { ciphertext, meta } = encryptForStorage(pdfBytes);
  const storageKey = documentKey(tenantId, vendorId, documentId);

  try {
    await getBlobStore().put(storageKey, ciphertext);
  } catch {
    return NextResponse.json({ error: 'Storage error' }, { status: 503 });
  }

  await tdb.insert('documents', {
    id: documentId,
    vendor_id: vendorId,
    doc_type: docType,
    storage_key: storageKey,
    encryption_json: JSON.stringify(meta),
    original_filename: originalFilename,
    superseded_by: null,
    state: 'active',
    uploaded_at: new Date(),
  });

  return NextResponse.json(
    {
      data: {
        document_id: documentId,
        doc_type: docType,
        converted_from: fileType !== 'pdf' ? fileType : undefined,
      },
    },
    { status: 201 }
  );
}
