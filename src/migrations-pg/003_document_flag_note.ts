// Migration: 003_document_flag_note
//
// Adds the per-document admin note for the "needs replacement" flag (Stage 2 of the
// document-targeted correction/resend loop). The flag itself needs no new column — documents.
// state is unconstrained text (no CHECK constraint), so a new value ('correction_requested')
// is introduced purely at the application layer. But the admin's free-text note has nowhere to
// live today, so this adds one nullable column to carry it.

import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('documents')
    .addColumn('flag_note', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('documents')
    .dropColumn('flag_note')
    .execute();
}
