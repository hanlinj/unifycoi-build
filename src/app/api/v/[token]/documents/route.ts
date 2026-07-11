// POST /api/v/:token/documents
// Vendor document upload (tokenized — no login required).
// Token lookup is always by SHA-256 hash of the raw bearer token.
//
// Flow:
//   1. Validate invite token (hash lookup, uniform 401 on failure)
//   2. Parse multipart/form-data (fields: file, doc_type)
//   3. Enforce size cap (25 MB); detect file type by magic bytes
//   4. If image (JPEG/PNG/HEIC): convert to single-page PDF via sharp + pdf-lib
//   5. Envelope-encrypt PDF → BlobStore.put (ciphertext only; plaintext never at rest)
//   6. Write documents row
//   7. Run Vision extraction → write extractions row → audit document.extracted
//   8. Expiration gate (COI only) — expired policy bounced here, never reaches Admin
//   9. Return 201 with document_id

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { getBlobStore, documentKey } from '@/lib/blob';
import { encryptForStorage } from '@/lib/crypto/envelope';
import { logAudit } from '@/lib/audit';
import { queueNotification } from '@/lib/notifications/queue';
import { earliestExpiration, handleCoiUploadChase } from '@/lib/notifications/renewal';
import { extractDocument, checkExpirationGate } from '@/lib/extraction/extractor';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import {
  detectFileType,
  withinSizeLimit,
  MAX_UPLOAD_BYTES,
  ERR_FILE_SIZE,
  ERR_FILE_TYPE,
} from '@/lib/upload/validate';
import { convertImageToPdf } from '@/lib/upload/convert';
import { env } from '@/lib/env';
import type { DocType } from '@/lib/extraction/types';
import type { ProcessedCOIExtraction } from '@/lib/extraction/types';

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

  // Vision extraction (operates on PDF bytes)
  let extraction;
  try {
    extraction = await extractDocument(pdfBytes, docType);
  } catch (err) {
    return NextResponse.json(
      { error: 'Document extraction failed', detail: (err as Error).message },
      { status: 422 }
    );
  }

  const extractionId = randomUUID();
  await tdb.insert('extractions', {
    id: extractionId,
    document_id: documentId,
    doc_type: docType,
    model_id: extraction.modelId,
    extraction_version: env.anthropic.extractionSchemaVersion,
    payload_json: JSON.stringify(extraction.payload),
    created_at: new Date(),
  });

  await logAudit(db, {
    tenantId,
    actorType: 'ai',
    actorId: `engine/${extraction.modelId}`,
    eventType: 'document.extracted',
    targetType: 'document',
    targetId: documentId,
    payload: {
      doc_type: docType,
      extraction_id: extractionId,
      model_id: extraction.modelId,
      escalated: extraction.escalated,
      converted_from: fileType !== 'pdf' ? fileType : undefined,
    },
  });

  // Expiration gate — COI only; fires after extraction, before any verification run (invariant #6)
  if (docType === 'coi') {
    const gate = checkExpirationGate(extraction.payload as ProcessedCOIExtraction);
    if (!gate.passed) {
      await tdb.update('documents', { state: 'bounced_expired' }, { id: documentId });

      await logAudit(db, {
        tenantId,
        actorType: 'system',
        actorId: 'expiration-gate',
        eventType: 'document.bounced_expired',
        targetType: 'document',
        targetId: documentId,
        payload: { vendor_id: vendorId, expired_policies: gate.expiredPolicies },
      });

      // Vendor-facing exception (immediate): the expired upload bounces back to the vendor,
      // never to the Admin (invariant #6). They see the 422 in-session; the email is the
      // durable nudge if they close the tab. Recipient is the vendor's contact email.
      const vrow = await tdb.get<{ contact_email: string | null }>(
        'SELECT contact_email FROM vendors WHERE tenant_id = $1 AND id = $2',
        [vendorId]
      );
      if (vrow?.contact_email) {
        await queueNotification(db, tenantId, {
          recipientType: 'vendor',
          recipientRef: vrow.contact_email,
          kind: 'exception',
          payload: {
            type: 'document_bounced_expired',
            vendor_id: vendorId,
            doc_type: docType,
            expired_policies: gate.expiredPolicies,
          },
        });
      }

      return NextResponse.json(
        {
          error: 'Document rejected: one or more policies are expired',
          expired_policies: gate.expiredPolicies,
          document_id: documentId,
        },
        { status: 422 }
      );
    }

    // Gate passed → eager-schedule the renewal ladder against this COI's earliest
    // expiration, and (renewal upload) supersede any prior COI's unfired reminders.
    const coiPayload = extraction.payload as ProcessedCOIExtraction;
    const expDate = earliestExpiration(coiPayload);
    if (expDate) {
      await handleCoiUploadChase(db, {
        tenantId,
        vendorId,
        newDocumentId: documentId,
        expirationDate: expDate,
      });
    }
  }

  return NextResponse.json(
    {
      data: {
        document_id: documentId,
        doc_type: docType,
        extraction_id: extractionId,
        escalated: extraction.escalated,
        converted_from: fileType !== 'pdf' ? fileType : undefined,
      },
    },
    { status: 201 }
  );
}
