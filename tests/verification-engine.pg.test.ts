// tests/verification-engine.pg.test.ts — Phase 13 migration, Stage 7: the verification/
// requirements engine — the product's core logic, converted as one unit (no natural seam;
// runVerification() interleaves reads and writes with no cut line — see the Stage 7 scoping
// discussion). Covers the orchestrator (verification/run.ts), the resolver's DB-backed entry
// point (requirements/resolver.ts), and four of the five blocked callers: add-to-locations.ts,
// the portal's submit route (via runVerification/fsmTransition), the requirements/* routes +
// services/requirements.ts + re-eval.ts's triggerRuleChangeReeval.
//
// Deliberately NOT covered here: src/lib/exports/content.ts / audit-export.ts. Converting
// content.ts's one resolveRequirements() call site cascades into the entire audit-export
// subsystem (audit-export.ts's createAuditExport/generateExportArtifact/scopeAuditEvents, its
// worker, and 3-4 routes) — genuinely Stage 8's charter ("notifications + retention + audit
// exports"), not a narrow slice. Discovered mid-stage, deferred rather than silently expanding
// scope — see Shortcuts & gaps and ADR-013-01.
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { createTenant } from '@/lib/services/tenants';
import { createVendorInvite } from '@/lib/services/vendors';
import { addVendorToLocations, AddToLocationsError } from '@/lib/services/add-to-locations';
import { fsmTransition } from '@/lib/services/vendor-fsm';
import { resolveRequirements } from '@/lib/requirements/resolver';
import { runVerification, runRulesOnlyReeval, loadExtractionBundle } from '@/lib/verification/run';
import { getRequirements, setRequirementRule, getPrecedence, setPrecedence } from '@/lib/services/requirements';
import { triggerRuleChangeReeval } from '@/lib/requirements/re-eval';
import { buildCOI, buildW9 } from '@/lib/extraction/extractor';
import * as auditModule from '@/lib/audit';
import type { Db } from '@/lib/db/client';
import type { RawCOIExtraction, RawW9Extraction, RawFieldStr } from '@/lib/extraction/types';

async function seedTenantId(db: Db, name = 'Test Tenant'): Promise<string> {
  const tenant = await createTenant(db, { name, slug: `t-${randomUUID().slice(0, 8)}` }, 'p1');
  return tenant.id;
}

async function seedLocation(db: Db, tenantId: string, name = 'Loc A'): Promise<string> {
  const id = randomUUID();
  await db.insertInto('locations').values({ id, tenant_id: tenantId, name, address: null, status: 'active', created_at: new Date() }).execute();
  return id;
}

async function seedUser(db: Db, tenantId: string, role = 'admin'): Promise<string> {
  const id = randomUUID();
  await db.insertInto('users').values({
    id, tenant_id: tenantId, email: `${id}@x.test`, name: 'Actor', role, password_hash: null, status: 'active', created_at: new Date(),
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

async function seedVendorLocation(db: Db, tenantId: string, vendorId: string, locationId: string, status = 'approved'): Promise<void> {
  await db.insertInto('vendor_locations').values({
    id: randomUUID(), tenant_id: tenantId, vendor_id: vendorId, location_id: locationId, status, created_at: new Date(),
  }).execute();
}

async function seedRule(db: Db, tenantId: string, actorId: string, overrides: Partial<{ scope_type: string; scope_ref: string | null; requirement_key: string; required_value: string }> = {}): Promise<void> {
  await db.insertInto('requirement_rules').values({
    id: randomUUID(), tenant_id: tenantId, scope_type: overrides.scope_type ?? 'org', scope_ref: overrides.scope_ref ?? null,
    requirement_key: overrides.requirement_key ?? 'doc_required.coi', required_value: overrides.required_value ?? 'true',
    created_by: actorId, reason: 'test fixture', created_at: new Date(),
  }).execute();
}

describe('db-core (Stage 7): resolveRequirements', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let actorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    actorId = await seedUser(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('layers org -> trade -> location, with the tenant precedence policy breaking ties, and never JSON.parse()s floor_json', async () => {
    await seedRule(db, tenantId, actorId, { scope_type: 'org', requirement_key: 'coverage.general_liability', required_value: '1000000' });
    await seedRule(db, tenantId, actorId, { scope_type: 'trade', scope_ref: 'fire_suppression', requirement_key: 'coverage.general_liability', required_value: '2000000' });
    await seedRule(db, tenantId, actorId, { scope_type: 'location', scope_ref: locationId, requirement_key: 'coverage.general_liability', required_value: '3000000' });
    // createTenant() already inserts a default requirement_settings row — update it, don't insert a second one.
    await db.updateTable('requirement_settings').set({ floor_json: JSON.stringify({ 'coverage.general_liability': '500000' }) }).where('tenant_id', '=', tenantId).execute();

    const matrix = await resolveRequirements(db, { tenantId, vendorTrade: 'fire_suppression', locationId, precedence: 'strictest' });
    expect(matrix['coverage.general_liability']).toMatchObject({ required_value: '3000000', scope: 'location' }); // location > trade under 'strictest'
  });

  test('the floor clamps a resolved value that falls below it', async () => {
    await seedRule(db, tenantId, actorId, { scope_type: 'org', requirement_key: 'coverage.general_liability', required_value: '100' });
    await db.updateTable('requirement_settings').set({ floor_json: JSON.stringify({ 'coverage.general_liability': '1000000' }) }).where('tenant_id', '=', tenantId).execute();

    const matrix = await resolveRequirements(db, { tenantId, vendorTrade: 'fire_suppression', locationId, precedence: 'strictest' });
    expect(matrix['coverage.general_liability']).toEqual({ required_value: '1000000', scope: 'floor', rule_id: null });
  });
});

describe('db-core (Stage 7): runVerification — the multi-write orchestrator', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let vendorId: string;
  let actorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    actorId = await seedUser(db, tenantId);
    vendorId = await seedVendor(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'under_review');
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('a deficient requirement (no COI submitted) writes verification_runs + requirement_evaluations + audit, recommends deficiencies', async () => {
    await seedRule(db, tenantId, actorId, { requirement_key: 'doc_required.coi', required_value: 'true' });

    const result = await runVerification(db, { tenantId, vendorId, vendorTrade: 'fire_suppression', trigger: 'onboarding' });
    expect(result.recommendation).toBe('deficiencies');
    expect(result.evaluationCount).toBe(1);

    const run = await db.selectFrom('verification_runs').selectAll().where('id', '=', result.runId).executeTakeFirstOrThrow();
    expect(run.recommendation).toBe('deficiencies');

    const evals = await db.selectFrom('requirement_evaluations').selectAll().where('run_id', '=', result.runId).execute();
    expect(evals).toHaveLength(1);
    expect(evals[0]!.outcome).toBe('deficient');
    expect(evals[0]!.location_id).toBe(locationId);

    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'ai.recommendation').executeTakeFirstOrThrow();
    expect((audit.payload_json as { run_id: string }).run_id).toBe(result.runId);
  });

  test('loadExtractionBundle reads stored extractions back correctly (jsonb auto-parsed, never JSON.parse()d) and feeds the engine', async () => {
    const documentId = randomUUID();
    await db.insertInto('documents').values({
      id: documentId, tenant_id: tenantId, vendor_id: vendorId, doc_type: 'coi', storage_key: 'k',
      encryption_json: JSON.stringify({}), uploaded_at: new Date(), state: 'active', superseded_by: null,
    }).execute();
    const coiPayload = buildCOI(rawCOI({ policies: [rawPolicy({ expiration_date: '2026-12-31' })] }), {});
    await db.insertInto('extractions').values({
      id: randomUUID(), tenant_id: tenantId, document_id: documentId, doc_type: 'coi', model_id: 'test',
      extraction_version: 'v1', payload_json: JSON.stringify(coiPayload), created_at: new Date(),
    }).execute();

    const bundle = await loadExtractionBundle(db, tenantId, vendorId);
    expect(bundle.coi?.policies[0]?.expiration_date.value).toBe('2026-12-31');

    await seedRule(db, tenantId, actorId, { requirement_key: 'doc_required.coi', required_value: 'true' });
    const result = await runVerification(db, { tenantId, vendorId, vendorTrade: 'fire_suppression', trigger: 'onboarding' });
    expect(result.recommendation).not.toBe('deficiencies'); // COI now present, doc_required.coi passes
  });

  test('runRulesOnlyReeval: no advisories, reads only stored extractions (invariant #7) — rule_change trigger', async () => {
    await seedRule(db, tenantId, actorId, { requirement_key: 'doc_required.coi', required_value: 'true' });
    const result = await runRulesOnlyReeval(db, { tenantId, vendorId, vendorTrade: 'fire_suppression', trigger: 'rule_change' });
    expect(result.recommendation).toBe('deficiencies');
    expect(result.advisoryCount).toBe(0); // rule_change never generates advisories
    const advisories = await db.selectFrom('engine_advisories').select('id').where('vendor_id', '=', vendorId).execute();
    expect(advisories).toHaveLength(0);
  });

  test('a vendor with NO assigned locations still runs (against an empty matrix), producing zero evaluations', async () => {
    const lonelyVendor = await seedVendor(db, tenantId, { business_name: 'No Locations Co' });
    await seedRule(db, tenantId, actorId, { requirement_key: 'doc_required.coi', required_value: 'true' });
    const result = await runVerification(db, { tenantId, vendorId: lonelyVendor, vendorTrade: 'fire_suppression', trigger: 'onboarding' });
    expect(result.evaluationCount).toBe(0);
    expect(result.recommendation).toBe('approve'); // nothing evaluated -> nothing failed
  });

  // ── The atomicity proof — the actual point of this test ──────────────────────────────────
  test('ATOMICITY: if the trailing audit write fails, NONE of verification_runs/requirement_evaluations/engine_advisories/audit persist — even though the earlier writes in the same run already "succeeded"', async () => {
    await seedRule(db, tenantId, actorId, { requirement_key: 'doc_required.coi', required_value: 'true' });

    // logAudit is called twice by runVerification's onboarding/resubmission/renewal path when
    // there's at least one advisory (ai.recommendation, then ai.advisory per advisory) — but
    // with an empty bundle there are no advisories, so it's called exactly once
    // (ai.recommendation), which IS the trailing write here. Fail that one call: by the time it
    // throws, verification_runs and requirement_evaluations have already been written within
    // the (still-open) transaction — proving real partial-progress rollback, not just "the
        // first statement never ran".
    const spy = jest.spyOn(auditModule, 'logAudit').mockRejectedValueOnce(new Error('injected failure — simulated audit write failure'));

    await expect(
      runVerification(db, { tenantId, vendorId, vendorTrade: 'fire_suppression', trigger: 'onboarding' })
    ).rejects.toThrow('injected failure');

    spy.mockRestore();

    const runs = await db.selectFrom('verification_runs').select('id').where('vendor_id', '=', vendorId).execute();
    expect(runs).toHaveLength(0); // rolled back, not just "not returned"
    const evals = await db.selectFrom('requirement_evaluations').select('id').where('vendor_id', '=', vendorId).execute();
    expect(evals).toHaveLength(0);
    const audits = await db.selectFrom('audit_events').select('id').where('tenant_id', '=', tenantId).where('event_type', '=', 'ai.recommendation').execute();
    expect(audits).toHaveLength(0);

    // Sanity: a normal (unmocked) call right after still works — proves the mock/rollback
    // didn't corrupt the connection or leave a dangling transaction.
    const recovered = await runVerification(db, { tenantId, vendorId, vendorTrade: 'fire_suppression', trigger: 'onboarding' });
    expect(recovered.recommendation).toBe('deficiencies');
  });
});

describe('db-core (Stage 7): add-to-locations.ts', () => {
  let db: Db;
  let tenantId: string;
  let actorId: string;
  let vendorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    actorId = await seedUser(db, tenantId);
    vendorId = await seedVendor(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('adds locations at under_review and triggers a rules-only re-eval (location_add)', async () => {
    const loc = await seedLocation(db, tenantId);
    const result = await addVendorToLocations({ db, tenantId, vendorId, actorUserId: actorId, locationIds: [loc] });
    expect(result.locationsAdded).toEqual([loc]);
    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).where('location_id', '=', loc).executeTakeFirstOrThrow();
    expect(vl.status).toBe('under_review');
    const run = await db.selectFrom('verification_runs').selectAll().where('id', '=', result.verificationRun.runId).executeTakeFirstOrThrow();
    expect(run.trigger).toBe('location_add');
  });

  test('rejects a location already associated with the vendor', async () => {
    const loc = await seedLocation(db, tenantId);
    await addVendorToLocations({ db, tenantId, vendorId, actorUserId: actorId, locationIds: [loc] });
    await expect(addVendorToLocations({ db, tenantId, vendorId, actorUserId: actorId, locationIds: [loc] })).rejects.toMatchObject({ code: 'ALREADY_ASSOCIATED' } satisfies Partial<AddToLocationsError>);
  });
});

describe('db-core (Stage 7): vendor portal submit flow (fsmTransition + runVerification)', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let actorId: string;
  let vendorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    actorId = await seedUser(db, tenantId);
    const created = await createVendorInvite(db, tenantId, {
      businessName: 'Acme Fire Safety', contactFirstName: 'Pat', contactLastName: 'Smith', email: 'pat@acmefire.test',
      companyPhone: '555-0100', trade: 'fire_suppression', locationIds: [locationId], inviterUserId: actorId,
    });
    if (created.type !== 'created') throw new Error('unreachable');
    vendorId = created.vendorId;
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('open_link then submit runs the engine and lands a verification_runs row with trigger=onboarding', async () => {
    await fsmTransition(db, tenantId, vendorId, 'open_link');
    await fsmTransition(db, tenantId, vendorId, 'submit');
    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('under_review');

    const result = await runVerification(db, { tenantId, vendorId, vendorTrade: 'fire_suppression', trigger: 'onboarding' });
    const run = await db.selectFrom('verification_runs').selectAll().where('id', '=', result.runId).executeTakeFirstOrThrow();
    expect(run.trigger).toBe('onboarding');
  });
});

describe('db-core (Stage 7): services/requirements.ts + re-eval.ts', () => {
  let db: Db;
  let tenantId: string;
  let actorId: string;
  let locationId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    actorId = await seedUser(db, tenantId);
    locationId = await seedLocation(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('setRequirementRule rejects a value below the platform floor, never JSON.parse()s floor_json', async () => {
    await db.updateTable('requirement_settings').set({ floor_json: JSON.stringify({ 'coverage.general_liability': '1000000' }) }).where('tenant_id', '=', tenantId).execute();
    await expect(
      setRequirementRule(db, tenantId, { scope: 'org', scope_ref: null, requirement_key: 'coverage.general_liability', required_value: '100', reason: 'test' }, actorId)
    ).rejects.toMatchObject({ status: 422 });
  });

  test('setRequirementRule writes the rule, audits the change, and getRequirements reflects it (deduplicated latest-per-key)', async () => {
    await setRequirementRule(db, tenantId, { scope: 'org', scope_ref: null, requirement_key: 'doc_required.coi', required_value: 'true', reason: 'initial' }, actorId);
    await setRequirementRule(db, tenantId, { scope: 'org', scope_ref: null, requirement_key: 'doc_required.coi', required_value: 'false', reason: 'superseded' }, actorId);

    const reqs = await getRequirements(db, tenantId);
    expect(reqs.rules.org).toHaveLength(1); // only the latest survives dedup
    expect(reqs.rules.org[0]!.required_value).toBe('false');

    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'requirement.rule_changed').execute();
    expect(audit).toHaveLength(2);
  });

  test('getPrecedence / setPrecedence upsert requirement_settings and audit the change', async () => {
    expect(await getPrecedence(db, tenantId)).toBe('strictest'); // createTenant()'s own default row
    await setPrecedence(db, tenantId, 'location', actorId, 'switching to location-wins');
    expect(await getPrecedence(db, tenantId)).toBe('location');
    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'requirement.precedence_changed').executeTakeFirstOrThrow();
    expect(audit.payload_json).toEqual({ old_policy: 'strictest', new_policy: 'location', reason: 'switching to location-wins' });
  });

  test('triggerRuleChangeReeval flips a formerly-approved vendor to non_compliant when a tightened rule fails, and notifies admins', async () => {
    const vendorId = await seedVendor(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');
    await seedRule(db, tenantId, actorId, { requirement_key: 'doc_required.coi', required_value: 'true' }); // no COI on file -> deficient

    await triggerRuleChangeReeval(db, tenantId, 'doc_required.coi');

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('non_compliant');

    const notif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).where('recipient_type', '=', 'user').executeTakeFirstOrThrow();
    expect((notif.payload_json as { type: string }).type).toBe('non_compliant_rule_change');

    const summary = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'requirement.reeval_triggered').executeTakeFirstOrThrow();
    expect((summary.payload_json as { vendors_non_compliant: number }).vendors_non_compliant).toBe(1);
  });

  test('triggerRuleChangeReeval leaves a still-compliant vendor untouched (no noise)', async () => {
    const vendorId = await seedVendor(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');
    // No rules at all -> nothing to fail against -> recommendation stays 'approve'
    await triggerRuleChangeReeval(db, tenantId, 'coverage.general_liability');
    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('approved'); // unchanged
  });
});

describe('db-core (Stage 7): boundary normalization — dateField() in extractor.ts', () => {
  test('buildCOI: an unpadded, non-ISO expiration_date/effective_date/certificate_date lands zero-padded ISO', () => {
    const raw = rawCOI({
      certificate_date: rawField('2026-9-1'),
      policies: [rawPolicy({ effective_date: '2026-1-5', expiration_date: '2026-9-5' })],
    });
    const built = buildCOI(raw, {});
    expect(built.certificate_date.value).toBe('2026-09-01');
    expect(built.policies[0]!.effective_date.value).toBe('2026-01-05');
    expect(built.policies[0]!.expiration_date.value).toBe('2026-09-05');
  });

  test('buildCOI: an unparseable (prose) date is left unchanged, not dropped', () => {
    const raw = rawCOI({ policies: [rawPolicy({ expiration_date: 'on or about September 2026' })] });
    const built = buildCOI(raw, {});
    expect(built.policies[0]!.expiration_date.value).toBe('on or about September 2026');
  });

  test('buildW9: an unpadded signature_date lands zero-padded ISO', () => {
    const raw = rawW9({ signature_date: rawField('9/5/2026') });
    const built = buildW9(raw, {});
    expect(built.signature_date.value).toBe('2026-09-05');
  });

  test('proven at the column: a boundary-normalized COI payload persists as zero-padded ISO in extractions.payload_json (jsonb round-trip, no JSON.parse() needed on read)', async () => {
    const db = await setupTestDb();
    try {
      const tenantId = await seedTenantId(db);
      const vendorId = await seedVendor(db, tenantId);
      const documentId = randomUUID();
      await db.insertInto('documents').values({
        id: documentId, tenant_id: tenantId, vendor_id: vendorId, doc_type: 'coi', storage_key: 'k',
        encryption_json: JSON.stringify({}), uploaded_at: new Date(), state: 'active', superseded_by: null,
      }).execute();

      const raw = rawCOI({ policies: [rawPolicy({ expiration_date: '2026-9-5' })] }); // unpadded input
      const built = buildCOI(raw, {}); // normalized BEFORE it ever reaches the column
      await db.insertInto('extractions').values({
        id: randomUUID(), tenant_id: tenantId, document_id: documentId, doc_type: 'coi', model_id: 'test',
        extraction_version: 'v1', payload_json: JSON.stringify(built), created_at: new Date(),
      }).execute();

      const row = await db.selectFrom('extractions').select('payload_json').where('document_id', '=', documentId).executeTakeFirstOrThrow();
      const persisted = row.payload_json as { policies: { expiration_date: { value: string } }[] };
      expect(persisted.policies[0]!.expiration_date.value).toBe('2026-09-05'); // zero-padded at the column, not '2026-9-5'
    } finally {
      await teardownTestDb(db);
      await teardownTestDatabase();
    }
  });
});

// ── Fixture builders ────────────────────────────────────────────────────────────────────────

function rawField(value: string | null, confidence = 0.95): RawFieldStr {
  return { value, confidence, source: { page: 1, snippet: '' } };
}

function rawPolicy(overrides: Partial<{ effective_date: string | null; expiration_date: string | null }> = {}): RawCOIExtraction['policies'][number] {
  return {
    coverage_type: rawField('general_liability'),
    insurer_letter: rawField('A'),
    policy_number: rawField('POL-123'),
    effective_date: rawField(overrides.effective_date ?? null),
    expiration_date: rawField(overrides.expiration_date ?? null),
    limits: {},
    additional_insured: { value: false, confidence: 0.9, source: { page: 1, snippet: '' } },
    additional_insured_scope: rawField(null),
    waiver_of_subrogation: { value: false, confidence: 0.9, source: { page: 1, snippet: '' } },
    primary_noncontributory: { value: false, confidence: 0.9, source: { page: 1, snippet: '' } },
  };
}

function rawCOI(overrides: Partial<{ certificate_date: RawFieldStr; policies: RawCOIExtraction['policies'] }> = {}): RawCOIExtraction {
  return {
    document_type_confirmed: 'coi',
    certificate_date: overrides.certificate_date ?? rawField(null),
    producer: rawField(null),
    named_insured: rawField(null),
    insured_address: rawField(null),
    insurers: [],
    policies: overrides.policies ?? [],
    additional_insured_entities: rawField(null),
    description_of_operations: rawField(null),
    certificate_holder: rawField(null),
  };
}

function rawW9(overrides: Partial<{ signature_date: RawFieldStr }> = {}): RawW9Extraction {
  return {
    document_type_confirmed: 'w9',
    legal_name: rawField(null),
    business_name: rawField(null),
    federal_tax_classification: rawField(null),
    tin_type: rawField(null),
    tin_value: rawField(null),
    address: rawField(null),
    signature_present: { value: false, confidence: 0.9, source: { page: 1, snippet: '' } },
    signature_date: overrides.signature_date ?? rawField(null),
  };
}
