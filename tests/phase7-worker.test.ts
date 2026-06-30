// Phase 7, Slice C — eager scheduling + notification worker.
//
// Highest-risk slice: time-driven code. Every clock-sensitive test FREEZES `now` so
// "60 days before expiry" is deterministic. Worker safety (idempotency, crash recovery,
// backpressure) is proven against the real DB + NoOpMailer double.

import { randomUUID } from 'crypto';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedVendor,
  seedDocument,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { NoOpMailer } from '@/lib/notifications/mailer';
import { queueNotification } from '@/lib/notifications/queue';
import {
  earliestExpiration,
  scheduleRenewalReminders,
  supersedeReminders,
  handleCoiUploadChase,
  LADDER_DAYS,
} from '@/lib/notifications/renewal';
import { processDueNotifications } from '@/lib/notifications/worker';
import type { ProcessedCOIExtraction, FieldValue } from '@/lib/extraction/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-29T12:00:00.000Z');

function fv<T>(value: T): FieldValue<T> {
  return { value, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false };
}

function coiWith(expirations: (string | null)[]): ProcessedCOIExtraction {
  return {
    doc_type: 'coi',
    document_type_confirmed: 'coi',
    certificate_date: fv<string | null>(null),
    producer: fv<string | null>(null),
    named_insured: fv<string | null>(null),
    insured_address: fv<string | null>(null),
    insurers: [],
    policies: expirations.map((e) => ({
      coverage_type: fv<string | null>('gl'),
      insurer_letter: fv<string | null>(null),
      policy_number: fv<string | null>(null),
      effective_date: fv<string | null>(null),
      expiration_date: fv<string | null>(e),
      limits: {},
      additional_insured: fv<boolean | null>(null),
      additional_insured_scope: fv<string | null>(null),
      waiver_of_subrogation: fv<boolean | null>(null),
      primary_noncontributory: fv<boolean | null>(null),
    })),
    additional_insured_entities: fv<string | null>(null),
    description_of_operations: fv<string | null>(null),
    certificate_holder: fv<string | null>(null),
  };
}

// ── earliestExpiration ──────────────────────────────────────────────────────────

describe('earliestExpiration', () => {
  test('picks the earliest valid date across policies (the "valid through")', () => {
    expect(earliestExpiration(coiWith(['2027-03-01', '2026-12-15', '2027-09-01']))).toBe('2026-12-15');
  });
  test('ignores unparseable / null dates', () => {
    expect(earliestExpiration(coiWith([null, 'not-a-date', '2027-01-01']))).toBe('2027-01-01');
  });
  test('returns null when no policy has a date', () => {
    expect(earliestExpiration(coiWith([null, null]))).toBeNull();
  });
});

// ── Eager scheduling ─────────────────────────────────────────────────────────────

describe('scheduleRenewalReminders (eager 60/30/14/7/1)', () => {
  function setup() {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { contact_email: 'vendor@x.test' });
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    return { db, t, v, doc };
  }

  test('far-future expiration queues exactly 5 reminders at the right offsets', () => {
    const { db, t, v, doc } = setup();
    const exp = '2027-01-01T00:00:00.000Z';
    const res = scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: doc.id, expirationDate: exp }, NOW);

    expect(res.scheduled).toBe(5);
    expect(res.skippedPast).toBe(0);

    const tdb = new TenantDB(db, t.id);
    const rows = tdb.all<{ scheduled_for: string; recipient_type: string; recipient_ref: string; document_id: string; payload_json: string; kind: string }>(
      `SELECT scheduled_for, recipient_type, recipient_ref, document_id, payload_json, kind FROM notifications
       WHERE tenant_id = ? AND json_extract(payload_json,'$.type')='renewal_reminder' ORDER BY scheduled_for`
    );
    expect(rows).toHaveLength(5);
    // offsets, earliest scheduled (60d) first
    const expMs = Date.parse(exp);
    const got = rows.map((r) => Math.round((expMs - Date.parse(r.scheduled_for)) / DAY_MS)).sort((a, b) => b - a);
    expect(got).toEqual([...LADDER_DAYS]);
    // payload-complete + correctly addressed
    for (const r of rows) {
      expect(r.recipient_type).toBe('vendor');
      expect(r.recipient_ref).toBe('vendor@x.test');
      expect(r.document_id).toBe(doc.id);
      expect(r.kind).toBe('exception'); // vendor-facing, not batched into digest
      const p = JSON.parse(r.payload_json);
      expect(p.expiration_date).toBe(exp);
      expect(p.vendor_name).toBeDefined();
    }
    db.close();
  });

  test('is idempotent — second call schedules nothing more', () => {
    const { db, t, v, doc } = setup();
    const exp = '2027-01-01T00:00:00.000Z';
    scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: doc.id, expirationDate: exp }, NOW);
    const res2 = scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: doc.id, expirationDate: exp }, NOW);
    expect(res2.alreadyScheduled).toBe(true);
    const tdb = new TenantDB(db, t.id);
    const { n } = tdb.get<{ n: number }>(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=?`)!;
    // Phase 8 Slice E: 5 vendor reminders + 1 day-0 coi_expiration job (no admins seeded here,
    // so no imminent-lapse admin alerts). Idempotency still prevents a second batch.
    expect(n).toBe(6);
    db.close();
  });

  test('skips ladder rungs already in the past', () => {
    const { db, t, v, doc } = setup();
    // Expiry 10 days out: 60/30/14 are past, only 7 and 1 are future.
    const exp = new Date(NOW.getTime() + 10 * DAY_MS).toISOString();
    const res = scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: doc.id, expirationDate: exp }, NOW);
    expect(res.scheduled).toBe(2);
    expect(res.skippedPast).toBe(3);
    db.close();
  });

  test('no vendor email → no vendor reminders, but the day-0 flip job IS queued', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id); // no contact_email
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    const res = scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: doc.id, expirationDate: '2027-01-01' }, NOW);
    expect(res.scheduled).toBe(0);                  // no vendor-facing reminders without an email
    // Phase 8 Slice E: the day-0 expiration flip is a status change, not an email — it must be
    // queued regardless of whether the vendor has a deliverable address.
    expect(res.expirationJobScheduled).toBe(true);
    const tdb = new TenantDB(db, t.id);
    const reminders = tdb.all(`SELECT id FROM notifications WHERE tenant_id=? AND json_extract(payload_json,'$.type')='renewal_reminder'`);
    const expJob = tdb.all(`SELECT id FROM notifications WHERE tenant_id=? AND json_extract(payload_json,'$.type')='coi_expiration'`);
    expect(reminders).toHaveLength(0);
    expect(expJob).toHaveLength(1);
    db.close();
  });
});

// ── Supersession ─────────────────────────────────────────────────────────────────

describe('supersession on renewal upload', () => {
  test('renewal COI supersedes prior unfired reminders (retained) + schedules new ones', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { contact_email: 'vendor@x.test' });
    const oldDoc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    // Old ladder against a Sept expiry.
    scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: oldDoc.id, expirationDate: '2027-01-01T00:00:00Z' }, NOW);

    // Renewal arrives: new COI, later expiry.
    const newDoc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    const res = handleCoiUploadChase(db, { tenantId: t.id, vendorId: v.id, newDocumentId: newDoc.id, expirationDate: '2028-01-01T00:00:00Z' }, NOW);

    expect(res.supersededDocumentId).toBe(oldDoc.id);
    // Phase 8 Slice E: a chase = 5 reminders + 1 day-0 job (no admins seeded → no admin
    // alerts). Supersession now cancels ALL chase artifacts for the old doc, not just reminders.
    expect(res.supersededReminders).toBe(6);
    expect(res.schedule.scheduled).toBe(5); // .scheduled counts vendor reminders only

    const tdb = new TenantDB(db, t.id);
    // old doc marked superseded_by new
    const od = tdb.get<{ superseded_by: string }>(`SELECT superseded_by FROM documents WHERE tenant_id=? AND id=?`, [oldDoc.id]);
    expect(od!.superseded_by).toBe(newDoc.id);
    // old chase artifacts retained as 'superseded' (NOT deleted)
    const supRows = tdb.all(`SELECT id FROM notifications WHERE tenant_id=? AND document_id=? AND status='superseded'`, [oldDoc.id]);
    expect(supRows).toHaveLength(6);
    // new chase queued
    const newRows = tdb.all(`SELECT id FROM notifications WHERE tenant_id=? AND document_id=? AND status='queued'`, [newDoc.id]);
    expect(newRows).toHaveLength(6);
    db.close();
  });

  test('first COI (onboarding) has no prior → no supersession, just schedules', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { contact_email: 'vendor@x.test' });
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    const res = handleCoiUploadChase(db, { tenantId: t.id, vendorId: v.id, newDocumentId: doc.id, expirationDate: '2027-06-01T00:00:00Z' }, NOW);
    expect(res.supersededDocumentId).toBeNull();
    expect(res.supersededReminders).toBe(0);
    expect(res.schedule.scheduled).toBe(5);
    db.close();
  });

  test('supersedeReminders leaves already-sent reminders untouched', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { contact_email: 'vendor@x.test' });
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    scheduleRenewalReminders(db, { tenantId: t.id, vendorId: v.id, documentId: doc.id, expirationDate: '2027-01-01T00:00:00Z' }, NOW);
    // mark one as already sent
    const tdb = new TenantDB(db, t.id);
    const one = tdb.get<{ id: string }>(`SELECT id FROM notifications WHERE tenant_id=? AND document_id=? LIMIT 1`, [doc.id])!;
    tdb.update('notifications', { status: 'sent' }, { id: one.id });

    const superseded = supersedeReminders(db, t.id, doc.id);
    // Phase 8 Slice E: 6 chase rows (5 reminders + 1 day-0 job) minus the 1 already-sent = 5.
    expect(superseded).toBe(5); // the sent one is untouched
    const sent = tdb.get<{ status: string }>(`SELECT status FROM notifications WHERE tenant_id=? AND id=?`, [one.id]);
    expect(sent!.status).toBe('sent');
    db.close();
  });
});

// ── Worker: send, idempotency, crash safety, backpressure ────────────────────────

describe('notification worker', () => {
  function queuedVendorNotif(db: ReturnType<typeof setupTestDb>, tenantId: string, email: string, scheduledFor: string | null = null) {
    return queueNotification(db, tenantId, {
      recipientType: 'vendor', recipientRef: email, kind: 'exception',
      scheduledFor, payload: { type: 'renewal_reminder', days_before: 30, expiration_date: '2027-01-01', vendor_name: 'Acme' },
    });
  }

  test('sends a due notification, marks sent + sent_at, logs notification.sent audit', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const v = seedVendor(db, t.id, { contact_email: 'vendor@x.test' });
    queuedVendorNotif(db, t.id, 'vendor@x.test');

    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW);
    expect(res.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('vendor@x.test');
    expect(mailer.sent[0].fromName).toBe('Storage Star'); // operator-branded

    const tdb = new TenantDB(db, t.id);
    const row = tdb.get<{ status: string; sent_at: string }>(`SELECT status, sent_at FROM notifications WHERE tenant_id=?`);
    expect(row!.status).toBe('sent');
    expect(row!.sent_at).toBeTruthy();
    const audit = tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='notification.sent'`);
    expect(audit).toBeDefined();
    void v;
    db.close();
  });

  test('idempotent: a second tick does not resend an already-sent notification', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedVendor(db, t.id, { contact_email: 'vendor@x.test' });
    queuedVendorNotif(db, t.id, 'vendor@x.test');

    const mailer = new NoOpMailer();
    await processDueNotifications(mailer, db, NOW);
    await processDueNotifications(mailer, db, NOW);
    expect(mailer.sent).toHaveLength(1); // not 2
    db.close();
  });

  test('mid-batch crash: already-sent rows are not resent on restart', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedVendor(db, t.id, { contact_email: 'a@x.test' });
    const sentId = queuedVendorNotif(db, t.id, 'a@x.test');
    const pendingId = queuedVendorNotif(db, t.id, 'a@x.test');

    // Simulate: first row fully processed before the "crash"; second still queued.
    const tdb = new TenantDB(db, t.id);
    tdb.update('notifications', { status: 'sent', sent_at: NOW.toISOString() }, { id: sentId });

    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW); // restart tick
    expect(res.sent).toBe(1);            // only the still-pending one
    expect(mailer.sent).toHaveLength(1);
    const stillSent = tdb.get<{ status: string }>(`SELECT status FROM notifications WHERE tenant_id=? AND id=?`, [sentId]);
    expect(stillSent!.status).toBe('sent');
    const nowSent = tdb.get<{ status: string }>(`SELECT status FROM notifications WHERE tenant_id=? AND id=?`, [pendingId]);
    expect(nowSent!.status).toBe('sent');
    db.close();
  });

  test('crash safety: rows stuck in sending > stale window are reclaimed and sent', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedVendor(db, t.id, { contact_email: 'a@x.test' });
    const id = queuedVendorNotif(db, t.id, 'a@x.test');

    // Simulate a crashed worker: row left in 'sending', claimed 10 minutes ago.
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    db.prepare(`UPDATE notifications SET status='sending', claimed_at=? WHERE id=?`).run(tenMinAgo, id);

    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW, { staleSeconds: 300 });
    expect(res.reclaimed).toBe(1);
    expect(res.sent).toBe(1);
    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ status: string }>(`SELECT status FROM notifications WHERE tenant_id=?`)!.status).toBe('sent');
    db.close();
  });

  test('crash safety: rows recently claimed (< stale window) are NOT reclaimed', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedVendor(db, t.id, { contact_email: 'a@x.test' });
    const id = queuedVendorNotif(db, t.id, 'a@x.test');
    const oneMinAgo = new Date(NOW.getTime() - 60 * 1000).toISOString();
    db.prepare(`UPDATE notifications SET status='sending', claimed_at=? WHERE id=?`).run(oneMinAgo, id);

    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW, { staleSeconds: 300 });
    expect(res.reclaimed).toBe(0);
    expect(res.sent).toBe(0); // still in-flight, left alone
    db.close();
  });

  test('backpressure: a Mailer failure marks the row failed (error captured) and continues', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedVendor(db, t.id, { contact_email: 'a@x.test' });
    queuedVendorNotif(db, t.id, 'a@x.test');     // this one fails
    queuedVendorNotif(db, t.id, 'a@x.test');     // this one should still be attempted

    const mailer = new NoOpMailer();
    mailer.failNext = 'smtp 421';
    const res = await processDueNotifications(mailer, db, NOW);
    expect(res.failed).toBe(1);
    expect(res.sent).toBe(1);                    // loop continued to the second row

    const tdb = new TenantDB(db, t.id);
    const failed = tdb.get<{ payload_json: string }>(`SELECT payload_json FROM notifications WHERE tenant_id=? AND status='failed'`);
    expect(JSON.parse(failed!.payload_json).send_error).toBe('smtp 421');
    db.close();
  });

  test('not-yet-due scheduled reminders are not sent', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedVendor(db, t.id, { contact_email: 'a@x.test' });
    const future = new Date(NOW.getTime() + 5 * DAY_MS).toISOString();
    queuedVendorNotif(db, t.id, 'a@x.test', future);

    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW);
    expect(res.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    db.close();
  });

  test('internal (user) recipient resolves to user email with UnifyCOI branding', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin', email: 'admin@op.test' });
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: admin.id, kind: 'exception', payload: { type: 'vendor_declined', vendor_name: 'Acme' } });

    const mailer = new NoOpMailer();
    await processDueNotifications(mailer, db, NOW);
    expect(mailer.sent[0].to).toBe('admin@op.test');
    expect(mailer.sent[0].fromName).toBe('UnifyCOI');
    db.close();
  });

  test('unresolvable user recipient → failed, not stuck', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: randomUUID(), kind: 'exception', payload: { type: 'x' } });
    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW);
    expect(res.failed).toBe(1);
    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ status: string }>(`SELECT status FROM notifications WHERE tenant_id=?`)!.status).toBe('failed');
    db.close();
  });

  test('cross-tenant: each due row sent to its own tenant recipient with that operator brand', async () => {
    const db = setupTestDb();
    const tA = seedTenant(db, { name: 'Alpha Storage' });
    const tB = seedTenant(db, { name: 'Bravo Storage' });
    seedVendor(db, tA.id, { contact_email: 'a@alpha.test' });
    seedVendor(db, tB.id, { contact_email: 'b@bravo.test' });
    queuedVendorNotif(db, tA.id, 'a@alpha.test');
    queuedVendorNotif(db, tB.id, 'b@bravo.test');

    const mailer = new NoOpMailer();
    const res = await processDueNotifications(mailer, db, NOW);
    expect(res.sent).toBe(2);
    const byTo = new Map(mailer.sent.map((m) => [m.to, m.fromName]));
    expect(byTo.get('a@alpha.test')).toBe('Alpha Storage');
    expect(byTo.get('b@bravo.test')).toBe('Bravo Storage');
    db.close();
  });
});
