// Phase 7, Slice A — audit coverage regression guard.
//
// Proves the audit coverage report (docs/audit-coverage.md) stays honest: each audited
// service-layer mutation, when run against a real in-memory DB, writes its expected
// audit_events row. A new mutation that ships without its event — or a deleted logAudit
// call — fails here. Non-vacuous: every assertion runs the real mutation, not a stub.
//
// Also asserts (Slice A invariant #10): a representative set of audit payloads contains no
// raw Sensitive patterns. The exhaustive end-to-end Sensitive scan is in Slice E.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedPlatformUser,
  seedLocation,
  seedVendor,
  seedVendorLocation,
  seedRequirementSettings,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { createVendorInvite } from '@/lib/services/vendors';
import { applyDecision, acceptUncertainEvaluation } from '@/lib/services/decision';
import { addVendorToLocations } from '@/lib/services/add-to-locations';
import { createLocation, updateLocation } from '@/lib/services/locations';
import { createUser, updateUser, inviteUser } from '@/lib/services/users';
import { setRequirementRule, setPrecedence } from '@/lib/services/requirements';
import { createTenant, updateTenant, impersonateTenant } from '@/lib/services/tenants';
import { applyTemplate, seedTemplates } from '@/lib/requirements/templates';
import { runVerification } from '@/lib/verification/run';
import { fireOnboardingStarted } from '@/lib/services/vendor-onboarding';

const ADMIN_SCOPE = { locationIds: null, regionIds: null };

function lastEvent(db: Database.Database, tenantId: string, eventType: string) {
  const tdb = new TenantDB(db, tenantId);
  return tdb.get<{ event_type: string; actor_type: string; actor_id: string | null; payload_json: string | null }>(
    `SELECT event_type, actor_type, actor_id, payload_json FROM audit_events
     WHERE tenant_id = ? AND event_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [eventType]
  );
}

function expectEvent(db: Database.Database, tenantId: string, eventType: string, actorType?: string) {
  const ev = lastEvent(db, tenantId, eventType);
  expect(ev).toBeDefined();
  if (actorType) expect(ev!.actor_type).toBe(actorType);
  return ev!;
}

// ── vendor.invited ─────────────────────────────────────────────────────────────

describe('audit coverage — service mutations write expected events', () => {
  test('createVendorInvite → vendor.invited (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);

    createVendorInvite(db, t.id, {
      businessName: 'Acme Co', contactFirstName: 'Sam', contactLastName: 'Vale',
      email: 'sam@acme.test', companyPhone: '555-1212', trade: 'plumbing',
      locationIds: [loc.id], inviterUserId: admin.id,
    });

    expectEvent(db, t.id, 'vendor.invited', 'user');
    db.close();
  });

  test('applyDecision approve → vendor.approved (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });

    applyDecision({ db, tenantId: t.id, vendorId: v.id, actorUserId: admin.id, action: 'approve', locationIds: [loc.id] });
    expectEvent(db, t.id, 'vendor.approved', 'user');
    db.close();
  });

  test('applyDecision reject → vendor.declined (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });

    applyDecision({ db, tenantId: t.id, vendorId: v.id, actorUserId: admin.id, action: 'reject', locationIds: [loc.id] });
    expectEvent(db, t.id, 'vendor.declined', 'user');
    db.close();
  });

  test('applyDecision request_correction → vendor.correction_requested (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id, { contact_email: 'v@x.test' });
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });

    applyDecision({ db, tenantId: t.id, vendorId: v.id, actorUserId: admin.id, action: 'request_correction', locationIds: [] });
    expectEvent(db, t.id, 'vendor.correction_requested', 'user');
    db.close();
  });

  test('acceptUncertainEvaluation → evaluation.uncertain_accepted (user), reasoning not Sensitive', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    // seed a verification_run + uncertain evaluation
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at)
       VALUES (?, ?, ?, 'onboarding', '1.0.0', 'uncertain', ?)`
    ).run(runId, t.id, v.id, new Date().toISOString());
    const evalId = randomUUID();
    db.prepare(
      `INSERT INTO requirement_evaluations
         (id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value, extracted_value_ref,
          comparison_result, confidence_band, outcome, note)
       VALUES (?, ?, ?, ?, ?, 'coverage.gl.each_occurrence', '1000000', 'ref', 'indeterminate', 'low', 'uncertain', null)`
    ).run(evalId, t.id, runId, v.id, loc.id);

    acceptUncertainEvaluation({
      db, tenantId: t.id, vendorId: v.id, evaluationId: evalId, actorUserId: admin.id,
      reasoning: 'Verified named insured matches the W-9 DBA; engine flagged a near-miss only.',
    });
    const ev = expectEvent(db, t.id, 'evaluation.uncertain_accepted', 'user');
    expect(ev.payload_json).not.toMatch(/\d{3}-\d{2}-\d{4}/); // no SSN-shaped TIN
    db.close();
  });

  test('addVendorToLocations → vendor.location_added (user)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    seedRequirementSettings(db, t.id);

    await addVendorToLocations({ db, tenantId: t.id, vendorId: v.id, actorUserId: admin.id, locationIds: [loc.id] });
    expectEvent(db, t.id, 'vendor.location_added', 'user');
    db.close();
  });

  test('createLocation → location.created (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    createLocation(db, t.id, { name: 'Store 1' }, admin.id);
    expectEvent(db, t.id, 'location.created', 'user');
    db.close();
  });

  test('updateLocation → location.updated (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    updateLocation(db, t.id, loc.id, { name: 'Renamed' }, admin.id);
    expectEvent(db, t.id, 'location.updated', 'user');
    db.close();
  });

  test('createUser → user.created (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    createUser(db, t.id, { email: 'new@x.test', name: 'New User', role: 'admin' }, admin.id, ADMIN_SCOPE, 'admin');
    expectEvent(db, t.id, 'user.created', 'user');
    db.close();
  });

  test('updateUser → user.updated (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const target = seedTenantUser(db, t.id, { role: 'store_manager' });
    updateUser(db, t.id, target.id, { name: 'Changed' }, admin.id);
    expectEvent(db, t.id, 'user.updated', 'user');
    db.close();
  });

  test('inviteUser → user.invited (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const target = seedTenantUser(db, t.id, { role: 'store_manager', status: 'invited' });
    inviteUser(db, t.id, target.id, admin.id);
    expectEvent(db, t.id, 'user.invited', 'user');
    db.close();
  });

  test('setRequirementRule → requirement.rule_changed (user)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    await setRequirementRule(db, t.id, {
      scope: 'org', scope_ref: null,
      requirement_key: 'coverage.general_liability.each_occurrence', required_value: '2000000',
      reason: 'Tightening GL floor for the portfolio.',
    }, admin.id);
    expectEvent(db, t.id, 'requirement.rule_changed', 'user');
    db.close();
  });

  test('setPrecedence → requirement.precedence_changed (user)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    seedRequirementSettings(db, t.id);
    setPrecedence(db, t.id, 'location', admin.id);
    expectEvent(db, t.id, 'requirement.precedence_changed', 'user');
    db.close();
  });

  test('createTenant → tenant.created (platform)', () => {
    const db = setupTestDb();
    const plat = seedPlatformUser(db);
    const tenant = createTenant(db, { name: 'New Client LLC' }, plat.id);
    expectEvent(db, tenant.id, 'tenant.created', 'platform');
    db.close();
  });

  test('updateTenant lifecycle → tenant.lifecycle_changed (platform)', () => {
    const db = setupTestDb();
    const plat = seedPlatformUser(db);
    const tenant = createTenant(db, { name: 'Lifecycle Co' }, plat.id);
    updateTenant(db, tenant.id, { lifecycleState: 'active' }, plat.id);
    expectEvent(db, tenant.id, 'tenant.lifecycle_changed', 'platform');
    db.close();
  });

  test('updateTenant settings (name/rate) → tenant.settings_changed (platform) [FIXED gap]', () => {
    const db = setupTestDb();
    const plat = seedPlatformUser(db);
    const tenant = createTenant(db, { name: 'Original Name', monthlyRateCents: 9000 }, plat.id);
    updateTenant(db, tenant.id, { name: 'Updated Name', monthlyRateCents: 12000 }, plat.id);
    const ev = expectEvent(db, tenant.id, 'tenant.settings_changed', 'platform');
    const payload = JSON.parse(ev.payload_json!);
    expect(payload.changes.name).toEqual({ from: 'Original Name', to: 'Updated Name' });
    expect(payload.changes.monthly_rate_cents).toEqual({ from: 9000, to: 12000 });
    db.close();
  });

  test('impersonateTenant → impersonation.started (platform)', () => {
    const db = setupTestDb();
    const plat = seedPlatformUser(db);
    const tenant = createTenant(db, { name: 'Support Co' }, plat.id);
    impersonateTenant(db, tenant.id, plat.id);
    expectEvent(db, tenant.id, 'impersonation.started', 'platform');
    db.close();
  });

  test('applyTemplate → requirement.template_applied (user) [FIXED gap]', () => {
    const db = setupTestDb();
    const plat = seedPlatformUser(db);
    const tenant = createTenant(db, { name: 'Template Co' }, plat.id);
    // created_by FK requires a tenant user; the applying actor is the tenant admin.
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    seedTemplates(db);
    applyTemplate(db, tenant.id, 'tpl_standard_self_storage', admin.id);
    expectEvent(db, tenant.id, 'requirement.template_applied', 'user');
    db.close();
  });

  test('runVerification → ai.recommendation (ai)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { trade: 'plumbing' });
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });
    seedRequirementSettings(db, t.id);

    await runVerification(db, { tenantId: t.id, vendorId: v.id, vendorTrade: 'plumbing', trigger: 'onboarding' });
    expectEvent(db, t.id, 'ai.recommendation', 'ai');
    db.close();
  });
});

// ── open_link onboarding-started (FIXED gap) ───────────────────────────────────
// Exercises the real fireOnboardingStarted() service that app/v/[token]/route.ts calls.
describe('audit coverage — fixed open_link gap', () => {
  test('fireOnboardingStarted → vendor.onboarding_started (vendor) on first access', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'invited_pending' });

    const fired = fireOnboardingStarted(db, {
      tenantId: t.id, vendorId: v.id, inviteId: 'inv-1', purpose: 'onboarding',
      vendorLocations: [{ status: 'invited_pending' }],
    });
    expect(fired).toBe(true);
    expectEvent(db, t.id, 'vendor.onboarding_started', 'vendor');
    db.close();
  });

  test('fireOnboardingStarted is idempotent — no event when already onboarding', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'onboarding' });

    const fired = fireOnboardingStarted(db, {
      tenantId: t.id, vendorId: v.id, inviteId: 'inv-1', purpose: 'onboarding',
      vendorLocations: [{ status: 'onboarding' }],
    });
    expect(fired).toBe(false);
    expect(lastEvent(db, t.id, 'vendor.onboarding_started')).toBeUndefined();
    db.close();
  });
});
