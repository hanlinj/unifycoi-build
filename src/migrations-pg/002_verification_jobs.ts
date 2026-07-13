// Migration: 002_verification_jobs
//
// Background-verification queue table (Option A from the recon checkpoint): decouples Vision
// extraction + runVerification() from the vendor's upload/submit request path. Same shape as
// the existing queue tables (notifications, audit_exports) — claim-then-process via an atomic
// UPDATE ... WHERE status='queued', reclaim-on-stale-claim, tenant-scoped.

import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('verification_jobs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('vendor_id', 'text', (c) => c.notNull().references('vendors.id'))
    .addColumn('trigger', 'text', (c) => c.notNull()) // onboarding|resubmission|renewal|rule_change|location_add
    .addColumn('status', 'text', (c) => c.notNull()) // queued|processing|done|failed
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('completed_at', 'timestamptz')
    .addColumn('claimed_at', 'timestamptz')
    .execute();
  // Same queue-scan shape as idx_audit_exports_queue.
  await db.schema.createIndex('idx_verification_jobs_queue').on('verification_jobs').columns(['status', 'created_at']).execute();
  // Vendor-profile lookup ("is a job pending for this vendor") — cheap, tenant-scoped.
  await db.schema.createIndex('idx_verification_jobs_tenant_vendor').on('verification_jobs').columns(['tenant_id', 'vendor_id']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('verification_jobs').ifExists().execute();
}
