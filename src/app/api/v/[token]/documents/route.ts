// POST /api/v/:token/documents
// Vendor document upload endpoint (tokenized — no login required).
//
// Flow:
//   1. Validate vendor invite token
//   2. Accept multipart/form-data upload (field: 'file', field: 'doc_type')
//   3. Envelope-encrypt → BlobStore → write documents row
//   4. Run Vision extraction → write extractions row → audit document.extracted
//   5. Expiration gate (post-extraction, pre-verification-run) — invariant #6
//   6. If expired: mark document bounced_expired, return 422
//   7. Return 201 with document id (vendor submits separately via /submit)

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getRawDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { getBlobStore, documentKey } from '@/lib/blob';
import { encryptForStorage } from '@/lib/crypto/envelope';
import { logAudit } from '@/lib/audit';
import { extractDocument, checkExpirationGate } from '@/lib/extraction/extractor';
import { env } from '@/lib/env';
import type { DocType } from '@/lib/extraction/types';
import type { ProcessedCOIExtraction } from '@/lib/extraction/types';

interface InviteRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  token_expires_at: string;
  purpose: string;
  delivery_state: string;
}

const ALLOWED_DOC_TYPES: DocType[] = ['coi', 'w9', 'ach'];

export async function POST(
  request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getRawDb();
  const { token } = params;

  // Validate vendor invite token
  const invite = db
    .prepare(
      `SELECT id, tenant_id, vendor_id, token_expires_at, purpose, delivery_state
       FROM invites WHERE token = ?`
    )
    .get(token) as InviteRow | undefined;

  if (!invite) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }
  if (new Date(invite.token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'Token has expired' }, { status: 401 });
  }
  if (invite.delivery_state === 'bounced' || invite.delivery_state === 'expired_invite') {
    return NextResponse.json({ error: 'Invite no longer valid' }, { status: 401 });
  }

  // Parse multipart upload
  let fileBytes: Buffer;
  let docType: DocType;

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

    fileBytes = Buffer.from(await fileEntry.arrayBuffer());
    docType = docTypeEntry as DocType;
  } catch {
    return NextResponse.json({ error: 'Failed to parse upload' }, { status: 400 });
  }

  const tenantId = invite.tenant_id;
  const vendorId = invite.vendor_id;
  const tdb = new TenantDB(db, tenantId);
  const documentId = randomUUID();

  // Envelope-encrypt and store in BlobStore
  const { ciphertext, meta } = encryptForStorage(fileBytes);
  const storageKey = documentKey(tenantId, vendorId, documentId);

  try {
    await getBlobStore().put(storageKey, ciphertext);
  } catch {
    return NextResponse.json({ error: 'Storage error' }, { status: 503 });
  }

  // Write documents row (state='active' by default)
  tdb.insert('documents', {
    id: documentId,
    vendor_id: vendorId,
    doc_type: docType,
    storage_key: storageKey,
    encryption_json: JSON.stringify(meta),
    original_filename: null,
    superseded_by: null,
    state: 'active',
    uploaded_at: new Date().toISOString(),
  });

  // Run Vision extraction
  let extraction;
  try {
    extraction = await extractDocument(fileBytes, docType);
  } catch (err) {
    // Extraction failure — don't lose the upload; return error
    return NextResponse.json(
      { error: 'Document extraction failed', detail: (err as Error).message },
      { status: 422 }
    );
  }

  // Write extractions row (sensitive fields are already ciphertext in the payload)
  const extractionId = randomUUID();
  tdb.insert('extractions', {
    id: extractionId,
    document_id: documentId,
    doc_type: docType,
    model_id: extraction.modelId,
    extraction_version: env.anthropic.extractionSchemaVersion,
    payload_json: JSON.stringify(extraction.payload),
    created_at: new Date().toISOString(),
  });

  // Audit: document.extracted (sensitive values are already encrypted in payload)
  logAudit(db, {
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
      document_type_confirmed: (extraction.payload as { document_type_confirmed?: string }).document_type_confirmed,
    },
  });

  // Expiration gate — fires AFTER extraction, BEFORE verification run (invariant #6)
  if (docType === 'coi') {
    const gate = checkExpirationGate(extraction.payload as ProcessedCOIExtraction);
    if (!gate.passed) {
      // Mark document as bounced_expired
      tdb.update('documents', { state: 'bounced_expired' }, { id: documentId });

      logAudit(db, {
        tenantId,
        actorType: 'system',
        actorId: 'expiration-gate',
        eventType: 'document.bounced_expired',
        targetType: 'document',
        targetId: documentId,
        payload: {
          vendor_id: vendorId,
          expired_policies: gate.expiredPolicies,
        },
      });

      return NextResponse.json(
        {
          error: 'Document rejected: one or more policies are expired',
          expired_policies: gate.expiredPolicies,
          document_id: documentId,
        },
        { status: 422 }
      );
    }
  }

  return NextResponse.json(
    {
      data: {
        document_id: documentId,
        doc_type: docType,
        extraction_id: extractionId,
        escalated: extraction.escalated,
      },
    },
    { status: 201 }
  );
}
