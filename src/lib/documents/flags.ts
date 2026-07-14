// Document-level "needs replacement" flag — the shared spine between the admin panel (writer)
// and the vendor landing gate (reader) for document-targeted correction/resend. Vendor-level
// and per-document, NOT per-location (invariant #5 is about vendor_locations.status, which this
// never touches — see decision.ts's request_correction, which stays vendor-level per its own
// revert).
//
// The flag is a new documents.state value, FLAGGED_STATE = 'correction_requested', on the
// column that's already unconstrained text (no CHECK constraint) — no migration needed for the
// flag itself. The admin's free-text note has nowhere to live in the existing schema, so
// migration 003 added documents.flag_note (nullable text).
//
// Lifecycle coupling to supersedePriorDocument() (Stage 1): a flagged document is still the
// "current" row for its doc_type (superseded_by IS NULL) until a replacement is uploaded and
// extracted. supersedePriorDocument()'s prior-document lookup matches state IN ('active',
// 'correction_requested') specifically so a flagged row is a valid supersession target — once
// superseded, it drops out of getFlaggedDocuments()'s result (which requires superseded_by IS
// NULL), auto-clearing the flag without ever touching the old row's state/flag_note. The new
// document is always inserted with state='active' by the upload route, so it never carries the
// flag forward.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import type { DocType } from '@/lib/extraction/types';

export const FLAGGED_STATE = 'correction_requested';

export interface FlagDocumentsInput {
  tenantId: string;
  vendorId: string;
  docTypes: DocType[];
  note?: string | null; // optional — the admin panel encourages but doesn't require one
}

export interface FlagDocumentsResult {
  flagged: DocType[];
  skipped: DocType[]; // no active/flagged document of this type to flag
}

/**
 * Mark the current document (state IN ('active', 'correction_requested'), superseded_by IS
 * NULL) of each doc_type as needing replacement, persisting the admin's note against it.
 * Idempotent — re-flagging an already-flagged document just overwrites its note. doc_types
 * with no current document are reported in `skipped`, not thrown on (a partial vendor upload
 * mid-onboarding is a normal state, not an error).
 */
export async function flagDocumentsForReplacement(
  db: Db,
  input: FlagDocumentsInput,
  now: Date = new Date()
): Promise<FlagDocumentsResult> {
  const { tenantId, vendorId, docTypes, note } = input;
  const trimmedNote = note?.trim() || null;

  const tdb = new TenantDB(db, tenantId);
  const flagged: DocType[] = [];
  const skipped: DocType[] = [];

  for (const docType of docTypes) {
    const current = await tdb.get<{ id: string }>(
      `SELECT id FROM documents
       WHERE tenant_id = $1 AND vendor_id = $2 AND doc_type = $3
         AND superseded_by IS NULL AND state IN ('active', '${FLAGGED_STATE}')
       ORDER BY uploaded_at DESC LIMIT 1`,
      [vendorId, docType]
    );

    if (!current) {
      skipped.push(docType);
      continue;
    }

    await tdb.update(
      'documents',
      { state: FLAGGED_STATE, flag_note: trimmedNote },
      { id: current.id }
    );
    flagged.push(docType);
  }

  void now; // reserved for a future flagged_at column if the landing page/UI needs one
  return { flagged, skipped };
}

export interface FlaggedDocument {
  documentId: string;
  docType: DocType;
  note: string | null;
}

/**
 * Which document types (if any) are currently flagged as needing replacement for this vendor,
 * with their notes. Only ever returns currently-active flagged rows (superseded_by IS NULL) —
 * once a flagged document is superseded by a replacement, it stops appearing here even though
 * its own state/flag_note remain 'correction_requested'/populated as a historical record.
 */
export async function getFlaggedDocuments(
  db: Db,
  tenantId: string,
  vendorId: string
): Promise<FlaggedDocument[]> {
  const tdb = new TenantDB(db, tenantId);

  const rows = await tdb.all<{ id: string; doc_type: DocType; flag_note: string | null }>(
    `SELECT id, doc_type, flag_note FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND superseded_by IS NULL AND state = $3
     ORDER BY doc_type`,
    [vendorId, FLAGGED_STATE]
  );

  return rows.map((r) => ({ documentId: r.id, docType: r.doc_type, note: r.flag_note }));
}
