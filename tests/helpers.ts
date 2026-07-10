import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { hashPassword } from '@/lib/auth/password';
import { hashInviteToken } from '@/lib/auth/invite-token';
import type { ProcessedExtraction } from '@/lib/extraction/types';
import type { Db } from '@/lib/db/client';
import { createEphemeralTestDatabase, dropEphemeralTestDatabase } from '@/lib/db/test-isolation';

// Phase 13 migration, Stage 1: setupTestDb()/teardownTestDb() are the new Postgres-based
// per-test isolation primitives (src/lib/db/test-isolation.ts) — see that file's doc comment
// for why this is a two-layer scheme (one ephemeral database per test FILE here; sharing one
// database across the WHOLE jest run needs a jest globalSetup/globalTeardown, deferred until
// more than this one file uses it — not worth the added machinery for a single consumer yet).
//
// Usage (see tests/db-core.pg.test.ts):
//   let db: Db;
//   beforeEach(async () => { db = await setupTestDb(); });
//   afterEach(async () => { await teardownTestDb(db); });
//   afterAll(async () => { await teardownTestDatabase(); });
//
// The seed*()/assign*() helpers below are UNCHANGED (still synchronous, still typed against
// better-sqlite3's Database.Database) — they belong to modules that haven't converted yet.
// Any test file calling both setupTestDb() (now async, returns a Kysely Db) and a seed helper
// (still expects a sync Database.Database) will not compile — expected, per Stage 1's scope:
// only db-core itself converts this stage.

let _ephemeral: Promise<{ name: string; db: Db }> | null = null;

async function sharedEphemeralDatabase(): Promise<{ name: string; db: Db }> {
  if (!_ephemeral) {
    _ephemeral = createEphemeralTestDatabase();
  }
  return _ephemeral;
}

/** Opens a fresh per-test transaction against this file's ephemeral database. Call in beforeEach. */
export async function setupTestDb(): Promise<Db> {
  const { db } = await sharedEphemeralDatabase();
  return db.startTransaction().execute();
}

/** Rolls back the transaction setupTestDb() returned. Call in afterEach. */
export async function teardownTestDb(db: Db): Promise<void> {
  await (db as unknown as { rollback: () => { execute: () => Promise<void> } }).rollback().execute();
}

/** Drops this file's ephemeral database entirely. Call once, in afterAll. */
export async function teardownTestDatabase(): Promise<void> {
  if (!_ephemeral) return;
  const { name, db } = await _ephemeral;
  _ephemeral = null;
  await dropEphemeralTestDatabase(name, db);
}

export function seedPlatformUser(
  db: Database.Database,
  overrides: Partial<{ id: string; email: string; name: string; role: string; password: string }> = {}
): { id: string; email: string; name: string; role: string; password: string } {
  const user = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? 'platform@unifycoi.com',
    name: overrides.name ?? 'Platform Owner',
    role: overrides.role ?? 'owner',
    password: overrides.password ?? 'securepassword123',
  };
  db.prepare(
    'INSERT INTO platform_users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user.id, user.email, user.name, user.role, hashPassword(user.password), new Date().toISOString());
  return user;
}

export function seedTenant(
  db: Database.Database,
  overrides: Partial<{ id: string; name: string; lifecycle_state: string }> = {}
): { id: string; name: string; lifecycle_state: string } {
  const tenant = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Tenant',
    lifecycle_state: overrides.lifecycle_state ?? 'active',
  };
  db.prepare(
    'INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenant.id, tenant.name, tenant.lifecycle_state, 9000, new Date().toISOString());
  return tenant;
}

export function seedTenantUser(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{ id: string; email: string; name: string; role: string; password: string; status: string }> = {}
): { id: string; email: string; name: string; role: string; tenantId: string } {
  const user = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.com`,
    name: overrides.name ?? 'Test User',
    role: overrides.role ?? 'admin',
    status: overrides.status ?? 'active',
    password: overrides.password ?? 'securepassword123',
    tenantId,
  };
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(user.id, tenantId, user.email, user.name, user.role, hashPassword(user.password), user.status, new Date().toISOString());
  return user;
}

export function seedRegion(
  db: Database.Database,
  tenantId: string,
  name = 'North Region'
): { id: string; name: string } {
  const id = randomUUID();
  db.prepare('INSERT INTO regions (id, tenant_id, name) VALUES (?, ?, ?)').run(id, tenantId, name);
  return { id, name };
}

export function seedLocation(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{ id: string; name: string; regionId: string; status: string }> = {}
): { id: string; name: string; tenantId: string } {
  const loc = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? `Store-${randomUUID().slice(0, 6)}`,
    regionId: overrides.regionId ?? null,
    status: overrides.status ?? 'active',
    tenantId,
  };
  db.prepare(
    'INSERT INTO locations (id, tenant_id, region_id, name, address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(loc.id, tenantId, loc.regionId, loc.name, '123 Main St', loc.status, new Date().toISOString());
  return loc;
}

export function assignUserToRegion(db: Database.Database, userId: string, regionId: string, tenantId: string): void {
  db.prepare('INSERT OR IGNORE INTO user_regions (user_id, region_id, tenant_id) VALUES (?, ?, ?)').run(userId, regionId, tenantId);
}

export function assignUserToLocation(db: Database.Database, userId: string, locationId: string, tenantId: string): void {
  db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id, tenant_id) VALUES (?, ?, ?)').run(userId, locationId, tenantId);
}

export function seedRequirementSettings(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{ precedence_policy: string; floor_json: string | null }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO requirement_settings (tenant_id, precedence_policy, floor_json)
     VALUES (?, ?, ?)`
  ).run(
    tenantId,
    overrides.precedence_policy ?? 'strictest',
    overrides.floor_json ?? null
  );
}

export function seedRequirementRule(
  db: Database.Database,
  tenantId: string,
  actorId: string,
  overrides: Partial<{
    id: string;
    scope_type: string;
    scope_ref: string | null;
    requirement_key: string;
    required_value: string;
    reason: string;
  }> = {}
): { id: string; requirement_key: string; required_value: string } {
  const rule = {
    id: overrides.id ?? randomUUID(),
    scope_type: overrides.scope_type ?? 'org',
    scope_ref: overrides.scope_ref ?? null,
    requirement_key: overrides.requirement_key ?? 'coverage.general_liability.each_occurrence',
    required_value: overrides.required_value ?? '1000000',
    reason: overrides.reason ?? 'Test seed',
  };
  db.prepare(
    `INSERT INTO requirement_rules
       (id, tenant_id, scope_type, scope_ref, requirement_key, required_value, created_by, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rule.id, tenantId, rule.scope_type, rule.scope_ref,
    rule.requirement_key, rule.required_value, actorId, rule.reason, new Date().toISOString()
  );
  return rule;
}

export function seedVendor(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{ id: string; business_name: string; trade: string; contact_email: string }> = {}
): { id: string; business_name: string; trade: string; tenantId: string } {
  const vendor = {
    id: overrides.id ?? randomUUID(),
    business_name: overrides.business_name ?? `Test Vendor ${randomUUID().slice(0, 6)}`,
    trade: overrides.trade ?? 'other',
    contact_email: overrides.contact_email ?? null,
    tenantId,
  };
  db.prepare(
    'INSERT INTO vendors (id, tenant_id, business_name, contact_name, contact_email, contact_phone, trade, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(vendor.id, tenantId, vendor.business_name, null, vendor.contact_email, null, vendor.trade, new Date().toISOString());
  return vendor;
}

export function seedVendorLocation(
  db: Database.Database,
  tenantId: string,
  vendorId: string,
  locationId: string,
  overrides: Partial<{ id: string; status: string }> = {}
): { id: string } {
  const vl = {
    id: overrides.id ?? randomUUID(),
    status: overrides.status ?? 'onboarding',
  };
  db.prepare(
    `INSERT OR IGNORE INTO vendor_locations
       (id, tenant_id, vendor_id, location_id, status, flags_json, approved_by, approved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(vl.id, tenantId, vendorId, locationId, vl.status, null, null, null, new Date().toISOString());
  return vl;
}

export function seedInvite(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{
    id: string; vendorId: string; inviterUserId: string; rawToken: string;
    purpose: string; expiresAt: string; deliveryState: string;
  }> = {}
): { id: string; rawToken: string } {
  // rawToken is the bearer token sent to the vendor; the DB stores its SHA-256 hash.
  const rawToken = overrides.rawToken ?? randomUUID();
  const inv = {
    id: overrides.id ?? randomUUID(),
    tokenHash: hashInviteToken(rawToken),
    vendorId: overrides.vendorId ?? null,
    inviterUserId: overrides.inviterUserId ?? randomUUID(),
    purpose: overrides.purpose ?? 'onboarding',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 14 * 86400000).toISOString(),
    deliveryState: overrides.deliveryState ?? 'sent',
  };
  db.prepare(
    `INSERT INTO invites
       (id, tenant_id, vendor_id, inviter_user_id, token, token_expires_at, purpose, delivery_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    inv.id, tenantId, inv.vendorId, inv.inviterUserId,
    inv.tokenHash, inv.expiresAt, inv.purpose, inv.deliveryState, new Date().toISOString()
  );
  return { id: inv.id, rawToken };
}

export function seedDocument(
  db: Database.Database,
  tenantId: string,
  vendorId: string,
  overrides: Partial<{
    id: string; doc_type: string; storage_key: string; state: string;
  }> = {}
): { id: string } {
  const doc = {
    id: overrides.id ?? randomUUID(),
    doc_type: overrides.doc_type ?? 'coi',
    storage_key: overrides.storage_key ?? `tenants/${tenantId}/vendors/${vendorId}/${randomUUID()}`,
    state: overrides.state ?? 'active',
  };
  db.prepare(
    `INSERT INTO documents
       (id, tenant_id, vendor_id, doc_type, storage_key, encryption_json, original_filename, superseded_by, state, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(doc.id, tenantId, vendorId, doc.doc_type, doc.storage_key, '{}', null, null, doc.state, new Date().toISOString());
  return doc;
}

export function seedExtraction(
  db: Database.Database,
  tenantId: string,
  documentId: string,
  payload: ProcessedExtraction,
  overrides: Partial<{ id: string; model_id: string }> = {}
): { id: string } {
  const ext = {
    id: overrides.id ?? randomUUID(),
    model_id: overrides.model_id ?? 'claude-sonnet-4-6',
  };
  db.prepare(
    `INSERT INTO extractions
       (id, tenant_id, document_id, doc_type, model_id, extraction_version, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ext.id, tenantId, documentId, payload.doc_type, ext.model_id, '1', JSON.stringify(payload), new Date().toISOString());
  return ext;
}

export function seedTemplate(
  db: Database.Database,
  overrides: Partial<{ id: string; name: string; payload_json: string }> = {}
): { id: string; name: string } {
  const tpl = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Template',
    payload_json: overrides.payload_json ?? JSON.stringify({
      floor: { 'doc_required.coi': 'true' },
      defaults: { 'doc_required.coi': 'true', 'coverage.general_liability.each_occurrence': '1000000' },
    }),
  };
  db.prepare(
    'INSERT OR IGNORE INTO requirement_templates (id, name, payload_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(tpl.id, tpl.name, tpl.payload_json, new Date().toISOString());
  return tpl;
}
