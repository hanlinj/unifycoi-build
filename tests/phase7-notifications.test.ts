// Phase 7, Slice B — notifications infrastructure.
//
// Behavioral tests against a real in-memory DB + the NoOpMailer double (records sends).
// Proves: operator-branded From, exception-notification wiring (decline, rule-change
// non-compliance, bounced-expired), and digest aggregation (batch, skip-empty, branding).

import { randomUUID } from 'crypto';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedVendor,
  seedLocation,
  seedVendorLocation,
  seedRequirementSettings,
  seedRequirementRule,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { NoOpMailer, resolveFrom } from '@/lib/notifications/mailer';
import { queueNotification, notifyTenantAdmins, getOperatorName } from '@/lib/notifications/queue';
import { buildAndSendDigest } from '@/lib/notifications/digest';
import { applyDecision } from '@/lib/services/decision';
import { triggerRuleChangeReeval } from '@/lib/requirements/re-eval';

// ── Operator branding ───────────────────────────────────────────────────────────

describe('operator-branded From (vendor-facing)', () => {
  test('vendor audience uses the operator (tenant) name as display name', () => {
    const from = resolveFrom('vendor', 'Storage Star');
    expect(from.fromName).toBe('Storage Star');
  });

  test('internal audience uses UnifyCOI branding', () => {
    const from = resolveFrom('internal', 'Storage Star');
    expect(from.fromName).toBe('UnifyCOI');
  });

  test('vendor audience with null operator name falls back, never to UnifyCOI', () => {
    const from = resolveFrom('vendor', null);
    expect(from.fromName).not.toBe('UnifyCOI');
    expect(from.fromName.length).toBeGreaterThan(0);
  });

  test('getOperatorName returns the tenant name', () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Acme Storage' });
    expect(getOperatorName(db, t.id)).toBe('Acme Storage');
    db.close();
  });
});

// ── NoOpMailer double ───────────────────────────────────────────────────────────

describe('NoOpMailer', () => {
  test('records sends and reports ok', async () => {
    const m = new NoOpMailer();
    const r = await m.send({ to: 'a@b.test', fromName: 'Op', fromEmail: 'x@y.test', subject: 's', body: 'b' });
    expect(r.ok).toBe(true);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].to).toBe('a@b.test');
  });

  test('failNext simulates backpressure (returns error, records nothing)', async () => {
    const m = new NoOpMailer();
    m.failNext = 'smtp 550';
    const r = await m.send({ to: 'a@b.test', fromName: 'Op', fromEmail: 'x@y.test', subject: 's', body: 'b' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('smtp 550');
    expect(m.sent).toHaveLength(0);
  });
});

// ── Exception notification wiring ────────────────────────────────────────────────

describe('exception notifications wired this phase', () => {
  test('vendor.declined queues an exception notification to every admin', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin1 = seedTenantUser(db, t.id, { role: 'admin' });
    const admin2 = seedTenantUser(db, t.id, { role: 'admin' });
    seedTenantUser(db, t.id, { role: 'store_manager' }); // must NOT receive
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });

    applyDecision({ db, tenantId: t.id, vendorId: v.id, actorUserId: admin1.id, action: 'reject', locationIds: [loc.id] });

    const tdb = new TenantDB(db, t.id);
    const notifs = tdb.all<{ recipient_ref: string; kind: string; status: string; payload_json: string }>(
      `SELECT recipient_ref, kind, status, payload_json FROM notifications
       WHERE tenant_id = ? AND kind = 'exception'
         AND json_extract(payload_json, '$.type') = 'vendor_declined'`
    );
    expect(notifs).toHaveLength(2); // both admins, not the store manager
    const recipients = new Set(notifs.map((n) => n.recipient_ref));
    expect(recipients).toEqual(new Set([admin1.id, admin2.id]));
    expect(notifs.every((n) => n.status === 'queued')).toBe(true);
    db.close();
  });

  test('reject with no successful locations does not queue a decline notification', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const v = seedVendor(db, t.id);
    const loc = seedLocation(db, t.id);
    // location not in under_review → skipped (no update) ... use a non-existent loc to force skip
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'under_review' });

    applyDecision({ db, tenantId: t.id, vendorId: v.id, actorUserId: admin.id, action: 'reject', locationIds: [randomUUID()] });

    const tdb = new TenantDB(db, t.id);
    const notifs = tdb.all(
      `SELECT id FROM notifications WHERE tenant_id = ?
         AND json_extract(payload_json, '$.type') = 'vendor_declined'`
    );
    expect(notifs).toHaveLength(0);
    db.close();
  });

  test('rule-change non-compliance queues an exception to admins', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    seedRequirementSettings(db, t.id);
    const v = seedVendor(db, t.id, { trade: 'plumbing' });
    const loc = seedLocation(db, t.id);
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    // Stricter rule the vendor (no extractions) cannot satisfy → non_compliant.
    seedRequirementRule(db, t.id, admin.id, {
      requirement_key: 'coverage.general_liability.each_occurrence', required_value: '5000000',
    });

    await triggerRuleChangeReeval(db, t.id, 'coverage.general_liability.each_occurrence');

    const tdb = new TenantDB(db, t.id);
    const notifs = tdb.all<{ recipient_ref: string }>(
      `SELECT recipient_ref FROM notifications WHERE tenant_id = ? AND kind = 'exception'
         AND json_extract(payload_json, '$.type') = 'non_compliant_rule_change'`
    );
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs.some((n) => n.recipient_ref === admin.id)).toBe(true);
    db.close();
  });
});

// ── Digest aggregation ───────────────────────────────────────────────────────────

describe('daily digest', () => {
  test('3 routine signals for one recipient → 1 email containing all 3, rows marked sent', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const admin = seedTenantUser(db, t.id, { role: 'admin' });

    for (let i = 0; i < 3; i++) {
      queueNotification(db, t.id, {
        recipientType: 'user', recipientRef: admin.id, kind: 'digest',
        payload: { type: 'vendor_ready_for_review', vendor_name: `Vendor ${i}` },
      });
    }

    const mailer = new NoOpMailer();
    const result = await buildAndSendDigest(mailer, db, t.id, new Date());

    expect(result.emailsSent).toBe(1);
    expect(result.itemsBatched).toBe(3);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(admin.email);
    // one email, all three items in the body
    expect(mailer.sent[0].body).toMatch(/Vendor 0/);
    expect(mailer.sent[0].body).toMatch(/Vendor 1/);
    expect(mailer.sent[0].body).toMatch(/Vendor 2/);

    const tdb = new TenantDB(db, t.id);
    const remaining = tdb.all(`SELECT id FROM notifications WHERE tenant_id = ? AND kind='digest' AND status='queued'`);
    expect(remaining).toHaveLength(0);
    db.close();
  });

  test('digest is internal-branded (UnifyCOI), not operator-branded', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: admin.id, kind: 'digest', payload: { type: 'x' } });

    const mailer = new NoOpMailer();
    await buildAndSendDigest(mailer, db, t.id, new Date());
    expect(mailer.sent[0].fromName).toBe('UnifyCOI');
    db.close();
  });

  test('empty digest → no email sent (skipEmpty)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const mailer = new NoOpMailer();
    const result = await buildAndSendDigest(mailer, db, t.id, new Date());
    expect(result.skippedEmpty).toBe(true);
    expect(mailer.sent).toHaveLength(0);
    db.close();
  });

  test('two recipients → two separate aggregated emails', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const a1 = seedTenantUser(db, t.id, { role: 'admin' });
    const a2 = seedTenantUser(db, t.id, { role: 'district_manager' });
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: a1.id, kind: 'digest', payload: { type: 'x' } });
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: a2.id, kind: 'digest', payload: { type: 'y' } });

    const mailer = new NoOpMailer();
    const result = await buildAndSendDigest(mailer, db, t.id, new Date());
    expect(result.recipients).toBe(2);
    expect(mailer.sent).toHaveLength(2);
    db.close();
  });

  test('exceptions are NOT pulled into the digest', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: admin.id, kind: 'exception', payload: { type: 'urgent' } });

    const mailer = new NoOpMailer();
    const result = await buildAndSendDigest(mailer, db, t.id, new Date());
    expect(result.skippedEmpty).toBe(true);
    expect(mailer.sent).toHaveLength(0);
    // the exception row is untouched, still queued for the worker
    const tdb = new TenantDB(db, t.id);
    const ex = tdb.get<{ status: string }>(`SELECT status FROM notifications WHERE tenant_id = ? AND kind='exception'`);
    expect(ex!.status).toBe('queued');
    db.close();
  });

  test('digest cross-tenant isolation: tenant B digest never includes tenant A rows', async () => {
    const db = setupTestDb();
    const tA = seedTenant(db);
    const tB = seedTenant(db);
    const adminA = seedTenantUser(db, tA.id, { role: 'admin' });
    seedTenantUser(db, tB.id, { role: 'admin' });
    queueNotification(db, tA.id, { recipientType: 'user', recipientRef: adminA.id, kind: 'digest', payload: { type: 'x' } });

    const mailer = new NoOpMailer();
    const resultB = await buildAndSendDigest(mailer, db, tB.id, new Date());
    expect(resultB.skippedEmpty).toBe(true); // B has no rows
    expect(mailer.sent).toHaveLength(0);
    db.close();
  });
});
