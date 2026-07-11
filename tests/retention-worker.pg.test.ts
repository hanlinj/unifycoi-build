// tests/retention-worker.pg.test.ts — Phase 13 migration, Stage 8a: verifies
// retention/worker.ts against real Postgres. Conversion pass-through + the idempotent
// full-scan mark behavior (no claim-then-process step — a plain guarded UPDATE prevents
// double-marking, so running the same sweep twice must produce zero new marks and no
// duplicate audit rows the second time).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { runRetentionSweep, retentionHorizon, RETENTION_YEARS } from '@/lib/retention/worker';
import type { Db } from '@/lib/db/client';

async function seedTenant(db: Db, overrides: Partial<{ id: string }> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insertInto('tenants').values({
    id, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date(),
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

async function seedDocument(
  db: Db,
  tenantId: string,
  vendorId: string,
  overrides: Partial<{ id: string; superseded_at: Date | null; purge_eligible: boolean }> = {}
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insertInto('documents').values({
    id, tenant_id: tenantId, vendor_id: vendorId, doc_type: 'coi', storage_key: `k-${id}`,
    encryption_json: JSON.stringify({}), uploaded_at: new Date(), state: 'active',
    superseded_at: overrides.superseded_at ?? null,
    purge_eligible: overrides.purge_eligible ?? false,
  }).execute();
  return id;
}

async function seedAuditEvent(
  db: Db,
  tenantId: string,
  overrides: Partial<{ id: string; created_at: Date; purge_eligible: boolean }> = {}
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insertInto('audit_events').values({
    id, tenant_id: tenantId, actor_type: 'system', actor_id: 'fixture', event_type: 'test.fixture',
    target_type: null, target_id: null, payload_json: null,
    created_at: overrides.created_at ?? new Date(),
    purge_eligible: overrides.purge_eligible ?? false,
  }).execute();
  return id;
}

describe('db-core (Stage 8a): retention/worker.ts', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  const NOW = new Date('2026-07-09T12:00:00.000Z');
  const PAST_HORIZON = new Date(retentionHorizon(NOW, RETENTION_YEARS));
  const WELL_PAST = new Date(PAST_HORIZON.getTime() - 1000 * 60 * 60 * 24); // 1 day further back
  const RECENT = new Date('2026-01-01T00:00:00.000Z'); // well within retention

  test('marks a superseded document past the horizon, sets purge_eligible_at, and logs an audit event', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const docId = await seedDocument(db, tenantId, vendorId, { superseded_at: WELL_PAST });

    const result = await runRetentionSweep(db, NOW);
    expect(result.documentsMarked).toBe(1);

    const doc = await db.selectFrom('documents').selectAll().where('id', '=', docId).executeTakeFirstOrThrow();
    expect(doc.purge_eligible).toBe(true);
    expect(doc.purge_eligible_at).not.toBeNull();

    const audit = await db.selectFrom('audit_events').selectAll()
      .where('target_type', '=', 'document').where('target_id', '=', docId).executeTakeFirstOrThrow();
    expect(audit.event_type).toBe('retention.purge_eligible');
    expect(audit.actor_type).toBe('system');
    expect((audit.payload_json as { retention_years: number }).retention_years).toBe(RETENTION_YEARS);
  });

  test('does not mark an active (non-superseded) document, regardless of age', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const docId = await seedDocument(db, tenantId, vendorId, { superseded_at: null });

    const result = await runRetentionSweep(db, NOW);
    expect(result.documentsMarked).toBe(0);
    const doc = await db.selectFrom('documents').selectAll().where('id', '=', docId).executeTakeFirstOrThrow();
    expect(doc.purge_eligible).toBe(false);
  });

  test('does not mark a document superseded within the retention window', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const docId = await seedDocument(db, tenantId, vendorId, { superseded_at: RECENT });

    const result = await runRetentionSweep(db, NOW);
    expect(result.documentsMarked).toBe(0);
    const doc = await db.selectFrom('documents').selectAll().where('id', '=', docId).executeTakeFirstOrThrow();
    expect(doc.purge_eligible).toBe(false);
  });

  test('marks an audit event past the horizon and logs a retention audit event for it', async () => {
    const tenantId = await seedTenant(db);
    const eventId = await seedAuditEvent(db, tenantId, { created_at: WELL_PAST });

    const result = await runRetentionSweep(db, NOW);
    expect(result.auditEventsMarked).toBe(1);

    const row = await db.selectFrom('audit_events').selectAll().where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.purge_eligible).toBe(true);
    expect(row.purge_eligible_at).not.toBeNull();

    const retentionAudit = await db.selectFrom('audit_events').selectAll()
      .where('target_type', '=', 'audit_event').where('target_id', '=', eventId).executeTakeFirstOrThrow();
    expect(retentionAudit.event_type).toBe('retention.purge_eligible');
  });

  test('does not mark a recent audit event', async () => {
    const tenantId = await seedTenant(db);
    const eventId = await seedAuditEvent(db, tenantId, { created_at: RECENT });

    const result = await runRetentionSweep(db, NOW);
    expect(result.auditEventsMarked).toBe(0);
    const row = await db.selectFrom('audit_events').selectAll().where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.purge_eligible).toBe(false);
  });

  test('scans across ALL tenants and attributes each mark to its own row\'s tenant_id', async () => {
    const tenantA = await seedTenant(db);
    const tenantB = await seedTenant(db);
    const vendorA = await seedVendor(db, tenantA);
    const vendorB = await seedVendor(db, tenantB);
    const docA = await seedDocument(db, tenantA, vendorA, { superseded_at: WELL_PAST });
    const docB = await seedDocument(db, tenantB, vendorB, { superseded_at: WELL_PAST });

    const result = await runRetentionSweep(db, NOW);
    expect(result.documentsMarked).toBe(2);

    const auditA = await db.selectFrom('audit_events').selectAll().where('target_id', '=', docA).executeTakeFirstOrThrow();
    const auditB = await db.selectFrom('audit_events').selectAll().where('target_id', '=', docB).executeTakeFirstOrThrow();
    expect(auditA.tenant_id).toBe(tenantA);
    expect(auditB.tenant_id).toBe(tenantB);
  });

  test('idempotent: running the sweep twice with the same clock marks nothing new the second time and logs no duplicate audit rows', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const docId = await seedDocument(db, tenantId, vendorId, { superseded_at: WELL_PAST });
    const eventId = await seedAuditEvent(db, tenantId, { created_at: WELL_PAST });

    const first = await runRetentionSweep(db, NOW);
    expect(first.documentsMarked).toBe(1);
    expect(first.auditEventsMarked).toBe(1);

    const second = await runRetentionSweep(db, NOW);
    expect(second.documentsMarked).toBe(0);
    expect(second.auditEventsMarked).toBe(0);

    const docAudits = await db.selectFrom('audit_events').selectAll()
      .where('target_type', '=', 'document').where('target_id', '=', docId).execute();
    expect(docAudits).toHaveLength(1); // no duplicate retention.purge_eligible row

    const eventAudits = await db.selectFrom('audit_events').selectAll()
      .where('target_type', '=', 'audit_event').where('target_id', '=', eventId).execute();
    expect(eventAudits).toHaveLength(1);
  });

  test('retentionHorizon is pure and exact: 7 years before now, UTC', () => {
    const now = new Date('2026-07-09T12:34:56.000Z');
    expect(retentionHorizon(now, 7)).toBe('2019-07-09T12:34:56.000Z');
  });
});
