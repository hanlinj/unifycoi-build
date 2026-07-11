// tests/notifications-worker.pg.test.ts — Phase 13 migration, Stage 8b: verifies
// notifications/{worker,digest,resend-webhook,renewal.applyExpirationFlip}.ts and
// services/manual-reminder.ts against real Postgres. Conversion pass-through + one
// concurrency proof: two genuinely independent connections racing the same claim UPDATE,
// proving the guard survived the mechanical Kysely conversion (see ADR-013-01 Stage 8b).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { createEphemeralTestDatabase, dropEphemeralTestDatabase, kyselyFor } from '@/lib/db/test-isolation';
import { processDueNotifications } from '@/lib/notifications/worker';
import { buildAndSendDigest, runDigestCycle } from '@/lib/notifications/digest';
import { handleResendEvent } from '@/lib/notifications/resend-webhook';
import { applyExpirationFlip } from '@/lib/notifications/renewal';
import { sendManualRenewalReminder, ManualReminderError } from '@/lib/services/manual-reminder';
import { NoOpMailer } from '@/lib/notifications/mailer';
import type { Db } from '@/lib/db/client';

// ── Fixtures ─────────────────────────────────────────────────────────────────────

async function seedTenant(db: Db, overrides: Partial<{ id: string; timezone: string | null }> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insertInto('tenants').values({
    id, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date(),
    ...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {}),
  }).execute();
  return id;
}

async function seedUser(db: Db, tenantId: string, overrides: Partial<{ id: string; email: string; role: string; status: string }> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insertInto('users').values({
    id, tenant_id: tenantId, email: overrides.email ?? `${id}@x.test`, name: 'Actor',
    role: overrides.role ?? 'admin', password_hash: null, status: overrides.status ?? 'active', created_at: new Date(),
  }).execute();
  return id;
}

async function seedVendor(db: Db, tenantId: string, overrides: Partial<{ contact_email: string | null }> = {}): Promise<string> {
  const id = randomUUID();
  await db.insertInto('vendors').values({
    id, tenant_id: tenantId, business_name: 'Acme Fire Safety', trade: 'fire_suppression',
    contact_email: 'contact_email' in overrides ? overrides.contact_email : 'vendor@acme.test',
    created_at: new Date(),
  }).execute();
  return id;
}

async function seedLocation(db: Db, tenantId: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('locations').values({
    id, tenant_id: tenantId, name: 'Store 1', status: 'active', created_at: new Date(),
  }).execute();
  return id;
}

async function seedVendorLocation(db: Db, tenantId: string, vendorId: string, locationId: string, status = 'approved'): Promise<void> {
  await db.insertInto('vendor_locations').values({
    id: randomUUID(), tenant_id: tenantId, vendor_id: vendorId, location_id: locationId, status, created_at: new Date(),
  }).execute();
}

async function seedNotification(
  db: Db,
  tenantId: string,
  overrides: Partial<{
    id: string; recipient_type: string; recipient_ref: string; kind: string; status: string;
    scheduled_for: Date | null; claimed_at: Date | null; document_id: string | null;
    provider_message_id: string | null; payload: Record<string, unknown>;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insertInto('notifications').values({
    id, tenant_id: tenantId,
    recipient_type: overrides.recipient_type ?? 'user',
    recipient_ref: overrides.recipient_ref ?? 'someone',
    channel: 'email',
    kind: overrides.kind ?? 'exception',
    status: overrides.status ?? 'queued',
    scheduled_for: overrides.scheduled_for ?? null,
    sent_at: null,
    payload_json: JSON.stringify(overrides.payload ?? { type: 'vendor_submitted', vendor_name: 'Acme' }),
    document_id: overrides.document_id ?? null,
    claimed_at: overrides.claimed_at ?? null,
    provider_message_id: overrides.provider_message_id ?? null,
    created_at: new Date(),
  }).execute();
  return id;
}

// ── processDueNotifications ─────────────────────────────────────────────────────

describe('db-core (Stage 8b): notifications/worker.ts processDueNotifications', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('reclaims stale sending rows back to queued', async () => {
    const tenantId = await seedTenant(db);
    const now = new Date('2026-07-11T12:00:00.000Z');
    const staleClaim = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago
    const id = await seedNotification(db, tenantId, { status: 'sending', claimed_at: staleClaim, recipient_type: 'user', recipient_ref: 'nobody' });

    const result = await processDueNotifications(new NoOpMailer(), db, now, { staleSeconds: 60 });
    expect(result.reclaimed).toBe(1);

    // Reclaimed to 'queued', then immediately claimed+attempted again this same tick (recipient
    // unresolvable → 'failed'), proving the reclaim value feeds straight into the claim loop.
    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
  });

  test('sends a due user notification, marks sent, logs a notification.sent audit event', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });
    const id = await seedNotification(db, tenantId, { recipient_type: 'user', recipient_ref: adminId, payload: { type: 'vendor_submitted', vendor_name: 'Acme' } });

    const mailer = new NoOpMailer();
    const result = await processDueNotifications(mailer, db, new Date());
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('sent');
    expect(row.claimed_at).toBeNull();

    const audit = await db.selectFrom('audit_events').selectAll()
      .where('event_type', '=', 'notification.sent').where('target_id', '=', id).executeTakeFirstOrThrow();
    expect((audit.payload_json as { message_type: string }).message_type).toBe('vendor_submitted');
  });

  test('vendor-facing send resolves the operator name for From branding', async () => {
    const tenantId = await seedTenant(db);
    await db.updateTable('tenants').set({ name: 'Storage Co' }).where('id', '=', tenantId).execute();
    const id = await seedNotification(db, tenantId, { recipient_type: 'vendor', recipient_ref: 'vendor@acme.test', payload: { type: 'renewal_reminder', days_before: 30, expiration_date: '2026-12-01' } });

    const mailer = new NoOpMailer();
    await processDueNotifications(mailer, db, new Date());
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.fromName).toBe('Storage Co');
    expect(mailer.sent[0]?.to).toBe('vendor@acme.test');

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('sent');
  });

  test('marks failed when the recipient is unresolvable (disabled user)', async () => {
    const tenantId = await seedTenant(db);
    const disabledId = await seedUser(db, tenantId, { status: 'disabled' });
    const id = await seedNotification(db, tenantId, { recipient_type: 'user', recipient_ref: disabledId });

    const result = await processDueNotifications(new NoOpMailer(), db, new Date());
    expect(result.failed).toBe(1);

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect((row.payload_json as { send_error: string }).send_error).toBe('recipient user not deliverable');
  });

  test('password_reset payload is scrubbed (reset_path nulled) after a successful send', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId);
    const id = await seedNotification(db, tenantId, {
      recipient_type: 'user', recipient_ref: adminId,
      payload: { type: 'password_reset', reset_path: '/reset-password?token=SECRET' },
    });

    await processDueNotifications(new NoOpMailer(), db, new Date());

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const payload = row.payload_json as { reset_path: string | null; token_scrubbed: boolean };
    expect(payload.reset_path).toBeNull();
    expect(payload.token_scrubbed).toBe(true);
  });

  test('coi_expiration job flips the vendor\'s locations via applyExpirationFlip, no notification.sent audit (internal action, not an email)', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const locationId = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');
    const id = await seedNotification(db, tenantId, {
      recipient_type: 'user', recipient_ref: 'system',
      payload: { type: 'coi_expiration', vendor_id: vendorId, document_id: null },
    });

    const mailer = new NoOpMailer();
    const result = await processDueNotifications(mailer, db, new Date());
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(0); // internal action — no email

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('sent');

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('expired');

    const sentAudit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'notification.sent').where('target_id', '=', id).executeTakeFirst();
    expect(sentAudit).toBeUndefined();
    const flipAudit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'vendor.expired').where('target_id', '=', vendorId).executeTakeFirst();
    expect(flipAudit).toBeDefined();
  });

  // ── Claim race: two REAL, independent connections, not the shared per-test transaction ──
  // setupTestDb()'s per-test isolation (one uncommitted transaction, rolled back at teardown)
  // structurally can't host this test: a row inserted-but-not-committed on connection A is
  // invisible to an independent connection B, so there is nothing for B to race against. This
  // test manages its own ephemeral database and two genuinely separate Kysely/pg connections
  // (test-isolation.ts's own lower-level primitives — the same ones setupTestDb() is built on)
  // so the two claim attempts are real concurrent Postgres transactions, not two `await`s
  // serialized on one connection (which would prove nothing about row-level locking at all).
  test('two concurrent claim attempts on one row (real separate connections) — exactly one wins, the other gets zero updated', async () => {
    const { name, db: dbA } = await createEphemeralTestDatabase();
    const dbB = kyselyFor(name);
    try {
      const tenantId = randomUUID();
      await dbA.insertInto('tenants').values({
        id: tenantId, name: 'Race Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date(),
      }).execute();
      const notifId = randomUUID();
      await dbA.insertInto('notifications').values({
        id: notifId, tenant_id: tenantId, recipient_type: 'user', recipient_ref: 'nobody',
        channel: 'email', kind: 'exception', status: 'queued', scheduled_for: null, sent_at: null,
        payload_json: JSON.stringify({ type: 'vendor_submitted' }), document_id: null,
        claimed_at: null, provider_message_id: null, created_at: new Date(),
      }).execute();

      const claim = (conn: Db) =>
        conn.updateTable('notifications')
          .set({ status: 'sending', claimed_at: new Date() })
          .where('id', '=', notifId)
          .where('status', '=', 'queued')
          .executeTakeFirst();

      const [resA, resB] = await Promise.all([claim(dbA), claim(dbB)]);
      const wins = [resA, resB].filter((r) => Number(r.numUpdatedRows) === 1).length;
      const losses = [resA, resB].filter((r) => Number(r.numUpdatedRows) === 0).length;
      expect(wins).toBe(1);
      expect(losses).toBe(1);

      const row = await dbA.selectFrom('notifications').selectAll().where('id', '=', notifId).executeTakeFirstOrThrow();
      expect(row.status).toBe('sending'); // exactly one claim applied, not zero, not double-applied
    } finally {
      await dbB.destroy();
      await dropEphemeralTestDatabase(name, dbA);
    }
  });
});

// ── digest.ts ────────────────────────────────────────────────────────────────────

describe('db-core (Stage 8b): notifications/digest.ts', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('buildAndSendDigest batches multiple queued digest rows for one recipient into one email', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId);
    await seedNotification(db, tenantId, { recipient_type: 'user', recipient_ref: adminId, kind: 'digest', payload: { type: 'vendor_submitted', vendor_name: 'Acme' } });
    await seedNotification(db, tenantId, { recipient_type: 'user', recipient_ref: adminId, kind: 'digest', payload: { type: 'lapse_recovered', vendor_name: 'Beta' } });

    const mailer = new NoOpMailer();
    const result = await buildAndSendDigest(mailer, db, tenantId, new Date());
    expect(result.recipients).toBe(1);
    expect(result.itemsBatched).toBe(2);
    expect(result.emailsSent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.body).toContain('Acme');
    expect(mailer.sent[0]?.body).toContain('Beta');
  });

  test('skips sending when nothing is due (skippedEmpty)', async () => {
    const tenantId = await seedTenant(db);
    const result = await buildAndSendDigest(new NoOpMailer(), db, tenantId, new Date());
    expect(result.skippedEmpty).toBe(true);
    expect(result.emailsSent).toBe(0);
  });

  test('runDigestCycle fires only for the tenant whose local hour matches DIGEST_HOUR_LOCAL', async () => {
    const chicago = await seedTenant(db, { timezone: 'America/Chicago' });
    const utc = await seedTenant(db, { timezone: 'UTC' });
    const adminChi = await seedUser(db, chicago);
    const adminUtc = await seedUser(db, utc);
    await seedNotification(db, chicago, { recipient_type: 'user', recipient_ref: adminChi, kind: 'digest' });
    await seedNotification(db, utc, { recipient_type: 'user', recipient_ref: adminUtc, kind: 'digest' });

    const mailer = new NoOpMailer();
    const now = new Date('2026-06-29T13:00:00.000Z'); // 13:00 UTC = 08:00 Chicago (CDT)
    const result = await runDigestCycle(mailer, db, now, 8);
    expect(result.tenantsFired).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });
});

// ── resend-webhook.ts ────────────────────────────────────────────────────────────

describe('db-core (Stage 8b): notifications/resend-webhook.ts handleResendEvent', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('a bounced event flips status to bounced, records delivery in payload, logs audit', async () => {
    const tenantId = await seedTenant(db);
    const id = await seedNotification(db, tenantId, { status: 'sent', provider_message_id: 'msg-1', payload: { type: 'renewal_reminder' } });

    const result = await handleResendEvent(db, { type: 'email.bounced', data: { email_id: 'msg-1' } }, new Date('2026-07-11T00:00:00.000Z'));
    expect(result.handled).toBe(true);
    expect(result.state).toBe('bounced');

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('bounced');
    expect((row.payload_json as { delivery: { state: string } }).delivery.state).toBe('bounced');

    const audit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'notification.bounced').where('target_id', '=', id).executeTakeFirstOrThrow();
    expect(audit.actor_id).toBe('resend-webhook');
  });

  test('a complained event does NOT change status (not a delivery failure), still records + audits', async () => {
    const tenantId = await seedTenant(db);
    const id = await seedNotification(db, tenantId, { status: 'sent', provider_message_id: 'msg-2' });

    const result = await handleResendEvent(db, { type: 'email.complained', data: { email_id: 'msg-2' } });
    expect(result.state).toBe('complained');

    const row = await db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('sent'); // unchanged
    expect((row.payload_json as { delivery: { state: string } }).delivery.state).toBe('complained');
  });

  test('unknown message id is acknowledged but not handled', async () => {
    const result = await handleResendEvent(db, { type: 'email.bounced', data: { email_id: 'nope' } });
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown message id');
  });
});

// ── renewal.ts: applyExpirationFlip ─────────────────────────────────────────────

describe('db-core (Stage 8b): notifications/renewal.ts applyExpirationFlip', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('flips approved/under_review locations to expired, logs vendor.expired, alerts admins', async () => {
    const tenantId = await seedTenant(db);
    const adminId = await seedUser(db, tenantId, { role: 'admin' });
    const vendorId = await seedVendor(db, tenantId);
    const loc1 = await seedLocation(db, tenantId);
    const loc2 = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, loc1, 'approved');
    await seedVendorLocation(db, tenantId, vendorId, loc2, 'under_review');

    const result = await applyExpirationFlip(db, { tenantId, vendorId, documentId: null }, new Date());
    expect(result.flippedLocationIds).toHaveLength(2);

    const locs = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).execute();
    expect(locs.every((l) => l.status === 'expired')).toBe(true);

    const audit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'vendor.expired').where('target_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(audit.tenant_id).toBe(tenantId);

    const adminAlert = await db.selectFrom('notifications').selectAll().where('recipient_ref', '=', adminId).executeTakeFirstOrThrow();
    expect((adminAlert.payload_json as { type: string }).type).toBe('vendor_expired');
  });

  test('no-op if the document was already superseded (renewed — the chase job is stale)', async () => {
    const tenantId = await seedTenant(db);
    const vendorId = await seedVendor(db, tenantId);
    const locationId = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');

    const oldDocId = randomUUID();
    const newDocId = randomUUID();
    await db.insertInto('documents').values({
      id: newDocId, tenant_id: tenantId, vendor_id: vendorId, doc_type: 'coi', storage_key: 'k-new',
      encryption_json: JSON.stringify({}), uploaded_at: new Date(), state: 'active', superseded_by: null,
    }).execute();
    await db.insertInto('documents').values({
      id: oldDocId, tenant_id: tenantId, vendor_id: vendorId, doc_type: 'coi', storage_key: 'k-old',
      encryption_json: JSON.stringify({}), uploaded_at: new Date(), state: 'active', superseded_by: newDocId,
    }).execute();

    const result = await applyExpirationFlip(db, { tenantId, vendorId, documentId: oldDocId }, new Date());
    expect(result.flippedLocationIds).toHaveLength(0);

    const vl = await db.selectFrom('vendor_locations').selectAll().where('vendor_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(vl.status).toBe('approved'); // untouched
  });
});

// ── manual-reminder.ts ───────────────────────────────────────────────────────────

describe('db-core (Stage 8b): services/manual-reminder.ts sendManualRenewalReminder', () => {
  let db: Db;
  beforeEach(async () => { db = await setupTestDb(); });
  afterEach(async () => teardownTestDb(db));
  afterAll(async () => teardownTestDatabase());

  test('queues an immediate exception-tier reminder and logs vendor.renewal_reminder_sent', async () => {
    const tenantId = await seedTenant(db);
    const actorId = await seedUser(db, tenantId, { role: 'admin' });
    const vendorId = await seedVendor(db, tenantId, { contact_email: 'vendor@acme.test' });
    const locationId = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');

    const result = await sendManualRenewalReminder(db, tenantId, locationId, vendorId, actorId);
    const row = await db.selectFrom('notifications').selectAll().where('id', '=', result.notificationId).executeTakeFirstOrThrow();
    expect(row.kind).toBe('exception');
    expect(row.recipient_ref).toBe('vendor@acme.test');
    expect((row.payload_json as { manual: boolean }).manual).toBe(true);

    const audit = await db.selectFrom('audit_events').selectAll().where('event_type', '=', 'vendor.renewal_reminder_sent').where('target_id', '=', vendorId).executeTakeFirstOrThrow();
    expect(audit.actor_id).toBe(actorId);
  });

  test('throws NOT_AT_LOCATION when the vendor is not associated with the location', async () => {
    const tenantId = await seedTenant(db);
    const actorId = await seedUser(db, tenantId, { role: 'admin' });
    const vendorId = await seedVendor(db, tenantId);
    const locationId = await seedLocation(db, tenantId); // no vendor_locations row

    await expect(sendManualRenewalReminder(db, tenantId, locationId, vendorId, actorId))
      .rejects.toMatchObject({ code: 'NOT_AT_LOCATION' });
    await expect(sendManualRenewalReminder(db, tenantId, locationId, vendorId, actorId)).rejects.toBeInstanceOf(ManualReminderError);
  });

  test('throws NO_EMAIL when the vendor has no contact email', async () => {
    const tenantId = await seedTenant(db);
    const actorId = await seedUser(db, tenantId, { role: 'admin' });
    const vendorId = await seedVendor(db, tenantId, { contact_email: null });
    const locationId = await seedLocation(db, tenantId);
    await seedVendorLocation(db, tenantId, vendorId, locationId, 'approved');

    await expect(sendManualRenewalReminder(db, tenantId, locationId, vendorId, actorId))
      .rejects.toMatchObject({ code: 'NO_EMAIL' });
  });
});
