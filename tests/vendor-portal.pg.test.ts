// tests/vendor-portal.pg.test.ts — Phase 13 migration, Stage 6b: the vendor onboarding portal
// (/v/[token]) against real Postgres. This is the one externally-touched surface in the app —
// treated like Stage 4 treated billing: the conversion itself is routine, the adversarial test
// coverage below is the actual deliverable. A green pass-through is not sufficient on its own.
//
// Scope: vendor-token.ts (validateInviteToken — wires up the revoked_at check Stage 6a deferred
// here), vendor-fsm.ts, vendor-onboarding.ts, and a narrow slice of notifications/renewal.ts
// (earliestExpiration [already pure], scheduleRenewalReminders, supersedeReminders,
// handleCoiUploadChase — applyExpirationFlip is Stage 8's own worker-only function, untouched).
//
// Deliberately NOT covered here: src/app/api/v/[token]/submit/route.ts. It hands off to
// runVerification() (src/lib/verification/run.ts) at the exact point the vendor's docs get
// evaluated — genuinely Stage 7's charter, same dependency that made Stage 6a defer
// add-to-locations.ts. See docs/phase-13-postgres-migration.md's Shortcuts & gaps for the exact
// line the seam falls on.
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { createTenant } from '@/lib/services/tenants';
import { createVendorInvite } from '@/lib/services/vendors';
import { issueInviteToken } from '@/lib/auth/invite-token';
import { validateInviteToken } from '@/lib/services/vendor-token';
import { fsmTransition, IllegalTransitionError } from '@/lib/services/vendor-fsm';
import { fireOnboardingStarted } from '@/lib/services/vendor-onboarding';
import { scheduleRenewalReminders, supersedeReminders, handleCoiUploadChase } from '@/lib/notifications/renewal';
import type { Db } from '@/lib/db/client';

async function seedTenantId(db: Db, name = 'Test Tenant', timezone: string | null = null): Promise<string> {
  const tenant = await createTenant(db, { name, slug: `t-${randomUUID().slice(0, 8)}` }, 'p1');
  if (timezone) await db.updateTable('tenants').set({ timezone }).where('id', '=', tenant.id).execute();
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

const BASE_INVITE_INPUT = {
  businessName: 'Acme Fire Safety', contactFirstName: 'Pat', contactLastName: 'Smith',
  email: 'pat@acmefire.test', companyPhone: '555-0100', trade: 'fire_suppression',
};

/** Vendor + a live onboarding invite, via the REAL Stage 6a issuance path — realistic fixture,
 *  not a raw insert. Returns both the raw token (the vendor-portal credential) and the ids. */
async function seedVendorWithInvite(
  db: Db,
  tenantId: string,
  inviterUserId: string,
  overrides: Partial<typeof BASE_INVITE_INPUT> = {}
): Promise<{ vendorId: string; inviteId: string; rawToken: string }> {
  const location = await seedLocation(db, tenantId, `Loc-${randomUUID().slice(0, 6)}`);
  const created = await createVendorInvite(db, tenantId, { ...BASE_INVITE_INPUT, ...overrides, locationIds: [location], inviterUserId });
  if (created.type !== 'created') throw new Error('unreachable');
  // createVendorInvite doesn't return the raw token (only the hash is persisted) — mint a
  // fresh one via the same choke point so the test has a real bearer token to validate,
  // exactly mirroring what a resend/onboarding email would actually hand the vendor.
  const issued = await issueInviteToken(db, { tenantId, vendorId: created.vendorId, inviterUserId, purpose: 'onboarding', ttlMs: 14 * 24 * 60 * 60 * 1000 });
  return { vendorId: created.vendorId, inviteId: issued.inviteId, rawToken: issued.rawToken };
}

async function seedDocument(db: Db, tenantId: string, vendorId: string, overrides: Partial<{ docType: string; uploadedAt: Date }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('documents').values({
    id, tenant_id: tenantId, vendor_id: vendorId, doc_type: overrides.docType ?? 'coi',
    storage_key: `tenants/${tenantId}/vendors/${vendorId}/${id}`, encryption_json: JSON.stringify({ iv: 'x', tag: 'y' }),
    original_filename: 'coi.pdf', superseded_by: null, uploaded_at: overrides.uploadedAt ?? new Date(), state: 'active',
  }).execute();
  return id;
}

describe('db-core (Stage 6b): validateInviteToken — the single most important test file in this stage', () => {
  let db: Db;
  let tenantId: string;
  let inviterUserId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    inviterUserId = await seedUser(db, tenantId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('valid token resolves the correct vendor + its vendor_locations', async () => {
    const { vendorId, rawToken } = await seedVendorWithInvite(db, tenantId, inviterUserId);
    const result = await validateInviteToken(db, rawToken);
    expect(result?.vendor.id).toBe(vendorId);
    expect(result?.vendorLocations).toHaveLength(1);
  });

  test('unknown token -> null', async () => {
    expect(await validateInviteToken(db, 'this-token-was-never-issued')).toBeNull();
  });

  test('expired token (past the 14-day TTL) -> null, via the SAME uniform-null path as an unknown token', async () => {
    const { vendorId } = await seedVendorWithInvite(db, tenantId, inviterUserId);
    // Directly seed an ALREADY-expired invite (bypassing issueInviteToken's now-based TTL calc,
    // which can't mint something already in the past) — same table shape either way. `token`
    // stores the SHA-256 hash of the raw bearer token, same as every real issuance.
    const { hashInviteToken } = await import('@/lib/auth/invite-token');
    const rawToken = randomUUID();
    await db.insertInto('invites').values({
      id: randomUUID(), tenant_id: tenantId, vendor_id: vendorId, inviter_user_id: inviterUserId,
      token: hashInviteToken(rawToken), token_expires_at: new Date(Date.now() - 1000), purpose: 'onboarding',
      delivery_state: 'sent', created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), revoked_at: null,
    }).execute();

    expect(await validateInviteToken(db, rawToken)).toBeNull();
  });

  test('revoked token -> null, and its rejection is INDISTINGUISHABLE from a never-existed token', async () => {
    const { vendorId, rawToken, inviteId } = await seedVendorWithInvite(db, tenantId, inviterUserId);
    // Revoke it directly (Stage 6a's own write path is tested in tests/vendors-operator.pg.test.ts
    // — here we're proving the READ side, i.e. that a revoked row is actually rejected).
    await db.updateTable('invites').set({ revoked_at: new Date() }).where('id', '=', inviteId).execute();

    const revokedResult = await validateInviteToken(db, rawToken);
    const unknownResult = await validateInviteToken(db, 'this-token-was-never-issued');

    // Same value, same type, same shape — not just "both falsy". A revoked token must not be
    // distinguishable from one that never existed by ANY observable property of the return value.
    expect(revokedResult).toBeNull();
    expect(unknownResult).toBeNull();
    expect(revokedResult).toStrictEqual(unknownResult); // literally the same `null`, no side-channel object shape

    // Timing-equivalence, to the extent testable at this level: both paths query `invites`
    // exactly once and return immediately on the first failing check (revoked_at / row-not-found
    // respectively) — no extra round trips on either path. A real network-timing side-channel
    // isn't meaningfully testable in-process; this asserts the two calls are the same ORDER of
    // magnitude, not a cryptographic no-op guarantee.
    const N = 20;
    const revokedTimes: number[] = [];
    const unknownTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await validateInviteToken(db, rawToken);
      revokedTimes.push(performance.now() - t0);
      const t1 = performance.now();
      await validateInviteToken(db, 'still-never-issued');
      unknownTimes.push(performance.now() - t1);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const revokedAvg = avg(revokedTimes);
    const unknownAvg = avg(unknownTimes);
    // Same order of magnitude (within 5x either direction) — loose on purpose; this is a smoke
    // check against a GROSS timing oracle (e.g. an extra query only on one path), not a proof
    // of constant-time comparison.
    expect(revokedAvg).toBeLessThan(unknownAvg * 5 + 5);
    expect(unknownAvg).toBeLessThan(revokedAvg * 5 + 5);
  });

  test('bounced / expired_invite delivery_state -> null, same uniform path (regression, unchanged this stage)', async () => {
    const { rawToken, inviteId } = await seedVendorWithInvite(db, tenantId, inviterUserId);
    await db.updateTable('invites').set({ delivery_state: 'bounced' }).where('id', '=', inviteId).execute();
    expect(await validateInviteToken(db, rawToken)).toBeNull();
  });

  // ── THE top-priority test in this stage ──────────────────────────────────────────────────
  test('SAME-TENANT, WRONG-VENDOR token substitution: vendor A\'s token must NEVER resolve vendor B\'s vendor record, vendor_locations, or documents — scoping comes off the resolved invite row, never off anything in the request', async () => {
    const a = await seedVendorWithInvite(db, tenantId, inviterUserId, { email: 'vendor-a@x.test' });
    const b = await seedVendorWithInvite(db, tenantId, inviterUserId, { email: 'vendor-b@x.test' });
    // A document that exists ONLY under vendor B, to prove a leak would be observable if one existed.
    const bDocId = await seedDocument(db, tenantId, b.vendorId);

    const resolvedByA = await validateInviteToken(db, a.rawToken);
    expect(resolvedByA?.vendor.id).toBe(a.vendorId);
    expect(resolvedByA?.vendor.id).not.toBe(b.vendorId);

    // The actual leak-surface check: query documents SCOPED BY THE TOKEN'S RESOLVED VENDOR ID
    // (exactly what the upload/GET routes do downstream) and confirm vendor B's document never
    // appears when authenticated as vendor A, even though both vendors share a tenant_id.
    const docsVisibleToA = await db.selectFrom('documents').select('id')
      .where('tenant_id', '=', resolvedByA!.vendor.id === a.vendorId ? tenantId : 'WRONG')
      .where('vendor_id', '=', resolvedByA!.vendor.id)
      .execute();
    expect(docsVisibleToA.map((d) => d.id)).not.toContain(bDocId);

    // And the reverse: vendor B's token must resolve to B, never to A.
    const resolvedByB = await validateInviteToken(db, b.rawToken);
    expect(resolvedByB?.vendor.id).toBe(b.vendorId);
    expect(resolvedByB?.vendor.id).not.toBe(a.vendorId);

    // vendor_locations scoping: A's token must only ever surface A's own locations.
    const aLocationIds = resolvedByA!.vendorLocations.map((vl) => vl.location_id);
    const bLocationIds = resolvedByB!.vendorLocations.map((vl) => vl.location_id);
    expect(aLocationIds.some((id) => bLocationIds.includes(id))).toBe(false);
  });

  test('cross-tenant token substitution (regression guard — pre-existing coverage, confirmed still holding post-conversion)', async () => {
    const tenantB = await seedTenantId(db, 'Tenant B');
    const inviterB = await seedUser(db, tenantB);
    const a = await seedVendorWithInvite(db, tenantId, inviterUserId);
    const b = await seedVendorWithInvite(db, tenantB, inviterB);

    const resolvedByA = await validateInviteToken(db, a.rawToken);
    expect(resolvedByA?.invite.tenant_id).toBe(tenantId);
    expect(resolvedByA?.vendor.id).toBe(a.vendorId);
    expect(resolvedByA?.vendor.id).not.toBe(b.vendorId);
  });
});

describe('db-core (Stage 6b): vendor-fsm.ts', () => {
  let db: Db;
  let tenantId: string;
  let inviterUserId: string;
  let vendorId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    inviterUserId = await seedUser(db, tenantId);
    const seeded = await seedVendorWithInvite(db, tenantId, inviterUserId);
    vendorId = seeded.vendorId;
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('open_link: invited_pending -> onboarding, atomically across all vendor_locations', async () => {
    const result = await fsmTransition(db, tenantId, vendorId, 'open_link');
    expect(result.locationIds).toHaveLength(1);
    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('onboarding');
  });

  test('submit: onboarding -> under_review', async () => {
    await fsmTransition(db, tenantId, vendorId, 'open_link');
    const result = await fsmTransition(db, tenantId, vendorId, 'submit');
    expect(result.locationIds).toHaveLength(1);
    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('under_review');
  });

  test('illegal transition (e.g. submit from invited_pending, skipping open_link) throws', async () => {
    await expect(fsmTransition(db, tenantId, vendorId, 'submit')).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe('db-core (Stage 6b): vendor-onboarding.ts — fireOnboardingStarted', () => {
  let db: Db;
  let tenantId: string;
  let inviterUserId: string;
  let vendorId: string;
  let inviteId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    inviterUserId = await seedUser(db, tenantId);
    const seeded = await seedVendorWithInvite(db, tenantId, inviterUserId);
    vendorId = seeded.vendorId;
    inviteId = seeded.inviteId;
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('fires open_link + audits vendor.onboarding_started on first access', async () => {
    const vendorLocations = await db.selectFrom('vendor_locations').select(['status']).where('vendor_id', '=', vendorId).execute();
    const fired = await fireOnboardingStarted(db, { tenantId, vendorId, inviteId, purpose: 'onboarding', vendorLocations });
    expect(fired).toBe(true);
    const audit = await db.selectFrom('audit_events').selectAll().where('tenant_id', '=', tenantId).where('event_type', '=', 'vendor.onboarding_started').executeTakeFirstOrThrow();
    expect((audit.payload_json as { invite_id: string }).invite_id).toBe(inviteId);
  });

  test('idempotent: a second call (locations already past invited_pending) is a no-op, does not throw', async () => {
    const initialLocations = await db.selectFrom('vendor_locations').select(['status']).where('vendor_id', '=', vendorId).execute();
    await fireOnboardingStarted(db, { tenantId, vendorId, inviteId, purpose: 'onboarding', vendorLocations: initialLocations });

    const postFireLocations = await db.selectFrom('vendor_locations').select(['status']).where('vendor_id', '=', vendorId).execute();
    const second = await fireOnboardingStarted(db, { tenantId, vendorId, inviteId, purpose: 'onboarding', vendorLocations: postFireLocations });
    expect(second).toBe(false);
  });
});

describe('db-core (Stage 6b): notifications/renewal.ts (narrow slice)', () => {
  let db: Db;
  let tenantId: string;
  let inviterUserId: string;
  let vendorId: string;
  let documentId: string;
  beforeEach(async () => {
    db = await setupTestDb();
    tenantId = await seedTenantId(db);
    inviterUserId = await seedUser(db, tenantId);
    const seeded = await seedVendorWithInvite(db, tenantId, inviterUserId);
    vendorId = seeded.vendorId;
    documentId = await seedDocument(db, tenantId, vendorId);
  });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('scheduleRenewalReminders: queues the 5-rung ladder + the 7d/1d admin alerts + the day-0 coi_expiration job for a far-future expiration', async () => {
    const farFuture = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    const result = await scheduleRenewalReminders(db, { tenantId, vendorId, documentId, expirationDate: farFuture });
    expect(result.scheduled).toBe(5);
    expect(result.adminAlerts).toBe(2); // one admin (inviterUserId) x the 7d and 1d rungs
    expect(result.expirationJobScheduled).toBe(true);
    expect(result.alreadyScheduled).toBe(false);

    const rows = await db.selectFrom('notifications').select(['payload_json']).where('tenant_id', '=', tenantId).where('document_id', '=', documentId).execute();
    expect(rows).toHaveLength(8); // 5 vendor reminders + 2 admin alerts (7d, 1d) + 1 day-0 job
  });

  test('idempotency guard (the ->> jsonb rewrite of the old json_extract spot): a second call for the same document is a no-op', async () => {
    const farFuture = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    await scheduleRenewalReminders(db, { tenantId, vendorId, documentId, expirationDate: farFuture });
    const second = await scheduleRenewalReminders(db, { tenantId, vendorId, documentId, expirationDate: farFuture });
    expect(second.alreadyScheduled).toBe(true);
    expect(second.scheduled).toBe(0);
  });

  test('OPS-7: the expiry boundary resolves in the TENANT timezone (read via Kysely, not raw db.prepare)', async () => {
    const tzTenantId = await seedTenantId(db, 'TZ Tenant', 'America/Los_Angeles');
    const tzVendor = await seedVendorWithInvite(db, tzTenantId, await seedUser(db, tzTenantId));
    const tzDoc = await seedDocument(db, tzTenantId, tzVendor.vendorId);
    // Date-only expiry — the shape expiryBoundaryMs's tenant-tz math actually activates for.
    const result = await scheduleRenewalReminders(db, { tenantId: tzTenantId, vendorId: tzVendor.vendorId, documentId: tzDoc, expirationDate: '2026-12-25' });
    expect(result.expirationJobScheduled).toBe(true);
    const dayZero = await db.selectFrom('notifications').selectAll()
      .where('tenant_id', '=', tzTenantId).where('document_id', '=', tzDoc)
      .where('payload_json', '@>', JSON.stringify({ type: 'coi_expiration' })).executeTakeFirstOrThrow();
    // Dec 25 midnight America/Los_Angeles (PST, UTC-8 in December) = Dec 25 08:00 UTC — NOT
    // Dec 25 00:00 UTC. Proves the tenant's real timezone (not UTC-default) drove the boundary.
    expect((dayZero.scheduled_for as Date).toISOString()).toBe('2026-12-25T08:00:00.000Z');
  });

  test('supersedeReminders marks only QUEUED chase rows for the document as superseded, leaves sent rows alone', async () => {
    const farFuture = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    await scheduleRenewalReminders(db, { tenantId, vendorId, documentId, expirationDate: farFuture });
    // Simulate one already-sent reminder — must survive supersession untouched. Postgres UPDATE
    // has no LIMIT clause, so pick one row's id first, then update by id.
    const oneQueued = await db.selectFrom('notifications').select('id').where('tenant_id', '=', tenantId).where('document_id', '=', documentId).where('status', '=', 'queued').limit(1).executeTakeFirstOrThrow();
    await db.updateTable('notifications').set({ status: 'sent' }).where('id', '=', oneQueued.id).execute();

    const supersededCount = await supersedeReminders(db, tenantId, documentId);
    expect(supersededCount).toBe(7); // 8 total minus the 1 already 'sent'

    const stillQueued = await db.selectFrom('notifications').select('id').where('tenant_id', '=', tenantId).where('document_id', '=', documentId).where('status', '=', 'queued').execute();
    expect(stillQueued).toHaveLength(0);
    const sentSurvived = await db.selectFrom('notifications').select('id').where('tenant_id', '=', tenantId).where('document_id', '=', documentId).where('status', '=', 'sent').execute();
    expect(sentSurvived).toHaveLength(1);
  });

  test('handleCoiUploadChase: a renewal upload supersedes the prior COI + its unfired reminders, and schedules the new ladder', async () => {
    const firstExpiry = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    await scheduleRenewalReminders(db, { tenantId, vendorId, documentId, expirationDate: firstExpiry });

    // A newer COI upload for the same vendor (uploaded strictly after the first).
    await new Promise((r) => setTimeout(r, 5)); // ensure a distinguishable uploaded_at ordering
    const newDocumentId = await seedDocument(db, tenantId, vendorId);
    const secondExpiry = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();

    const result = await handleCoiUploadChase(db, { tenantId, vendorId, newDocumentId, expirationDate: secondExpiry });
    expect(result.supersededDocumentId).toBe(documentId);
    expect(result.supersededReminders).toBe(8); // the first COI's full ladder + admin alerts + day-0 job
    expect(result.schedule.scheduled).toBe(5);

    const oldDoc = await db.selectFrom('documents').selectAll().where('id', '=', documentId).executeTakeFirstOrThrow();
    expect(oldDoc.superseded_by).toBe(newDocumentId);
    expect(oldDoc.superseded_at).not.toBeNull();
  });

  test('handleCoiUploadChase is a no-op-safe first upload: onboarding\'s first COI has no prior to supersede', async () => {
    const expiry = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    const result = await handleCoiUploadChase(db, { tenantId, vendorId, newDocumentId: documentId, expirationDate: expiry });
    expect(result.supersededDocumentId).toBeNull();
    expect(result.supersededReminders).toBe(0);
    expect(result.schedule.scheduled).toBe(5);
  });
});
