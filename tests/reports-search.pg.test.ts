// tests/reports-search.pg.test.ts — Phase 13 migration, Stage 9 (final conversion stage):
// verifies reports/{index,builders}.ts and search/search.ts against real Postgres. Conversion
// pass-through plus two documented landmine fixes: renewalForecast's ->>/DISTINCT ON rewrite
// (invariants 5–6, a lexicographically-adverse date fixture) and coiCoverageSummary's dropped
// JSON.parse() on jsonb (invariant 2, caught in the pre-flight trace before it ever executed).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { effectiveLocationIds, vendorIdsInScope, inClause } from '@/lib/reports';
import { runReport } from '@/lib/reports/builders';
import { searchEntities } from '@/lib/search/search';
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

async function seedVendor(db: Db, tenantId: string, overrides: Partial<{ business_name: string; trade: string }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('vendors').values({
    id, tenant_id: tenantId, business_name: overrides.business_name ?? 'Acme Fire Safety',
    trade: overrides.trade ?? 'fire_suppression', created_at: new Date(),
  }).execute();
  return id;
}

async function seedLocation(db: Db, tenantId: string, overrides: Partial<{ name: string }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('locations').values({ id, tenant_id: tenantId, name: overrides.name ?? 'Store 1', status: 'active', created_at: new Date() }).execute();
  return id;
}

async function seedVendorLocation(db: Db, tenantId: string, vendorId: string, locationId: string, status = 'approved'): Promise<void> {
  await db.insertInto('vendor_locations').values({
    id: randomUUID(), tenant_id: tenantId, vendor_id: vendorId, location_id: locationId, status, created_at: new Date(),
  }).execute();
}

async function seedChaseNotification(db: Db, tenantId: string, vendorId: string, overrides: { type: string; expiration_date?: string; days_before?: number }): Promise<void> {
  await db.insertInto('notifications').values({
    id: randomUUID(), tenant_id: tenantId, recipient_type: 'vendor', recipient_ref: 'v@x.test',
    channel: 'email', kind: 'exception', status: 'queued', scheduled_for: null, sent_at: null,
    payload_json: JSON.stringify({ type: overrides.type, vendor_id: vendorId, expiration_date: overrides.expiration_date, days_before: overrides.days_before }),
    document_id: null, claimed_at: null, provider_message_id: null, created_at: new Date(),
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

async function seedAuditEvent(db: Db, tenantId: string, overrides: { actor_id?: string; event_type: string; target_type?: string; target_id?: string; created_at?: Date }): Promise<void> {
  await db.insertInto('audit_events').values({
    id: randomUUID(), tenant_id: tenantId, actor_type: 'user', actor_id: overrides.actor_id ?? null,
    event_type: overrides.event_type, target_type: overrides.target_type ?? null, target_id: overrides.target_id ?? null,
    payload_json: null, created_at: overrides.created_at ?? new Date(),
  }).execute();
}

describe('db-core (Stage 9): reports/index.ts scope resolution', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('effectiveLocationIds intersects scope with a region filter', async () => {
    const tenantId = await seedTenant(db);
    const regionId = randomUUID();
    await db.insertInto('regions').values({ id: regionId, tenant_id: tenantId, name: 'North' }).execute();
    const inRegion = await seedLocation(db, tenantId);
    await db.updateTable('locations').set({ region_id: regionId }).where('id', '=', inRegion).execute();
    const outOfRegion = await seedLocation(db, tenantId);

    const result = await effectiveLocationIds(db, tenantId, { locationIds: null }, { region: regionId });
    expect(result).toEqual([inRegion]);
    expect(result).not.toContain(outOfRegion);
  });

  test('vendorIdsInScope resolves null (org-wide) to all tenant vendors, and narrows for an explicit location list', async () => {
    const tenantId = await seedTenant(db);
    const v1 = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, v1, loc);

    const orgWide = await vendorIdsInScope(db, tenantId, null);
    expect(orgWide).toContain(v1);

    const scoped = await vendorIdsInScope(db, tenantId, [loc]);
    expect(scoped).toEqual([v1]);

    expect(await vendorIdsInScope(db, tenantId, [])).toEqual([]);
  });

  test('inClause emits Postgres $N placeholders starting at the given offset', () => {
    expect(inClause(3, 2)).toBe('$2, $3, $4');
    expect(inClause(1)).toBe('$1');
  });
});

describe('db-core (Stage 9): reports/builders.ts runReport', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('compliance-posture: current snapshot counts + compliant percentage', async () => {
    const tenantId = await seedTenant(db);
    const v1 = await seedVendor(db, tenantId);
    const v2 = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, v1, loc, 'approved');
    await seedVendorLocation(db, tenantId, v2, loc, 'expired');

    const result = await runReport(db, tenantId, { locationIds: null }, 'compliance-posture');
    const data = result.data as { snapshot: { total: number; approved: number; compliantPct: number } };
    expect(data.snapshot.total).toBe(2);
    expect(data.snapshot.approved).toBe(1);
    expect(data.snapshot.compliantPct).toBe(50);
  });

  test('renewal-forecast: chronological ordering survives a lexicographically-adverse date fixture (invariant 6)', async () => {
    const tenantId = await seedTenant(db);
    // "2026-9-5" (unpadded) sorts AFTER "2026-10-01" as text, despite being chronologically
    // earlier — exactly the trap invariant 6 documents. A plain MIN()/lexicographic ORDER BY
    // would rank these wrong; DISTINCT ON ... ::timestamptz must get it right.
    const earlyVendor = await seedVendor(db, tenantId, { business_name: 'Early Co' });
    const lateVendor = await seedVendor(db, tenantId, { business_name: 'Late Co' });
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, earlyVendor, loc);
    await seedVendorLocation(db, tenantId, lateVendor, loc);
    await seedChaseNotification(db, tenantId, earlyVendor, { type: 'renewal_reminder', expiration_date: '2026-9-5', days_before: 30 });
    await seedChaseNotification(db, tenantId, lateVendor, { type: 'renewal_reminder', expiration_date: '2026-10-01', days_before: 60 });

    const result = await runReport(db, tenantId, { locationIds: null }, 'renewal-forecast');
    const data = result.data as { rows: { vendorId: string; expirationDate: string }[] };
    expect(data.rows).toHaveLength(2);
    // Sorted by daysOut ascending — the chronologically-earlier "2026-9-5" row must sort FIRST,
    // not last (which is what a lexicographic/text comparison would have produced).
    expect(data.rows[0]?.vendorId).toBe(earlyVendor);
    expect(data.rows[0]?.expirationDate).toBe('2026-9-5'); // untouched text, never reformatted
    expect(data.rows[1]?.vendorId).toBe(lateVendor);
  });

  test('renewal-forecast: rung (nextRung) is a real numeric MIN across renewal_reminder rows, ignoring the coi_expiration row\'s missing days_before', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc);
    await seedChaseNotification(db, tenantId, vendorId, { type: 'renewal_reminder', expiration_date: '2026-12-01', days_before: 60 });
    await seedChaseNotification(db, tenantId, vendorId, { type: 'renewal_reminder', expiration_date: '2026-12-01', days_before: 7 });
    await seedChaseNotification(db, tenantId, vendorId, { type: 'coi_expiration', expiration_date: '2026-12-01' }); // no days_before

    const result = await runReport(db, tenantId, { locationIds: null }, 'renewal-forecast');
    const data = result.data as { rows: { nextRung: number | null }[] };
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.nextRung).toBe(7);
  });

  test('vendor-roster: coiCoverageSummary reads the jsonb extraction payload without JSON.parse() (invariant 2)', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc);
    const docId = await seedDocument(db, tenantId, vendorId, 'coi');
    await db.insertInto('extractions').values({
      id: randomUUID(), tenant_id: tenantId, document_id: docId, doc_type: 'coi', model_id: 'test',
      extraction_version: '1', created_at: new Date(),
      payload_json: JSON.stringify({
        policies: [{
          coverage_type: { value: 'General Liability' },
          limits: { each_occurrence: { value: 1000000 } },
          additional_insured: { value: true },
          waiver_of_subrogation: { value: false },
        }],
      }),
    }).execute();

    const result = await runReport(db, tenantId, { locationIds: null }, 'vendor-roster');
    const data = result.data as { rows: { vendorId: string; coverage: { glEachOccurrence: number | null; additionalInsured: boolean | null } }[] };
    const row = data.rows.find((r) => r.vendorId === vendorId);
    expect(row?.coverage.glEachOccurrence).toBe(1000000);
    expect(row?.coverage.additionalInsured).toBe(true);
  });

  test('vendor-roster: a vendor with no COI on file gets null coverage, not a thrown error', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc);

    const result = await runReport(db, tenantId, { locationIds: null }, 'vendor-roster');
    const data = result.data as { rows: { coverage: { glEachOccurrence: number | null } }[] };
    expect(data.rows[0]?.coverage.glEachOccurrence).toBeNull();
  });

  test('onboarding-funnel: reached counts derive from the earliest audit-trail timestamp per stage', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc);
    await seedAuditEvent(db, tenantId, { event_type: 'vendor.invited', target_type: 'vendor', target_id: vendorId });
    await seedAuditEvent(db, tenantId, { event_type: 'vendor.onboarding_started', target_type: 'vendor', target_id: vendorId });

    const result = await runReport(db, tenantId, { locationIds: null }, 'onboarding-funnel');
    const data = result.data as { reached: { invited: number; onboarding: number; underReview: number } };
    expect(data.reached.invited).toBe(1);
    expect(data.reached.onboarding).toBe(1);
    expect(data.reached.underReview).toBe(0);
  });

  test('deficiency-analysis: ranks requirement keys by deficient+uncertain count', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc);
    const runId = randomUUID();
    await db.insertInto('verification_runs').values({
      id: runId, tenant_id: tenantId, vendor_id: vendorId, trigger: 'onboarding', engine_version: '1', recommendation: 'deficiencies', created_at: new Date(),
    }).execute();
    await db.insertInto('requirement_evaluations').values({
      id: randomUUID(), tenant_id: tenantId, run_id: runId, vendor_id: vendorId, location_id: loc,
      requirement_key: 'doc_required.coi', required_value: 'true', extracted_value_ref: null,
      comparison_result: 'fails', confidence_band: 'high', outcome: 'deficient', note: null,
    }).execute();

    const result = await runReport(db, tenantId, { locationIds: null }, 'deficiency-analysis');
    const data = result.data as { ranked: { requirement_key: string; deficient: number }[] };
    expect(data.ranked[0]).toMatchObject({ requirement_key: 'doc_required.coi', deficient: 1 });
  });

  test('audit-readiness: aggregates posture + forecast into one summary', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const loc = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc, 'expired');

    const result = await runReport(db, tenantId, { locationIds: null }, 'audit-readiness');
    const data = result.data as { coverageGaps: number; openExceptions: number };
    expect(data.coverageGaps).toBe(1);
    expect(data.openExceptions).toBe(1);
  });
});

describe('db-core (Stage 9): search/search.ts searchEntities', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('matches vendors and locations by name, scope-clamped', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId, { business_name: 'Acme Fire Safety' });
    const loc = await seedLocation(db, tenantId, { name: 'Downtown Store' });
    await seedVendorLocation(db, tenantId, vendorId, loc);

    const result = await searchEntities(db, tenantId, {
      scope: { locationIds: null }, role: 'admin', actorId: 'a1', query: 'Acme',
    });
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]?.id).toBe(vendorId);
  });

  test('users are only searched for admin/district_manager roles', async () => {
    const tenantId = await seedTenant(db);
    await seedUser(db, tenantId, { role: 'admin' });
    const storeResult = await searchEntities(db, tenantId, {
      scope: { locationIds: null }, role: 'store_manager', actorId: 'a1', query: 'x',
    });
    expect(storeResult.users).toEqual([]);
  });

  test('recentlyViewed preserves insertion order via seq when created_at ties (the rowid replacement)', async () => {
    const tenantId = await seedTenant(db);
    const v1 = await seedVendor(db, tenantId, { business_name: 'First Viewed' });
    const v2 = await seedVendor(db, tenantId, { business_name: 'Second Viewed' });
    const sameInstant = new Date('2026-07-11T12:00:00.000Z');
    // Two events sharing the exact same created_at millisecond — only insertion order (seq)
    // can distinguish "most recent" between them once rowid is gone.
    await seedAuditEvent(db, tenantId, { actor_id: 'actor-1', event_type: 'vendor.viewed', target_type: 'vendor', target_id: v1, created_at: sameInstant });
    await seedAuditEvent(db, tenantId, { actor_id: 'actor-1', event_type: 'vendor.viewed', target_type: 'vendor', target_id: v2, created_at: sameInstant });

    const result = await searchEntities(db, tenantId, {
      scope: { locationIds: null }, role: 'admin', actorId: 'actor-1', query: '',
    });
    expect(result.recent).toBe(true);
    // v2 inserted after v1 at the identical timestamp — DESC order must put it first.
    expect(result.vendors.map((v) => v.id)).toEqual([v2, v1]);
  });
});
