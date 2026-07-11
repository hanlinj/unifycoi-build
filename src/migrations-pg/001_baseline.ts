// Migration: 001_baseline (Phase 13 — Postgres cutover)
//
// The active baseline src/lib/db/migrate.ts applies. Originally built and proved in Stage 0's
// db-postgres/ scaffolding (now retired — see git history / ADR-013-01); moved here in Stage 1
// once db-core actually runs against it. src/migrations/*.sql (the 17 SQLite migrations) stay
// in place, untouched, as the historical record — nothing runs them anymore.
//
// Fresh baseline, NOT a one-for-one port of src/migrations/001-017 (ADR-013-01: the DB is
// empty, so there is no history to preserve; porting 17 SQLite files forward would also carry
// their SQLite-isms into Postgres DDL and then need a second cleanup pass). This is the
// cumulative END STATE of all 17 SQLite migrations, expressed as idiomatic Postgres:
//   - every ISO-8601 TEXT timestamp column       → timestamptz
//   - every 0/1 INTEGER boolean column            → boolean
//   - every *_json TEXT column                    → jsonb
//   - the two rowid-ordering call sites'
//     dependency (billing_snapshots, audit_events) → a real `seq bigserial`, since Postgres
//     has no stable implicit row-order id (`ctid` is physical-location-based and changes on
//     UPDATE/VACUUM, so it cannot substitute)
// PKs stay `text` (app-generated UUIDs via randomUUID()), not native `uuid` — this is a
// foundation-only pass; switching to a validating column type is a separate, deliberate call
// for a later stage, not bundled in here. No new CHECK constraints were added for the several
// enum-like TEXT columns (documents.state, notifications.status, etc.) that SQLite never
// enforced either — flagged as a considered-but-deferred opportunity, not exercised here, to
// keep this pass a faithful port-with-proper-types, not a redesign.
//
// Table/column inventory verified against all 17 files in src/migrations/ directly (not from
// summary) before writing this.

import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // ─── Platform altitude (no tenant_id) ──────────────────────────────────────
  await db.schema
    .createTable('platform_users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull()) // 'owner' | 'staff'
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('tenants')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('lifecycle_state', 'text', (c) => c.notNull()) // provisioning|active|suspended|offboarded
    .addColumn('monthly_rate_cents', 'integer', (c) => c.notNull().defaultTo(9000))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('applied_template_id', 'text') // 002
    .addColumn('timezone', 'text') // 005 — IANA tz name; NULL = UTC fallback
    .addColumn('stripe_customer_id', 'text') // 013
    .addColumn('slug', 'text') // 014
    .addColumn('stripe_subscription_id', 'text') // 015
    .addColumn('setup_fee_cents', 'integer') // 015
    .addColumn('stripe_setup_intent_id', 'text') // 016
    .execute();
  await db.schema
    .createIndex('idx_tenants_slug')
    .unique()
    .on('tenants')
    .column('slug')
    .execute(); // 014 — Postgres, like SQLite, treats each NULL as distinct under a UNIQUE index

  await db.schema
    .createTable('billing_snapshots')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('billable_locations', 'integer', (c) => c.notNull())
    .addColumn('amount_cents', 'integer', (c) => c.notNull())
    .addColumn('changed', 'boolean', (c) => c.notNull()) // was INTEGER 0/1
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('stripe_synced_at', 'timestamptz') // 015
    // rowid replacement (the flagged fix): a real monotonic tiebreaker for same-millisecond
    // inserts. Ordered ASC/DESC in place of `ORDER BY rowid` at the 3 call sites that read
    // this table (provisioning.ts, locations.ts, quantity-sync.ts).
    .addColumn('seq', 'bigserial', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('requirement_templates')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('payload_json', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();

  // ─── Tenant altitude (all carry tenant_id) ─────────────────────────────────
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull()) // admin|district_manager|store_manager
    .addColumn('password_hash', 'text') // null until invite accepted
    .addColumn('status', 'text', (c) => c.notNull()) // invited|active|disabled
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('invite_sent_at', 'timestamptz') // 017
    .addUniqueConstraint('uq_users_tenant_email', ['tenant_id', 'email'])
    .execute();

  await db.schema
    .createTable('regions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('locations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('region_id', 'text', (c) => c.references('regions.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('address', 'text')
    .addColumn('status', 'text', (c) => c.notNull()) // active|archived
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('user_regions')
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('region_id', 'text', (c) => c.notNull())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('pk_user_regions', ['user_id', 'region_id'])
    .execute();

  await db.schema
    .createTable('user_locations')
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('location_id', 'text', (c) => c.notNull())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('pk_user_locations', ['user_id', 'location_id'])
    .execute();

  await db.schema
    .createTable('vendors')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('business_name', 'text', (c) => c.notNull())
    .addColumn('contact_name', 'text')
    .addColumn('contact_email', 'text')
    .addColumn('contact_phone', 'text')
    .addColumn('trade', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();

  // Per-location status lives here (invariant #5). Overall is derived, never stored.
  await db.schema
    .createTable('vendor_locations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('vendor_id', 'text', (c) => c.notNull().references('vendors.id'))
    .addColumn('location_id', 'text', (c) => c.notNull().references('locations.id'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('flags_json', 'jsonb')
    .addColumn('approved_by', 'text', (c) => c.references('users.id'))
    .addColumn('approved_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('uq_vendor_locations_tenant_vendor_location', ['tenant_id', 'vendor_id', 'location_id'])
    .execute();

  await db.schema
    .createTable('invites')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('vendor_id', 'text', (c) => c.references('vendors.id'))
    .addColumn('inviter_user_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('token', 'text', (c) => c.notNull().unique()) // SHA-256(raw_token) — see 004
    .addColumn('token_expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('purpose', 'text', (c) => c.notNull()) // onboarding|renewal|correction
    .addColumn('delivery_state', 'text', (c) => c.notNull()) // sent|unverified|bounced|expired_invite
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz') // Stage 6a — revoke-on-issue; nullable, null = live
    .execute();
  await db.schema.createIndex('idx_invites_tenant_vendor').on('invites').columns(['tenant_id', 'vendor_id']).execute();

  await db.schema
    .createTable('documents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('vendor_id', 'text', (c) => c.notNull().references('vendors.id'))
    .addColumn('doc_type', 'text', (c) => c.notNull()) // coi|w9|ach|license
    .addColumn('storage_key', 'text', (c) => c.notNull())
    .addColumn('encryption_json', 'jsonb', (c) => c.notNull())
    .addColumn('original_filename', 'text')
    .addColumn('superseded_by', 'text', (c) => c.references('documents.id'))
    .addColumn('uploaded_at', 'timestamptz', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull().defaultTo('active')) // 003
    .addColumn('superseded_at', 'timestamptz') // 007
    .addColumn('purge_eligible', 'boolean', (c) => c.notNull().defaultTo(false)) // 007, was INTEGER
    .addColumn('purge_eligible_at', 'timestamptz') // 007
    .addColumn('key_version', 'integer', (c) => c.notNull().defaultTo(1)) // 012
    .execute();
  await db.schema.createIndex('idx_documents_tenant_vendor').on('documents').columns(['tenant_id', 'vendor_id']).execute();
  await db.schema.createIndex('idx_documents_retention').on('documents').columns(['purge_eligible', 'superseded_at']).execute(); // 007

  // ─── Engine tables: verbatim from AI_Verification_Engine.md ────────────────
  await db.schema
    .createTable('extractions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('document_id', 'text', (c) => c.notNull().references('documents.id'))
    .addColumn('doc_type', 'text', (c) => c.notNull())
    .addColumn('model_id', 'text', (c) => c.notNull())
    .addColumn('extraction_version', 'text', (c) => c.notNull())
    .addColumn('payload_json', 'jsonb', (c) => c.notNull()) // SENSITIVE leaves ciphertext, never logged
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('idx_extractions_tenant_document').on('extractions').columns(['tenant_id', 'document_id']).execute();

  await db.schema
    .createTable('verification_runs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('vendor_id', 'text', (c) => c.notNull().references('vendors.id'))
    .addColumn('trigger', 'text', (c) => c.notNull()) // onboarding|resubmission|renewal|rule_change|location_add
    .addColumn('engine_version', 'text', (c) => c.notNull())
    .addColumn('recommendation', 'text', (c) => c.notNull()) // approve|deficiencies|uncertain
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('idx_verification_runs_tenant_vendor').on('verification_runs').columns(['tenant_id', 'vendor_id']).execute();

  await db.schema
    .createTable('requirement_evaluations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('run_id', 'text', (c) => c.notNull().references('verification_runs.id'))
    .addColumn('vendor_id', 'text', (c) => c.notNull().references('vendors.id'))
    .addColumn('location_id', 'text', (c) => c.notNull().references('locations.id'))
    .addColumn('requirement_key', 'text', (c) => c.notNull())
    .addColumn('required_value', 'text')
    .addColumn('extracted_value_ref', 'text')
    .addColumn('comparison_result', 'text', (c) => c.notNull()) // meets|fails|indeterminate|missing
    .addColumn('confidence_band', 'text') // high|med|low
    .addColumn('outcome', 'text', (c) => c.notNull()) // pass|deficient|uncertain
    .addColumn('note', 'text')
    .execute();

  // ─── Requirements ───────────────────────────────────────────────────────────
  await db.schema
    .createTable('requirement_rules')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('scope_type', 'text', (c) => c.notNull()) // org|trade|location
    .addColumn('scope_ref', 'text')
    .addColumn('requirement_key', 'text', (c) => c.notNull())
    .addColumn('required_value', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('reason', 'text', (c) => c.notNull()) // changes REQUIRE a reason
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('requirement_settings')
    .addColumn('tenant_id', 'text', (c) => c.primaryKey().references('tenants.id'))
    .addColumn('precedence_policy', 'text', (c) => c.notNull().defaultTo('strictest')) // strictest|location|trade
    .addColumn('floor_json', 'jsonb') // 002
    .execute();

  // ─── Audit (append-only / immutable — invariant #10) ───────────────────────
  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('actor_type', 'text', (c) => c.notNull()) // system|ai|user|vendor|platform
    .addColumn('actor_id', 'text')
    .addColumn('event_type', 'text', (c) => c.notNull())
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'text')
    .addColumn('payload_json', 'jsonb') // Sensitive values REDACTED
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('purge_eligible', 'boolean', (c) => c.notNull().defaultTo(false)) // 007, was INTEGER
    .addColumn('purge_eligible_at', 'timestamptz') // 007
    // rowid replacement (the flagged fix) — search.ts's "recently viewed" query orders by
    // this as the tiebreaker instead of `rowid`.
    .addColumn('seq', 'bigserial', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('idx_audit_events_tenant_created').on('audit_events').columns(['tenant_id', 'created_at']).execute();
  await db.schema.createIndex('idx_audit_events_retention').on('audit_events').columns(['purge_eligible', 'created_at']).execute(); // 007

  // ─── Notifications ──────────────────────────────────────────────────────────
  await db.schema
    .createTable('notifications')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('recipient_type', 'text', (c) => c.notNull()) // user|vendor
    .addColumn('recipient_ref', 'text', (c) => c.notNull())
    .addColumn('channel', 'text', (c) => c.notNull().defaultTo('email'))
    .addColumn('kind', 'text', (c) => c.notNull()) // exception|digest
    .addColumn('status', 'text', (c) => c.notNull()) // queued|sent|failed|bounced|sending|superseded
    .addColumn('scheduled_for', 'timestamptz')
    .addColumn('sent_at', 'timestamptz')
    .addColumn('payload_json', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('claimed_at', 'timestamptz') // 006
    .addColumn('document_id', 'text', (c) => c.references('documents.id')) // 006
    .addColumn('provider_message_id', 'text') // 009
    .execute();
  await db.schema.createIndex('idx_notifications_due').on('notifications').columns(['status', 'scheduled_for']).execute(); // 006
  await db.schema.createIndex('idx_notifications_document').on('notifications').columns(['tenant_id', 'document_id']).execute(); // 006
  await db.schema.createIndex('idx_notifications_provider_message_id').on('notifications').column('provider_message_id').execute(); // 009

  // ─── Exports ─────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('audit_exports')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('requested_by', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('scope_type', 'text', (c) => c.notNull()) // vendor|location|region|org|tenant_offboard
    .addColumn('scope_ref', 'text')
    .addColumn('format', 'text', (c) => c.notNull()) // pdf|csv
    .addColumn('includes_sensitive', 'boolean', (c) => c.notNull().defaultTo(false)) // was INTEGER
    .addColumn('status', 'text', (c) => c.notNull()) // queued|generating|ready|failed
    .addColumn('storage_key', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('completed_at', 'timestamptz')
    .addColumn('claimed_at', 'timestamptz') // 008
    .execute();
  await db.schema.createIndex('idx_audit_exports_queue').on('audit_exports').columns(['status', 'created_at']).execute(); // 008

  // ─── Engine advisories (003) ─────────────────────────────────────────────────
  await db.schema
    .createTable('engine_advisories')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('vendor_id', 'text', (c) => c.notNull().references('vendors.id'))
    .addColumn('verification_run_id', 'text', (c) => c.notNull().references('verification_runs.id'))
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('severity', 'text', (c) => c.notNull()) // info|warn
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('evidence_json', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('idx_engine_advisories_tenant_vendor').on('engine_advisories').columns(['tenant_id', 'vendor_id']).execute();

  // ─── Login rate limit (010) — cross-tenant by design ────────────────────────
  await db.schema
    .createTable('login_attempts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('scope_type', 'text', (c) => c.notNull()) // email|ip
    .addColumn('scope_key', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull()) // real timestamptz now — no
    // more string-lexicographic window math (010's own comment flagged this SQLite pattern)
    .execute();
  await db.schema.createIndex('idx_login_attempts_scope').on('login_attempts').columns(['scope_type', 'scope_key', 'created_at']).execute();

  // ─── Password reset / invite / billing-setup tokens (011, purpose added 016) ─
  await db.schema
    .createTable('password_reset_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull().references('tenants.id'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('token_hash', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('purpose', 'text', (c) => c.notNull().defaultTo('reset')) // 016: reset|invite|billing_setup
    .execute();
  await db.schema.createIndex('idx_password_reset_tokens_hash').on('password_reset_tokens').column('token_hash').execute();
  await db.schema.createIndex('idx_password_reset_tokens_user').on('password_reset_tokens').columns(['tenant_id', 'user_id']).execute();

  // ─── Remaining §3-minimum indexes not yet created above ─────────────────────
  await db.schema.createIndex('idx_vendor_locations_tenant_status').on('vendor_locations').columns(['tenant_id', 'status']).execute();
  await db.schema.createIndex('idx_vendors_tenant_business_name').on('vendors').columns(['tenant_id', 'business_name']).execute();
  await db.schema.createIndex('idx_locations_tenant_name').on('locations').columns(['tenant_id', 'name']).execute();

  // no-op reference so `sql` import isn't flagged unused if a future edit removes the one
  // raw-SQL need above; kept available for the next migration that needs it.
  void sql;
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse dependency order.
  const tables = [
    'password_reset_tokens',
    'login_attempts',
    'engine_advisories',
    'audit_exports',
    'notifications',
    'audit_events',
    'requirement_settings',
    'requirement_rules',
    'requirement_evaluations',
    'verification_runs',
    'extractions',
    'documents',
    'invites',
    'vendor_locations',
    'vendors',
    'user_locations',
    'user_regions',
    'locations',
    'regions',
    'users',
    'requirement_templates',
    'billing_snapshots',
    'tenants',
    'platform_users',
  ];
  for (const t of tables) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
