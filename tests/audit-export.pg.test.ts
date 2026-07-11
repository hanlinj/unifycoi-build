// tests/audit-export.pg.test.ts — Phase 13 migration, Stage 8c: verifies
// exports/{content,audit-export,worker}.ts and the exports API routes' service calls against
// real Postgres. Conversion pass-through, the jsonb payload_json re-stringify-for-display
// correctness (content.ts's events mapping), and the Sensitive-decrypt path (never
// JSON.parse()s the jsonb extractions.payload_json read — invariant 2).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { createAuditExport, generateExportArtifact, scopeAuditEvents } from '@/lib/exports/audit-export';
import { gatherAuditExportContent } from '@/lib/exports/content';
import { processQueuedExports } from '@/lib/exports/worker';
import { encryptField } from '@/lib/crypto/field';
import type { Db } from '@/lib/db/client';

async function seedTenant(db: Db): Promise<string> {
  const id = randomUUID();
  await db.insertInto('tenants').values({
    id, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date(),
  }).execute();
  return id;
}

async function seedUser(db: Db, tenantId: string, overrides: Partial<{ role: string }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('users').values({
    id, tenant_id: tenantId, email: `${id}@x.test`, name: 'Actor', role: overrides.role ?? 'admin',
    password_hash: null, status: 'active', created_at: new Date(),
  }).execute();
  return id;
}

async function seedVendor(db: Db, tenantId: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('vendors').values({
    id, tenant_id: tenantId, business_name: 'Acme Fire Safety', trade: 'fire_suppression', created_at: new Date(),
  }).execute();
  return id;
}

async function seedLocation(db: Db, tenantId: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('locations').values({ id, tenant_id: tenantId, name: 'Store 1', status: 'active', created_at: new Date() }).execute();
  return id;
}

async function seedVendorLocation(db: Db, tenantId: string, vendorId: string, locationId: string, status = 'approved'): Promise<void> {
  await db.insertInto('vendor_locations').values({
    id: randomUUID(), tenant_id: tenantId, vendor_id: vendorId, location_id: locationId, status, created_at: new Date(),
  }).execute();
}

async function seedDocument(db: Db, tenantId: string, vendorId: string, docType = 'coi'): Promise<string> {
  const id = randomUUID();
  await db.insertInto('documents').values({
    id, tenant_id: tenantId, vendor_id: vendorId, doc_type: docType, storage_key: `k-${id}`,
    encryption_json: JSON.stringify({}), uploaded_at: new Date(), state: 'active', superseded_by: null,
  }).execute();
  return id;
}

async function seedAuditEvent(db: Db, tenantId: string, overrides: Partial<{ target_type: string; target_id: string; event_type: string; payload: Record<string, unknown> | null }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('audit_events').values({
    id, tenant_id: tenantId, actor_type: 'system', actor_id: 'fixture',
    event_type: overrides.event_type ?? 'test.fixture',
    target_type: overrides.target_type ?? null, target_id: overrides.target_id ?? null,
    payload_json: overrides.payload !== undefined ? JSON.stringify(overrides.payload) : null,
    created_at: new Date(),
  }).execute();
  return id;
}

describe('db-core (Stage 8c): exports/audit-export.ts createAuditExport', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('sync scope (vendor) generates immediately and returns ready', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });
    const vendorId = await seedVendor(db, tenantId);

    const result = await createAuditExport({
      db, tenantId, requestedBy: adminId, scope: 'vendor', scopeRef: vendorId,
      format: 'csv', includesSensitive: false, reason: null,
    });
    expect(result.status).toBe('ready');

    const row = await db.selectFrom('audit_exports').selectAll().where('id', '=', result.exportId).executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
    expect(row.storage_key).not.toBeNull();

    const audit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'export.generated').where('target_id', '=', result.exportId).executeTakeFirstOrThrow();
    expect((audit.payload_json as { mode: string }).mode).toBe('sync');
  });

  test('async scope (org) is queued, not generated yet', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });

    const result = await createAuditExport({
      db, tenantId, requestedBy: adminId, scope: 'org', scopeRef: null,
      format: 'pdf', includesSensitive: false, reason: null,
    });
    expect(result.status).toBe('queued');

    const row = await db.selectFrom('audit_exports').selectAll().where('id', '=', result.exportId).executeTakeFirstOrThrow();
    expect(row.status).toBe('queued');
    expect(row.storage_key).toBeNull();
  });

  test('includesSensitive requires a reason of at least 10 chars, and logs export.sensitive_included', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });
    const vendorId = await seedVendor(db, tenantId);

    await expect(createAuditExport({
      db, tenantId, requestedBy: adminId, scope: 'vendor', scopeRef: vendorId,
      format: 'csv', includesSensitive: true, reason: 'too short',
    })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });

    const result = await createAuditExport({
      db, tenantId, requestedBy: adminId, scope: 'vendor', scopeRef: vendorId,
      format: 'csv', includesSensitive: true, reason: 'a sufficiently long compliance reason',
    });
    const audit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'export.sensitive_included').where('target_id', '=', result.exportId).executeTakeFirstOrThrow();
    expect((audit.payload_json as { reason: string }).reason).toContain('compliance reason');
  });
});

describe('db-core (Stage 8c): exports/content.ts gatherAuditExportContent', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('builds metadata/posture/events/documents for a vendor scope', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const locationId = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');
    await seedDocument(db, tenantId, vendorId, 'coi');
    await seedAuditEvent(db, tenantId, { target_type: 'vendor', target_id: vendorId, event_type: 'vendor.approved', payload: { note: 'ok' } });

    const content = await gatherAuditExportContent(db, tenantId, {
      scope: 'vendor', scopeRef: vendorId, includesSensitive: false,
      generatedAt: new Date().toISOString(), generator: null,
    });

    expect(content.metadata.find((m) => m.label === 'Scope')?.value).toBe(`vendor (${vendorId})`);
    expect(content.posture.find((p) => p.metric === 'Approved')?.value).toBe('1');
    expect(content.documents).toHaveLength(1);
    expect(content.documents[0]?.doc_type).toBe('coi');

    // jsonb payload_json comes back parsed; content.ts must re-stringify it for the rendered
    // CSV/PDF text cell (invariant 9's write-side re-stringify), never JSON.parse() on read.
    const ev = content.events.find((e) => e.event_type === 'vendor.approved');
    expect(ev).toBeDefined();
    expect(typeof ev!.payload_json).toBe('string');
    expect(JSON.parse(ev!.payload_json)).toEqual({ note: 'ok' });
  });

  test('org scope pulls the complete tenant audit trail via scopeAuditEvents', async () => {
    const tenantId = await seedTenant(db);
    await seedAuditEvent(db, tenantId, { event_type: 'tenant.created' });
    await seedAuditEvent(db, tenantId, { event_type: 'tenant.settings_changed' });

    const events = await scopeAuditEvents(db, tenantId, 'org', null);
    expect(events).toHaveLength(2);
  });

  test('Sensitive opt-in decrypts TIN for a w9 document; opt-out omits it entirely', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const locationId = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId);
    const docId = await seedDocument(db, tenantId, vendorId, 'w9');
    await db.insertInto('extractions').values({
      id: randomUUID(), tenant_id: tenantId, document_id: docId, doc_type: 'w9', model_id: 'test',
      extraction_version: '1', created_at: new Date(),
      payload_json: JSON.stringify({ tin_value: { value: encryptField('12-3456789') } }),
    }).execute();

    const withSensitive = await gatherAuditExportContent(db, tenantId, {
      scope: 'vendor', scopeRef: vendorId, includesSensitive: true,
      generatedAt: new Date().toISOString(), generator: null,
    });
    expect(withSensitive.documents[0]?.sensitive).toBe('TIN=12-3456789');
    expect(withSensitive.decryptFailures.tin).toBe(0);

    const withoutSensitive = await gatherAuditExportContent(db, tenantId, {
      scope: 'vendor', scopeRef: vendorId, includesSensitive: false,
      generatedAt: new Date().toISOString(), generator: null,
    });
    expect(withoutSensitive.documents[0]?.sensitive).toBe('');
  });
});

describe('db-core (Stage 8c): exports/worker.ts processQueuedExports', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('claims a queued async export, generates it, marks ready, queues a ready notification', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });

    const { exportId } = await createAuditExport({
      db, tenantId, requestedBy: adminId, scope: 'org', scopeRef: null,
      format: 'csv', includesSensitive: false, reason: null,
    });

    const result = await processQueuedExports(db, new Date());
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);

    const row = await db.selectFrom('audit_exports').selectAll().where('id', '=', exportId).executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
    expect(row.storage_key).not.toBeNull();
    expect(row.claimed_at).toBeNull();

    const notif = await db.selectFrom('notifications').selectAll().where('recipient_ref', '=', adminId).executeTakeFirstOrThrow();
    expect((notif.payload_json as { type: string }).type).toBe('audit_export_ready');

    const completedAudit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'export.completed').where('target_id', '=', exportId).executeTakeFirstOrThrow();
    expect(completedAudit.actor_id).toBe('export-worker');
  });

  test('reclaims stale generating rows back to queued', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });
    const exportId = randomUUID();
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000);
    await db.insertInto('audit_exports').values({
      id: exportId, tenant_id: tenantId, requested_by: adminId, scope_type: 'org', scope_ref: null,
      format: 'csv', includes_sensitive: false, status: 'generating', storage_key: null,
      claimed_at: staleClaim, created_at: new Date(), completed_at: null,
    }).execute();

    const result = await processQueuedExports(db, new Date(), { staleSeconds: 60 });
    expect(result.reclaimed).toBe(1);
    expect(result.generated).toBe(1); // reclaimed then immediately claimed+generated this same tick
  });

  test('no due rows is a clean no-op', async () => {
    const result = await processQueuedExports(db, new Date());
    expect(result).toEqual({ reclaimed: 0, generated: 0, failed: 0 });
  });
});
