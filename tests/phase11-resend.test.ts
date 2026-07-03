// Phase 11 · Slice 1 — Resend transport, worker provider-id persistence, the durable
// sent-guard, and the delivery webhook (signature + bounce/complaint handling).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { setupTestDb, seedTenant } from './helpers';
import { ResendMailer, resolveFrom, type Mailer, type EmailMessage, type SendResult } from '@/lib/notifications/mailer';
import { queueNotification } from '@/lib/notifications/queue';
import { processDueNotifications } from '@/lib/notifications/worker';
import { verifyResendWebhook, handleResendEvent } from '@/lib/notifications/resend-webhook';

const NOW = new Date('2026-07-03T12:00:00.000Z');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Sign like Svix/Resend: base64 HMAC-SHA256 over `id.timestamp.body`. */
function svixSign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return `v1,${sig}`;
}

/** Minimal Response double so the transport test needs no real network / global Response. */
function fakeResponse(opts: { ok: boolean; status: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

/** Apply all real migrations onto an arbitrary db handle (for the getRawDb singleton). */
function migrateInto(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf-8'));
  }
}

/** Insert a sent notification carrying a provider_message_id (what the webhook resolves on). */
function insertSentNotification(
  db: Database.Database,
  tenantId: string,
  opts: { providerId: string; email: string; type: string }
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO notifications
       (id, tenant_id, recipient_type, recipient_ref, channel, kind, status, scheduled_for,
        sent_at, payload_json, document_id, claimed_at, created_at, provider_message_id)
     VALUES (?, ?, 'vendor', ?, 'email', 'exception', 'sent', NULL, ?, ?, NULL, NULL, ?, ?)`
  ).run(
    id,
    tenantId,
    opts.email,
    NOW.toISOString(),
    JSON.stringify({ type: opts.type }),
    NOW.toISOString(),
    opts.providerId
  );
  return id;
}

// ── ResendMailer transport ──────────────────────────────────────────────────────

describe('ResendMailer transport', () => {
  // The three real notifications, each with the envelope resolveFrom() produces.
  const messages: EmailMessage[] = [
    { to: 'vendor@example.com', ...resolveFrom('vendor', 'Storage Star'), subject: "You've been invited to submit documents", body: 'Please use your secure link.', notificationId: 'notif_invite' },
    { to: 'vendor@example.com', ...resolveFrom('vendor', 'Storage Star'), subject: 'Your certificate of insurance expires soon', body: 'Please upload a renewed certificate.', notificationId: 'notif_renewal' },
    { to: 'admin@op.com', ...resolveFrom('internal', 'Storage Star'), subject: 'Your daily compliance digest', body: 'Here is today’s summary.', notificationId: 'notif_digest' },
  ];

  test.each(messages)('POSTs to Resend with envelope + Idempotency-Key ($subject)', async (msg) => {
    const fetchImpl = jest.fn(async () => fakeResponse({ ok: true, status: 200, json: { id: 'resend_abc' } }));
    const mailer = new ResendMailer({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await mailer.send(msg);

    expect(result).toEqual({ ok: true, providerId: 'resend_abc' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    // Idempotency-Key === notificationId closes the double-send window (SEC-2).
    expect(headers['Idempotency-Key']).toBe(msg.notificationId);

    const body = JSON.parse(init.body as string);
    // Shared verified domain address; operator name as display only (per-operator DKIM deferred).
    expect(body.from).toBe(`"${msg.fromName}" <${msg.fromEmail}>`);
    expect(body.from).toContain('noreply@unifycoi-mail.com');
    expect(body.to).toBe(msg.to);
    expect(body.subject).toBe(msg.subject);
    expect(body.text).toBe(msg.body);
    // No operator Reply-To data in v1 → omitted (not set to a placeholder).
    expect('reply_to' in body).toBe(false);
  });

  test('vendor From carries the operator name, internal From carries UnifyCOI', () => {
    expect(resolveFrom('vendor', 'Storage Star').fromName).toBe('Storage Star');
    expect(resolveFrom('internal', 'Storage Star').fromName).toBe('UnifyCOI');
  });

  test('omits Idempotency-Key when the message has no notificationId', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse({ ok: true, status: 200, json: { id: 'resend_x' } }));
    const mailer = new ResendMailer({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await mailer.send({ to: 'a@b.com', fromName: 'UnifyCOI', fromEmail: 'noreply@unifycoi-mail.com', subject: 's', body: 'b' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect('Idempotency-Key' in (init.headers as Record<string, string>)).toBe(false);
  });

  test('non-2xx from Resend surfaces as a failure with the status + detail', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse({ ok: false, status: 422, text: 'domain not verified' }));
    const mailer = new ResendMailer({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await mailer.send({ to: 'a@b.com', fromName: 'UnifyCOI', fromEmail: 'x@y.com', subject: 's', body: 'b', notificationId: 'n1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('422');
    expect(result.error).toContain('domain not verified');
  });

  test('a network throw surfaces as a failure, not an exception', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNRESET'); });
    const mailer = new ResendMailer({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await mailer.send({ to: 'a@b.com', fromName: 'UnifyCOI', fromEmail: 'x@y.com', subject: 's', body: 'b' });
    expect(result).toEqual({ ok: false, error: 'ECONNRESET' });
  });
});

// ── Worker: provider-id persistence + the durable sent-guard ─────────────────────

describe('notification worker · provider-id + durable sent-guard', () => {
  function countingMailer(providerId: string): Mailer & { calls: EmailMessage[] } {
    const calls: EmailMessage[] = [];
    return {
      calls,
      async send(msg: EmailMessage): Promise<SendResult> {
        calls.push(msg);
        return { ok: true, providerId };
      },
    };
  }

  test('persists providerId and passes notificationId as the idempotency handle', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const mailer = countingMailer('resend_persist');
    const notifId = queueNotification(db, t.id, {
      recipientType: 'vendor',
      recipientRef: 'vendor@example.com',
      kind: 'exception',
      payload: { type: 'vendor_invite', business_name: 'Acme' },
    });

    const first = await processDueNotifications(mailer, db, NOW);
    expect(first.sent).toBe(1);
    expect(mailer.calls).toHaveLength(1);
    expect(mailer.calls[0].notificationId).toBe(notifId); // future ESP idempotency key

    const row = db.prepare('SELECT status, provider_message_id FROM notifications WHERE id = ?').get(notifId) as { status: string; provider_message_id: string };
    expect(row.status).toBe('sent');
    expect(row.provider_message_id).toBe('resend_persist');
  });

  test('a row marked sent is never re-picked (durable >24h guard, independent of Resend)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const mailer = countingMailer('resend_once');
    queueNotification(db, t.id, {
      recipientType: 'vendor',
      recipientRef: 'vendor@example.com',
      kind: 'exception',
      payload: { type: 'vendor_invite' },
    });

    await processDueNotifications(mailer, db, NOW);
    // A day later — well past Resend's 24h idempotency-key retention.
    const nextDay = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    const second = await processDueNotifications(mailer, db, nextDay);

    expect(second.sent).toBe(0);
    expect(mailer.calls).toHaveLength(1); // not re-sent
  });
});

// ── verifyResendWebhook ───────────────────────────────────────────────────────

describe('verifyResendWebhook', () => {
  const SECRET = 'whsec_' + Buffer.from('unit-test-secret').toString('base64');
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'pm_1' } });
  const ts = String(Math.floor(NOW.getTime() / 1000));
  const id = 'msg_1';

  test('a valid Svix HMAC passes', () => {
    const sig = svixSign(SECRET, id, ts, body);
    expect(verifyResendWebhook(body, { id, timestamp: ts, signature: sig }, SECRET, NOW.getTime())).toBe(true);
  });

  test('a wrong signature is rejected', () => {
    expect(verifyResendWebhook(body, { id, timestamp: ts, signature: 'v1,deadbeef' }, SECRET, NOW.getTime())).toBe(false);
  });

  test('a tampered body is rejected (signature was over the original)', () => {
    const sig = svixSign(SECRET, id, ts, body);
    const tampered = body.replace('pm_1', 'pm_evil');
    expect(verifyResendWebhook(tampered, { id, timestamp: ts, signature: sig }, SECRET, NOW.getTime())).toBe(false);
  });

  test('an empty secret fails closed', () => {
    const sig = svixSign(SECRET, id, ts, body);
    expect(verifyResendWebhook(body, { id, timestamp: ts, signature: sig }, '', NOW.getTime())).toBe(false);
  });

  test('a missing header fails closed', () => {
    const sig = svixSign(SECRET, id, ts, body);
    expect(verifyResendWebhook(body, { id: null, timestamp: ts, signature: sig }, SECRET, NOW.getTime())).toBe(false);
  });

  test('a stale timestamp (replay) is rejected', () => {
    const sig = svixSign(SECRET, id, ts, body);
    const tenMinutesLater = NOW.getTime() + 10 * 60 * 1000;
    expect(verifyResendWebhook(body, { id, timestamp: ts, signature: sig }, SECRET, tenMinutesLater)).toBe(false);
  });
});

// ── handleResendEvent ─────────────────────────────────────────────────────────

describe('handleResendEvent', () => {
  test('bounce flips status to bounced + writes a tenant-scoped notification.bounced audit', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const notifId = insertSentNotification(db, t.id, { providerId: 'pm_bounce', email: 'v@x.com', type: 'vendor_invite' });

    const res = handleResendEvent(db, { type: 'email.bounced', data: { email_id: 'pm_bounce' } }, NOW);
    expect(res).toMatchObject({ handled: true, notificationId: notifId, state: 'bounced' });

    const row = db.prepare('SELECT status, payload_json FROM notifications WHERE id = ?').get(notifId) as { status: string; payload_json: string };
    expect(row.status).toBe('bounced');
    expect(JSON.parse(row.payload_json).delivery).toEqual({ state: 'bounced', at: NOW.toISOString() });

    const audit = db.prepare(`SELECT tenant_id, event_type, target_id FROM audit_events WHERE event_type = 'notification.bounced'`).get() as { tenant_id: string; target_id: string };
    expect(audit).toMatchObject({ tenant_id: t.id, target_id: notifId });
  });

  test('complaint is recorded + audited but does NOT flip status (not a delivery failure)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const notifId = insertSentNotification(db, t.id, { providerId: 'pm_comp', email: 'v@x.com', type: 'renewal_reminder' });

    const res = handleResendEvent(db, { type: 'email.complained', data: { email_id: 'pm_comp' } }, NOW);
    expect(res).toMatchObject({ handled: true, state: 'complained' });

    const row = db.prepare('SELECT status, payload_json FROM notifications WHERE id = ?').get(notifId) as { status: string; payload_json: string };
    expect(row.status).toBe('sent'); // unchanged
    expect(JSON.parse(row.payload_json).delivery.state).toBe('complained');
    const audit = db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE event_type = 'notification.complained' AND tenant_id = ?`).get(t.id) as { c: number };
    expect(audit.c).toBe(1);
  });

  test('resolves by provider_message_id, NOT recipient email (which collides across tenants)', () => {
    const db = setupTestDb();
    const a = seedTenant(db, { name: 'Tenant A' });
    const b = seedTenant(db, { name: 'Tenant B' });
    // Same recipient email in both tenants; only the provider id disambiguates.
    const aNotif = insertSentNotification(db, a.id, { providerId: 'pm_A', email: 'shared@vendor.com', type: 'vendor_invite' });
    const bNotif = insertSentNotification(db, b.id, { providerId: 'pm_B', email: 'shared@vendor.com', type: 'vendor_invite' });

    handleResendEvent(db, { type: 'email.bounced', data: { email_id: 'pm_A' } }, NOW);

    expect((db.prepare('SELECT status FROM notifications WHERE id = ?').get(aNotif) as { status: string }).status).toBe('bounced');
    expect((db.prepare('SELECT status FROM notifications WHERE id = ?').get(bNotif) as { status: string }).status).toBe('sent');
    // Audit lands only in tenant A.
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE tenant_id = ?`).get(a.id) as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE tenant_id = ?`).get(b.id) as { c: number }).c).toBe(0);
  });

  test('an unknown message id is acknowledged but not applied', () => {
    const db = setupTestDb();
    expect(handleResendEvent(db, { type: 'email.bounced', data: { email_id: 'nope' } }, NOW)).toEqual({ handled: false, reason: 'unknown message id' });
  });

  test('a non-bounce/complaint event type is ignored', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    insertSentNotification(db, t.id, { providerId: 'pm_d', email: 'v@x.com', type: 'vendor_invite' });
    expect(handleResendEvent(db, { type: 'email.delivered', data: { email_id: 'pm_d' } }, NOW).handled).toBe(false);
  });
});

// ── route /api/webhooks/resend ─────────────────────────────────────────────────
// Uses fresh requires after configuring the secret so env + the getRawDb singleton the
// route uses are the ones we seed here. Runs last so resetModules() can't disturb the
// statically-imported unit tests above.

describe('route /api/webhooks/resend', () => {
  const SECRET = 'whsec_' + Buffer.from('route-test-secret').toString('base64');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let POST: (req: Request) => Promise<any>;
  let db: Database.Database;

  beforeAll(() => {
    process.env['RESEND_WEBHOOK_SECRET'] = SECRET;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRawDb } = require('@/lib/db/client');
    db = getRawDb();
    migrateInto(db);
    db.prepare(
      'INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('t_route', 'Route Tenant', 'active', 9000, NOW.toISOString());
    insertSentNotification(db, 't_route', { providerId: 'pm_route', email: 'v@x.com', type: 'vendor_invite' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    POST = require('@/app/api/webhooks/resend/route').POST;
  });

  afterAll(() => {
    delete process.env['RESEND_WEBHOOK_SECRET'];
  });

  function req(headers: Record<string, string>, body: string): Request {
    return new Request('http://t/api/webhooks/resend', { method: 'POST', headers, body });
  }

  test('rejects a bad signature with 401 (no cookie involved)', async () => {
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'pm_route' } });
    const res = await POST(req({ 'svix-id': 'r1', 'svix-timestamp': ts, 'svix-signature': 'v1,bad' }, body));
    expect(res.status).toBe(401);
  });

  test('accepts a valid signature with 2xx and applies the bounce', async () => {
    const ts = String(Math.floor(Date.now() / 1000)); // route verifies against Date.now()
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'pm_route' } });
    const sig = svixSign(SECRET, 'r2', ts, body);
    const res = await POST(req({ 'svix-id': 'r2', 'svix-timestamp': ts, 'svix-signature': sig }, body));
    expect(res.status).toBe(200);
    expect((await res.json()).handled).toBe(true);
    expect((db.prepare(`SELECT status FROM notifications WHERE provider_message_id = 'pm_route'`).get() as { status: string }).status).toBe('bounced');
  });
});
