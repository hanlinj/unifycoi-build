// tests/vendors-operator.pg.test.ts — Phase 13 migration, Stage 6a: verifies the operator-side
// vendor data layer against real Postgres — vendors.ts, resend-invite.ts, decision.ts, and the
// new shared issueInviteToken() choke point (src/lib/auth/invite-token.ts).
//
// Stage 6a lands a deliberate security change, not pure behavior-preservation: revoke-on-issue
// (see ADR-013-01). Before this stage, a vendor invite token was reusable for its full 14-day
// TTL with no consumption/invalidation step at all. Now, issuing ANY new invite for a vendor
// (new / resend / request_correction — all three mint paths, uniformly, regardless of purpose)
// revokes every other still-live prior invite for that vendor first, inside one transaction.
// This file's revoke-on-issue tests are the primary new coverage this stage adds, beyond the
// usual conversion pass-through.
//
// add-to-locations.ts and its route are deliberately NOT converted this stage — see the Stage 6
// report for why (hard dependency on verification/run.ts's runVerification/loadExtractionBundle
// and requirements/resolver.ts's resolveRequirements, which are genuinely Stage 7's charter and
// shared by the portal's submit route too — converting them here would silently expand this
// stage well past "the four operator files").
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { createTenant } from '@/lib/services/tenants';
import { createVendorInvite } from '@/lib/services/vendors';
import { resendInvite, ResendInviteError } from '@/lib/services/resend-invite';
import { applyDecision, acceptUncertainEvaluation, DecisionError, AcceptEvaluationError } from '@/lib/services/decision';
import type { Db } from '@/lib/db/client';

async function seedTenantId(db: Db, name = 'Test Tenant'): Promise<string> {
  const tenant = await createTenant(db, { name, slug: `t-${randomUUID().slice(0, 8)}` }, 'p1');
  return tenant.id;
}

async function seedLocation(db: Db, tenantId: string, name = 'Loc A'): Promise<string> {
  const id = randomUUID();
  await db.insertInto('locations').values({
    id, tenant_id: tenantId, name, address: null, status: 'active', created_at: new Date(),
  }).execute();
  return id;
}

async function seedUser(db: Db, tenantId: string, role = 'admin'): Promise<string> {
  const id = randomUUID();
  await db.insertInto('users').values({
    id, tenant_id: tenantId, email: `${id}@x.test`, name: 'Actor', role,
    password_hash: null, status: 'active', created_at: new Date(),
  }).execute();
  return id;
}

const BASE_INVITE_INPUT = {
  businessName: 'Acme Fire Safety',
  contactFirstName: 'Pat',
  contactLastName: 'Smith',
  email: 'pat@acmefire.test',
  companyPhone: '555-0100',
  trade: 'fire_suppression',
};

describe('db-core (Stage 6a): vendors.ts — createVendorInvite', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let inviterUserId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    inviterUserId = await seedUser(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('creates a vendor, an onboarding invite, vendor_locations rows, a queued notification, and an audit event, atomically', async () => {
    const result = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId });
    expect(result.type).toBe('created');
    if (result.type !== 'created') throw new Error('unreachable');

    const vendor = await db.selectFrom('vendors').selectAll().where('id', '=', result.vendorId).executeTakeFirstOrThrow();
    expect(vendor.business_name).toBe('Acme Fire Safety');

    const invite = await db.selectFrom('invites').selectAll().where('id', '=', result.inviteId).executeTakeFirstOrThrow();
    expect(invite.purpose).toBe('onboarding');
    expect(invite.revoked_at).toBeNull();
    expect(invite.token).not.toBe(''); // hash stored, not the raw token

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', result.vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('invited_pending');

    const notif = await db.selectFrom('notifications').selectAll().where('recipient_ref', '=', BASE_INVITE_INPUT.email).executeTakeFirstOrThrow();
    expect((notif.payload_json as { type: string }).type).toBe('vendor_invite'); // jsonb — already parsed

    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'vendor.invited').executeTakeFirstOrThrow();
    expect((audit.payload_json as { invite_id: string }).invite_id).toBe(result.inviteId);
  });

  test('duplicate email (case-insensitive) returns type "duplicate", not a second vendor', async () => {
    const first = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId });
    if (first.type !== 'created') throw new Error('unreachable');

    const dup = await createVendorInvite(db, tenantId, {
      ...BASE_INVITE_INPUT, email: 'PAT@ACMEFIRE.TEST', locationIds: [locationId], inviterUserId,
    });
    expect(dup).toEqual({ type: 'duplicate', existingVendorId: first.vendorId, existingBusinessName: 'Acme Fire Safety' });
  });

  test('rejects an invite referencing a non-existent or archived location, before writing anything', async () => {
    await expect(
      createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [randomUUID()], inviterUserId })
    ).rejects.toMatchObject({ status: 400 });

    const vendor = await db.selectFrom('vendors').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
    expect(vendor).toBeUndefined(); // nothing committed
  });

  test('rolls back the entire transaction (vendor + invite + locations + notification) if a later step fails', async () => {
    // Two locations, the second nonexistent — validation happens up front, so nothing should
    // even reach the transaction. This proves the pre-transaction guard, not mid-transaction
    // rollback specifically, but the ALL-OR-NOTHING outcome is what matters here.
    await expect(
      createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId, randomUUID()], inviterUserId })
    ).rejects.toMatchObject({ status: 400 });
    const vendor = await db.selectFrom('vendors').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
    expect(vendor).toBeUndefined();
  });
});

describe('db-core (Stage 6a): resend-invite.ts', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let inviterUserId: string;
  let vendorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    inviterUserId = await seedUser(db, tenantId);
    const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId });
    if (created.type !== 'created') throw new Error('unreachable');
    vendorId = created.vendorId;
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('issues a fresh onboarding invite and queues a "resent" notification', async () => {
    const result = await resendInvite(db, tenantId, vendorId, inviterUserId);
    const invite = await db.selectFrom('invites').selectAll().where('id', '=', result.inviteId).executeTakeFirstOrThrow();
    expect(invite.purpose).toBe('onboarding');
    expect(invite.revoked_at).toBeNull();

    const notif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).where('recipient_ref', '=', BASE_INVITE_INPUT.email).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect((notif.payload_json as { resent: boolean }).resent).toBe(true);
  });

  test('vendor not found -> NOT_FOUND', async () => {
    await expect(resendInvite(db, tenantId, randomUUID(), inviterUserId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('vendor with no contact email -> NO_EMAIL', async () => {
    const noEmailVendorId = randomUUID();
    await db.insertInto('vendors').values({
      id: noEmailVendorId, tenant_id: tenantId, business_name: 'No Email Co', contact_email: null, trade: 'plumbing', created_at: new Date(),
    }).execute();
    await expect(resendInvite(db, tenantId, noEmailVendorId, inviterUserId)).rejects.toMatchObject({ code: 'NO_EMAIL' });
  });
});

describe('db-core (Stage 6a): decision.ts', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let actorUserId: string;
  let vendorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    actorUserId = await seedUser(db, tenantId);
    const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId: actorUserId });
    if (created.type !== 'created') throw new Error('unreachable');
    vendorId = created.vendorId;
    // Fast-forward straight to under_review, bypassing the verification engine (Stage 7's
    // charter, not touched this stage) — decision.ts only cares that the row IS under_review.
    await db.updateTable('vendor_locations').set({ status: 'under_review' }).where('vendor_id', '=', vendorId).execute();
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('approve: flips status, clears the action_needed flag (jsonb, not JSON.parse()d), writes an audit event', async () => {
    await db.updateTable('vendor_locations').set({ flags_json: JSON.stringify({ action_needed: true, other: 1 }) }).where('vendor_id', '=', vendorId).execute();

    const result = await applyDecision({ db, tenantId, vendorId, actorUserId, action: 'approve', locationIds: [locationId] });
    expect(result).toMatchObject({ action: 'approve', updated: [locationId], skipped: [] });

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('approved');
    expect(vl.approved_by).toBe(actorUserId);
    expect(vl.flags_json).toEqual({ other: 1 }); // action_needed removed, "other" survives

    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'vendor.approved').executeTakeFirstOrThrow();
    expect((audit.payload_json as { location_id: string }).location_id).toBe(locationId);
  });

  test('reject: flips to declined and notifies all tenant admins', async () => {
    const result = await applyDecision({ db, tenantId, vendorId, actorUserId, action: 'reject', locationIds: [locationId], reason: 'insufficient coverage' });
    expect(result).toMatchObject({ action: 'reject', updated: [locationId] });

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('declined');

    const adminNotif = await db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId).where('recipient_type', '=', 'user').executeTakeFirstOrThrow();
    expect((adminNotif.payload_json as { type: string; reason: string }).type).toBe('vendor_declined');
  });

  test('a location not in under_review status -> CONFLICT', async () => {
    await db.updateTable('vendor_locations').set({ status: 'approved' }).where('vendor_id', '=', vendorId).execute();
    await expect(applyDecision({ db, tenantId, vendorId, actorUserId, action: 'approve', locationIds: [locationId] })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('vendor not found -> NOT_FOUND', async () => {
    await expect(applyDecision({ db, tenantId, vendorId: randomUUID(), actorUserId, action: 'approve', locationIds: [locationId] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('request_correction: transitions ALL under_review locations to onboarding + action_needed, issues a correction invite', async () => {
    const result = await applyDecision({ db, tenantId, vendorId, actorUserId, action: 'request_correction', locationIds: [], deficientRequirements: ['coverage.general_liability'] });
    expect(result.action).toBe('request_correction');
    expect(result.locationsTransitioned).toEqual([locationId]);

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('onboarding');
    expect(vl.flags_json).toEqual({ action_needed: true });

    const invite = await db.selectFrom('invites').selectAll().where('id', '=', result.inviteId!).executeTakeFirstOrThrow();
    expect(invite.purpose).toBe('correction');
    expect(invite.revoked_at).toBeNull();
  });

  test('request_correction with no under_review locations -> NO_UNDER_REVIEW', async () => {
    await db.updateTable('vendor_locations').set({ status: 'approved' }).where('vendor_id', '=', vendorId).execute();
    await expect(applyDecision({ db, tenantId, vendorId, actorUserId, action: 'request_correction', locationIds: [] })).rejects.toMatchObject({ code: 'NO_UNDER_REVIEW' });
  });

  test('acceptUncertainEvaluation: requires >=10 char reasoning, requires outcome="uncertain", logs an audit event', async () => {
    const runId = randomUUID();
    await db.insertInto('verification_runs').values({
      id: runId, tenant_id: tenantId, vendor_id: vendorId, trigger: 'onboarding', engine_version: 'v1',
      recommendation: 'uncertain', created_at: new Date(),
    }).execute();
    const evalId = randomUUID();
    await db.insertInto('requirement_evaluations').values({
      id: evalId, tenant_id: tenantId, run_id: runId, vendor_id: vendorId, location_id: locationId,
      requirement_key: 'coverage.general_liability', comparison_result: 'indeterminate', outcome: 'uncertain',
    }).execute();

    await expect(
      acceptUncertainEvaluation({ db, tenantId, vendorId, evaluationId: evalId, actorUserId, reasoning: 'too short' })
    ).rejects.toMatchObject({ code: 'REASONING_REQUIRED' });

    await acceptUncertainEvaluation({ db, tenantId, vendorId, evaluationId: evalId, actorUserId, reasoning: 'Reviewed manually, coverage confirmed by phone.' });
    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'evaluation.uncertain_accepted').executeTakeFirstOrThrow();
    expect((audit.payload_json as { evaluation_id: string }).evaluation_id).toBe(evalId);

    await expect(
      acceptUncertainEvaluation({ db, tenantId, vendorId, evaluationId: randomUUID(), actorUserId, reasoning: 'Reviewed manually, coverage confirmed by phone.' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('db-core (Stage 6a): revoke-on-issue — the deliberate security change (ADR-013-01)', () => {
  let db: Db;
  let tenantId: string;
  let locationId: string;
  let actorUserId: string;

  async function liveInvites(vendorId: string): Promise<{ id: string; purpose: string }[]> {
    return db.selectFrom('invites').select(['id', 'purpose']).where('vendor_id', '=', vendorId).where('revoked_at', 'is', null).execute();
  }

  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    locationId = await seedLocation(db, tenantId);
    actorUserId = await seedUser(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('createVendorInvite: the FIRST issuance for a vendor has nothing to revoke — exactly one live invite', async () => {
    const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId: actorUserId });
    if (created.type !== 'created') throw new Error('unreachable');
    const live = await liveInvites(created.vendorId);
    expect(live).toEqual([{ id: created.inviteId, purpose: 'onboarding' }]);
  });

  test('resendInvite: revokes the prior live invite; only the new one stays live', async () => {
    const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId: actorUserId });
    if (created.type !== 'created') throw new Error('unreachable');
    const firstInviteId = created.inviteId;

    const resent = await resendInvite(db, tenantId, created.vendorId, actorUserId);

    const firstInvite = await db.selectFrom('invites').selectAll().where('id', '=', firstInviteId).executeTakeFirstOrThrow();
    expect(firstInvite.revoked_at).not.toBeNull(); // revoked, not deleted

    const live = await liveInvites(created.vendorId);
    expect(live).toEqual([{ id: resent.inviteId, purpose: 'onboarding' }]);
  });

  test('resendInvite called TWICE: each issuance revokes the immediately-prior one, never resurrects an earlier one — always exactly one live invite', async () => {
    const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId: actorUserId });
    if (created.type !== 'created') throw new Error('unreachable');
    const second = await resendInvite(db, tenantId, created.vendorId, actorUserId);
    const third = await resendInvite(db, tenantId, created.vendorId, actorUserId);

    const all = await db.selectFrom('invites').select(['id', 'revoked_at']).where('vendor_id', '=', created.vendorId).execute();
    expect(all).toHaveLength(3);
    const revokedIds = all.filter((r) => r.revoked_at !== null).map((r) => r.id).sort();
    expect(revokedIds).toEqual([created.inviteId, second.inviteId].sort());

    const live = await liveInvites(created.vendorId);
    expect(live).toEqual([{ id: third.inviteId, purpose: 'onboarding' }]);
  });

  test('applyDecision request_correction: revokes a still-live prior invite, INCLUDING one of a different purpose (onboarding)', async () => {
    const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId: actorUserId });
    if (created.type !== 'created') throw new Error('unreachable');
    await db.updateTable('vendor_locations').set({ status: 'under_review' }).where('vendor_id', '=', created.vendorId).execute();

    const result = await applyDecision({ db, tenantId, vendorId: created.vendorId, actorUserId, action: 'request_correction', locationIds: [] });

    const onboardingInvite = await db.selectFrom('invites').selectAll().where('id', '=', created.inviteId).executeTakeFirstOrThrow();
    expect(onboardingInvite.revoked_at).not.toBeNull(); // revoked even though it's a DIFFERENT purpose

    const live = await liveInvites(created.vendorId);
    expect(live).toEqual([{ id: result.inviteId, purpose: 'correction' }]);
  });

  test('revocation is scoped per-vendor: issuing a new invite for vendor B does not touch vendor A\'s live invite', async () => {
    const a = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, locationIds: [locationId], inviterUserId: actorUserId });
    const b = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, email: 'other@vendor.test', locationIds: [locationId], inviterUserId: actorUserId });
    if (a.type !== 'created' || b.type !== 'created') throw new Error('unreachable');

    await resendInvite(db, tenantId, b.vendorId, actorUserId);

    const aInvite = await db.selectFrom('invites').selectAll().where('id', '=', a.inviteId).executeTakeFirstOrThrow();
    expect(aInvite.revoked_at).toBeNull(); // untouched — different vendor
  });
});
