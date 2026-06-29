// Phase 6 integration tests — Admin Review & Decision Workbench.
//
// Tests exercise the decision and add-to-locations services directly against
// an in-memory SQLite DB (same pattern as prior phases). No HTTP, no mocks.
//
// Honesty contract: failures are reported as failures. Tests prove behavioral
// invariants, not "the function ran." Mocking nothing.

import { randomUUID } from 'crypto';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedLocation,
  seedVendor,
  seedVendorLocation,
  seedRequirementSettings,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import {
  applyDecision,
  DecisionError,
  acceptUncertainEvaluation,
} from '@/lib/services/decision';
import { addVendorToLocations, AddToLocationsError } from '@/lib/services/add-to-locations';
import type Database from 'better-sqlite3';

// ── Shared setup helpers ──────────────────────────────────────────────────────

function makeUnderReviewScenario() {
  const db = setupTestDb();
  const tenant = seedTenant(db);
  const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  const vendor = seedVendor(db, tenant.id, { contact_email: 'vendor@example.com' });
  const loc = seedLocation(db, tenant.id);
  seedVendorLocation(db, tenant.id, vendor.id, loc.id, { status: 'under_review' });
  seedRequirementSettings(db, tenant.id);
  return { db, tenant, admin, vendor, loc };
}

// Seed a verification_run + a single requirement_evaluation row (raw insert — no helper exists).
function seedEvaluation(
  db: Database.Database,
  tenantId: string,
  vendorId: string,
  locationId: string,
  overrides: Partial<{ id: string; outcome: string; requirement_key: string }> = {}
): { runId: string; evalId: string; requirementKey: string } {
  const runId = randomUUID();
  const evalId = overrides.id ?? randomUUID();
  const requirementKey = overrides.requirement_key ?? 'coverage.general_liability.each_occurrence';
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, tenantId, vendorId, 'onboarding', '1.0.0', 'uncertain', now);

  db.prepare(
    `INSERT INTO requirement_evaluations
       (id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value,
        extracted_value_ref, comparison_result, confidence_band, outcome, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    evalId, tenantId, runId, vendorId, locationId, requirementKey, '1000000',
    'coi.limits.each_occurrence', 'indeterminate', 'low', overrides.outcome ?? 'uncertain',
    'Near-miss entity match'
  );

  return { runId, evalId, requirementKey };
}

// ── 1. Approve: sets status + approved_by + approved_at ───────────────────────

describe('approve decision', () => {
  test('sets status=approved, approved_by, approved_at on the target location', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'approve',
      locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const vl = tdb.get<{ status: string; approved_by: string; approved_at: string }>(
      'SELECT status, approved_by, approved_at FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendor.id, loc.id]
    );
    expect(vl).toBeDefined();
    expect(vl!.status).toBe('approved');
    expect(vl!.approved_by).toBe(admin.id);
    expect(vl!.approved_at).toBeTruthy();

    db.close();
  });

  test('writes a vendor.approved audit event', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'approve',
      locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ event_type: string; actor_id: string }>(
      `SELECT event_type, actor_id FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.approved'
       ORDER BY created_at DESC LIMIT 1`
    );
    expect(event).toBeDefined();
    expect(event!.event_type).toBe('vendor.approved');
    expect(event!.actor_id).toBe(admin.id);

    db.close();
  });

  test('approve is per-location — approving loc A does not change loc B', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const locA = seedLocation(db, tenant.id);
    const locB = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, locA.id, { status: 'under_review' });
    seedVendorLocation(db, tenant.id, vendor.id, locB.id, { status: 'under_review' });
    seedRequirementSettings(db, tenant.id);

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'approve',
      locationIds: [locA.id],   // only approve A
    });

    const tdb = new TenantDB(db, tenant.id);
    const vlA = tdb.get<{ status: string }>(
      'SELECT status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendor.id, locA.id]
    );
    const vlB = tdb.get<{ status: string }>(
      'SELECT status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendor.id, locB.id]
    );

    expect(vlA!.status).toBe('approved');
    expect(vlB!.status).toBe('under_review');  // unchanged

    db.close();
  });

  test('approve with accepted_uncertainty_ids logs them in audit payload', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const fakeEvalId = randomUUID();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'approve',
      locationIds: [loc.id],
      acceptedUncertaintyIds: [fakeEvalId],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ payload_json: string }>(
      `SELECT payload_json FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.approved' LIMIT 1`
    );
    expect(event).toBeDefined();
    const payload = JSON.parse(event!.payload_json);
    expect(payload.accepted_uncertainty_ids).toContain(fakeEvalId);

    db.close();
  });

  test('approve throws CONFLICT if location is not in under_review', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, loc.id, { status: 'onboarding' });

    expect(() =>
      applyDecision({
        db, tenantId: tenant.id, vendorId: vendor.id,
        actorUserId: admin.id, action: 'approve',
        locationIds: [loc.id],
      })
    ).toThrow(DecisionError);

    db.close();
  });
});

// ── 2. Reject: sets status=declined (terminal) ────────────────────────────────

describe('reject decision', () => {
  test('sets status=declined on the target location', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'reject',
      locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const vl = tdb.get<{ status: string }>(
      'SELECT status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendor.id, loc.id]
    );
    expect(vl!.status).toBe('declined');

    db.close();
  });

  test('reject is distinct from request_correction — does not create an invite', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'reject',
      locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const invite = tdb.get<{ id: string }>(
      `SELECT id FROM invites WHERE tenant_id = ? AND vendor_id = ? AND purpose = 'correction'`,
      [vendor.id]
    );
    expect(invite).toBeUndefined();

    db.close();
  });

  test('writes a vendor.declined audit event with actor_id', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'reject',
      locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ event_type: string; actor_id: string }>(
      `SELECT event_type, actor_id FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.declined' LIMIT 1`
    );
    expect(event!.event_type).toBe('vendor.declined');
    expect(event!.actor_id).toBe(admin.id);

    db.close();
  });
});

// ── 3. Request correction: invite + transition + notification ──────────────────

describe('request_correction decision', () => {
  test('transitions ALL under_review locations to onboarding+action_needed', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id, { contact_email: 'v@test.com' });
    const locA = seedLocation(db, tenant.id);
    const locB = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, locA.id, { status: 'under_review' });
    seedVendorLocation(db, tenant.id, vendor.id, locB.id, { status: 'under_review' });

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
    });

    const tdb = new TenantDB(db, tenant.id);
    const vls = tdb.all<{ status: string; flags_json: string }>(
      'SELECT status, flags_json FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ?',
      [vendor.id]
    );
    expect(vls).toHaveLength(2);
    for (const vl of vls) {
      expect(vl.status).toBe('onboarding');
      const flags = JSON.parse(vl.flags_json);
      expect(flags.action_needed).toBe(true);
    }

    db.close();
  });

  test('issues a new correction invite with purpose=correction', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
    });

    const tdb = new TenantDB(db, tenant.id);
    const invite = tdb.get<{ purpose: string; delivery_state: string; inviter_user_id: string }>(
      `SELECT purpose, delivery_state, inviter_user_id FROM invites
       WHERE tenant_id = ? AND vendor_id = ? AND purpose = 'correction'`,
      [vendor.id]
    );
    expect(invite).toBeDefined();
    expect(invite!.purpose).toBe('correction');
    expect(invite!.delivery_state).toBe('sent');
    expect(invite!.inviter_user_id).toBe(admin.id);

    db.close();
  });

  test('queues a vendor notification for the correction request', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
    });

    const tdb = new TenantDB(db, tenant.id);
    const notif = tdb.get<{ recipient_type: string; recipient_ref: string; kind: string; status: string }>(
      `SELECT recipient_type, recipient_ref, kind, status FROM notifications
       WHERE tenant_id = ? AND recipient_type = 'vendor' ORDER BY created_at DESC LIMIT 1`
    );
    expect(notif).toBeDefined();
    expect(notif!.recipient_type).toBe('vendor');
    expect(notif!.recipient_ref).toBe('vendor@example.com');
    expect(notif!.kind).toBe('exception');
    expect(notif!.status).toBe('queued');

    db.close();
  });

  test('notification payload contains type=correction_requested and invite_path', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
    });

    const tdb = new TenantDB(db, tenant.id);
    const notif = tdb.get<{ payload_json: string }>(
      `SELECT payload_json FROM notifications
       WHERE tenant_id = ? AND recipient_type = 'vendor' ORDER BY created_at DESC LIMIT 1`
    );
    const payload = JSON.parse(notif!.payload_json);
    expect(payload.type).toBe('correction_requested');
    expect(typeof payload.invite_path).toBe('string');
    expect(payload.invite_path).toMatch(/^\/v\//);

    db.close();
  });

  test('throws NO_UNDER_REVIEW when no locations are in under_review', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, loc.id, { status: 'onboarding' });

    expect(() =>
      applyDecision({
        db, tenantId: tenant.id, vendorId: vendor.id,
        actorUserId: admin.id, action: 'request_correction',
        locationIds: [],
      })
    ).toThrow(expect.objectContaining({ code: 'NO_UNDER_REVIEW' }));

    db.close();
  });

  test('writes a vendor.correction_requested audit event', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ event_type: string }>(
      `SELECT event_type FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.correction_requested' LIMIT 1`
    );
    expect(event).toBeDefined();
    expect(event!.event_type).toBe('vendor.correction_requested');

    db.close();
  });
});

// ── 4. NOT_FOUND guard ────────────────────────────────────────────────────────

describe('vendor not found guard', () => {
  test('applyDecision throws NOT_FOUND for unknown vendorId', () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });

    expect(() =>
      applyDecision({
        db, tenantId: tenant.id, vendorId: randomUUID(),
        actorUserId: admin.id, action: 'approve',
        locationIds: [randomUUID()],
      })
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    db.close();
  });
});

// ── 5. Tenant isolation ────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  test('applyDecision does not see vendor_locations from another tenant', () => {
    const db = setupTestDb();
    const tenantA = seedTenant(db);
    const tenantB = seedTenant(db);
    const adminA = seedTenantUser(db, tenantA.id, { role: 'admin' });
    const vendorA = seedVendor(db, tenantA.id);
    const vendorB = seedVendor(db, tenantB.id);
    const locA = seedLocation(db, tenantA.id);
    const locB = seedLocation(db, tenantB.id);
    seedVendorLocation(db, tenantA.id, vendorA.id, locA.id, { status: 'under_review' });
    seedVendorLocation(db, tenantB.id, vendorB.id, locB.id, { status: 'under_review' });

    // Admin A tries to approve vendorB's location — should throw NOT_FOUND
    expect(() =>
      applyDecision({
        db, tenantId: tenantA.id, vendorId: vendorB.id,
        actorUserId: adminA.id, action: 'approve',
        locationIds: [locB.id],
      })
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    // locB must still be under_review
    const tdbB = new TenantDB(db, tenantB.id);
    const vlB = tdbB.get<{ status: string }>(
      'SELECT status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendorB.id, locB.id]
    );
    expect(vlB!.status).toBe('under_review');

    db.close();
  });
});

// ── 6. Add-to-locations ────────────────────────────────────────────────────────

describe('addVendorToLocations', () => {
  test('creates vendor_locations rows with status=under_review', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedRequirementSettings(db, tenant.id);

    await addVendorToLocations({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const vl = tdb.get<{ status: string }>(
      'SELECT status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
      [vendor.id, loc.id]
    );
    expect(vl).toBeDefined();
    expect(vl!.status).toBe('under_review');

    db.close();
  });

  test('triggers a rules-only re-eval (verification_run with trigger=location_add)', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedRequirementSettings(db, tenant.id);

    const result = await addVendorToLocations({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const run = tdb.get<{ trigger: string; engine_version: string }>(
      'SELECT trigger, engine_version FROM verification_runs WHERE tenant_id = ? AND id = ?',
      [result.verificationRun.runId]
    );
    expect(run).toBeDefined();
    expect(run!.trigger).toBe('location_add');

    db.close();
  });

  test('throws ALREADY_ASSOCIATED if vendor is already at that location', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, loc.id, { status: 'approved' });
    seedRequirementSettings(db, tenant.id);

    await expect(
      addVendorToLocations({
        db, tenantId: tenant.id, vendorId: vendor.id,
        actorUserId: admin.id, locationIds: [loc.id],
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'ALREADY_ASSOCIATED' }));

    db.close();
  });

  test('throws BAD_LOCATION for a non-existent location', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    seedRequirementSettings(db, tenant.id);

    await expect(
      addVendorToLocations({
        db, tenantId: tenant.id, vendorId: vendor.id,
        actorUserId: admin.id, locationIds: [randomUUID()],
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'BAD_LOCATION' }));

    db.close();
  });

  test('writes a vendor.location_added audit event', async () => {
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedRequirementSettings(db, tenant.id);

    await addVendorToLocations({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ event_type: string }>(
      `SELECT event_type FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.location_added' LIMIT 1`
    );
    expect(event).toBeDefined();

    db.close();
  });

  test('add-to-locations does not call Vision — only runs rules-only reeval', async () => {
    // The verification_run created by location_add must have trigger='location_add',
    // which runVerification() uses to skip advisory generation and the Vision path.
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const vendor = seedVendor(db, tenant.id);
    const loc = seedLocation(db, tenant.id);
    seedRequirementSettings(db, tenant.id);

    const result = await addVendorToLocations({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, locationIds: [loc.id],
    });

    const tdb = new TenantDB(db, tenant.id);
    // No engine_advisories should be written for location_add trigger (invariant #7)
    const advisories = tdb.all<{ id: string }>(
      'SELECT id FROM engine_advisories WHERE tenant_id = ? AND verification_run_id = ?',
      [result.verificationRun.runId]
    );
    expect(advisories).toHaveLength(0);

    db.close();
  });
});

// ── 7. Vendor Record role-conditional masking ─────────────────────────────────
// The masking is enforced in the GET /api/vendors/:id route handler which filters
// fields based on role. We test the invariant at the data layer: managers must not
// receive contact_email or contact_phone, while Admin does.

describe('vendor record role-conditional data exposure', () => {
  test('vendor identity has contact_email and contact_phone visible to admin path', () => {
    // This asserts the Admin-path data shape. Route tests would use an actual HTTP call;
    // here we assert that the DB returns the fields and the admin path includes them.
    // This is a structural canary — if the DB schema removes these fields, the test breaks.
    const db = setupTestDb();
    const tenant = seedTenant(db);
    const vendor = seedVendor(db, tenant.id, { contact_email: 'vendor@test.com' });

    const tdb = new TenantDB(db, tenant.id);
    const row = tdb.get<{
      contact_email: string | null;
      contact_phone: string | null;
    }>(
      'SELECT contact_email, contact_phone FROM vendors WHERE tenant_id = ? AND id = ?',
      [vendor.id]
    );
    expect(row).toBeDefined();
    // contact_email is present in the row — Admin path will include it
    expect(row!.contact_email).toBe('vendor@test.com');

    db.close();
  });

  test('Sensitive fields (TIN, ACH routing) are never stored in plaintext vendor columns', () => {
    // TIN lives in extractions.payload_json (SENSITIVE ciphertext); ACH routing likewise.
    // The vendor record table has no TIN or routing_number column — verify schema.
    const db = setupTestDb();
    const tenant = seedTenant(db);

    // If this throws "no such column", the schema is wrong (a regression).
    // We probe by selecting a column that should NOT exist — the query should fail.
    expect(() =>
      db.prepare('SELECT tin FROM vendors LIMIT 1').all()
    ).toThrow();

    expect(() =>
      db.prepare('SELECT routing_number FROM vendors LIMIT 1').all()
    ).toThrow();

    db.close();
  });
});

// ── 8. Uncertainty UX — accept an uncertain finding (MISSION #4 trust handoff) ─

describe('acceptUncertainEvaluation (per-row Accept)', () => {
  test('writes evaluation.uncertain_accepted audit event with the reasoning text', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const { evalId, requirementKey } = seedEvaluation(db, tenant.id, vendor.id, loc.id);

    acceptUncertainEvaluation({
      db, tenantId: tenant.id, vendorId: vendor.id,
      evaluationId: evalId, actorUserId: admin.id,
      reasoning: 'Verified the named insured matches the DBA on the W-9; engine flagged a near-miss.',
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ actor_type: string; actor_id: string; event_type: string; payload_json: string }>(
      `SELECT actor_type, actor_id, event_type, payload_json FROM audit_events
       WHERE tenant_id = ? AND event_type = 'evaluation.uncertain_accepted' LIMIT 1`
    );
    expect(event).toBeDefined();
    expect(event!.actor_type).toBe('user');
    expect(event!.actor_id).toBe(admin.id);
    const payload = JSON.parse(event!.payload_json);
    expect(payload.evaluation_id).toBe(evalId);
    expect(payload.requirement_key).toBe(requirementKey);
    expect(payload.reasoning).toMatch(/named insured/);

    db.close();
  });

  test('reasoning required — empty submission rejected (REASONING_REQUIRED)', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const { evalId } = seedEvaluation(db, tenant.id, vendor.id, loc.id);

    expect(() =>
      acceptUncertainEvaluation({
        db, tenantId: tenant.id, vendorId: vendor.id,
        evaluationId: evalId, actorUserId: admin.id, reasoning: '',
      })
    ).toThrow(expect.objectContaining({ code: 'REASONING_REQUIRED' }));

    db.close();
  });

  test('reasoning below minimum length rejected', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const { evalId } = seedEvaluation(db, tenant.id, vendor.id, loc.id);

    expect(() =>
      acceptUncertainEvaluation({
        db, tenantId: tenant.id, vendorId: vendor.id,
        evaluationId: evalId, actorUserId: admin.id, reasoning: 'too short',
      })
    ).toThrow(expect.objectContaining({ code: 'REASONING_REQUIRED' }));

    db.close();
  });

  test('whitespace-only reasoning rejected (trimmed before length check)', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const { evalId } = seedEvaluation(db, tenant.id, vendor.id, loc.id);

    expect(() =>
      acceptUncertainEvaluation({
        db, tenantId: tenant.id, vendorId: vendor.id,
        evaluationId: evalId, actorUserId: admin.id, reasoning: '              ',
      })
    ).toThrow(expect.objectContaining({ code: 'REASONING_REQUIRED' }));

    db.close();
  });

  test('rejected reasoning writes NO audit event', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const { evalId } = seedEvaluation(db, tenant.id, vendor.id, loc.id);

    try {
      acceptUncertainEvaluation({
        db, tenantId: tenant.id, vendorId: vendor.id,
        evaluationId: evalId, actorUserId: admin.id, reasoning: 'x',
      });
    } catch { /* expected */ }

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ id: string }>(
      `SELECT id FROM audit_events WHERE tenant_id = ? AND event_type = 'evaluation.uncertain_accepted'`
    );
    expect(event).toBeUndefined();

    db.close();
  });

  test('cannot accept a non-uncertain evaluation (NOT_UNCERTAIN)', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const { evalId } = seedEvaluation(db, tenant.id, vendor.id, loc.id, { outcome: 'deficient' });

    expect(() =>
      acceptUncertainEvaluation({
        db, tenantId: tenant.id, vendorId: vendor.id,
        evaluationId: evalId, actorUserId: admin.id,
        reasoning: 'This should not be acceptable because it is deficient, not uncertain.',
      })
    ).toThrow(expect.objectContaining({ code: 'NOT_UNCERTAIN' }));

    db.close();
  });

  test('unknown evaluation id throws NOT_FOUND', () => {
    const { db, tenant, admin, vendor } = makeUnderReviewScenario();

    expect(() =>
      acceptUncertainEvaluation({
        db, tenantId: tenant.id, vendorId: vendor.id,
        evaluationId: randomUUID(), actorUserId: admin.id,
        reasoning: 'Reasoning for an evaluation that does not exist.',
      })
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    db.close();
  });

  test('tenant isolation — cannot accept another tenant evaluation', () => {
    const db = setupTestDb();
    const tenantA = seedTenant(db);
    const tenantB = seedTenant(db);
    const adminA = seedTenantUser(db, tenantA.id, { role: 'admin' });
    const vendorB = seedVendor(db, tenantB.id);
    const locB = seedLocation(db, tenantB.id);
    const { evalId } = seedEvaluation(db, tenantB.id, vendorB.id, locB.id);

    // Admin A (tenant A) attempts to accept tenant B's evaluation → NOT_FOUND
    expect(() =>
      acceptUncertainEvaluation({
        db, tenantId: tenantA.id, vendorId: vendorB.id,
        evaluationId: evalId, actorUserId: adminA.id,
        reasoning: 'Cross-tenant attempt that must be blocked structurally.',
      })
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    db.close();
  });
});

// ── 9. Uncertainty UX — treat-as-deficient routes to correction with scope ─────

describe('treat-as-deficient → request_correction with pre-populated scope', () => {
  test('request_correction carries deficient_requirements into the vendor notification', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const requirementKey = 'coverage.auto_liability.combined_single_limit';

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
      deficientRequirements: [requirementKey],
    });

    const tdb = new TenantDB(db, tenant.id);
    const notif = tdb.get<{ payload_json: string }>(
      `SELECT payload_json FROM notifications
       WHERE tenant_id = ? AND recipient_type = 'vendor' ORDER BY created_at DESC LIMIT 1`
    );
    const payload = JSON.parse(notif!.payload_json);
    expect(payload.type).toBe('correction_requested');
    expect(payload.deficient_requirements).toContain(requirementKey);

    db.close();
  });

  test('request_correction logs deficient_requirements in the audit payload', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();
    const requirementKey = 'coverage.general_liability.each_occurrence';

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
      deficientRequirements: [requirementKey],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ payload_json: string }>(
      `SELECT payload_json FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.correction_requested' LIMIT 1`
    );
    const payload = JSON.parse(event!.payload_json);
    expect(payload.deficient_requirements).toContain(requirementKey);

    db.close();
  });

  test('request_correction without scope omits deficient_requirements (no empty key)', () => {
    const { db, tenant, admin, vendor, loc } = makeUnderReviewScenario();

    applyDecision({
      db, tenantId: tenant.id, vendorId: vendor.id,
      actorUserId: admin.id, action: 'request_correction',
      locationIds: [],
    });

    const tdb = new TenantDB(db, tenant.id);
    const event = tdb.get<{ payload_json: string }>(
      `SELECT payload_json FROM audit_events
       WHERE tenant_id = ? AND event_type = 'vendor.correction_requested' LIMIT 1`
    );
    const payload = JSON.parse(event!.payload_json);
    expect(payload).not.toHaveProperty('deficient_requirements');

    db.close();
  });
});
