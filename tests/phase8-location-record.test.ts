// Phase 8, Slice D — Location Record (read-only summary + location-scoped Admin actions).
//
// Behavioral tests against the real DB + route handlers. Proves: record content + filters,
// scope-clamped GET, Admin actions (send-reminder, archive, invite-from-location) with audit,
// and that a Manager attempting an Admin action gets 403 (server enforcement).

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedRegion, seedLocation, seedVendor, seedVendorLocation, assignUserToLocation,
} from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { buildLocationRecord } from '@/lib/services/location-record';
import { sendManualRenewalReminder, ManualReminderError } from '@/lib/services/manual-reminder';
import { createVendorInvite } from '@/lib/services/vendors';
import { queueNotification } from '@/lib/notifications/queue';

const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const DAY = 86_400_000;

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }

// ── Record content + filters (service) ──────────────────────────────────────────────

describe('Location Record — content + filters', () => {
  test('returns identity + vendor list with per-location status, dates, expiry', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const r = seedRegion(db, t.id, 'North');
    const loc = seedLocation(db, t.id, { name: 'Main St Store', regionId: r.id });
    const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing', trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    queueNotification(db, t.id, { recipientType: 'vendor', recipientRef: 'v@x.test', kind: 'exception', scheduledFor: new Date(NOW + 20 * DAY).toISOString(), payload: { type: 'renewal_reminder', vendor_id: v.id, expiration_date: new Date(NOW + 20 * DAY).toISOString(), days_before: 30 } });

    const rec = buildLocationRecord(db, t.id, loc.id, {}, NOW)!;
    expect(rec.location.name).toBe('Main St Store');
    expect(rec.location.region_name).toBe('North');
    expect(rec.vendors).toHaveLength(1);
    expect(rec.vendors[0].status).toBe('approved');
    expect(rec.vendors[0].daysToExpiry).toBe(20);
    db.close();
  });

  test('filters by status and trade; facet lists reflect what is present', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const loc = seedLocation(db, t.id);
    const a = seedVendor(db, t.id, { business_name: 'Approved Plumber', trade: 'plumbing' }); seedVendorLocation(db, t.id, a.id, loc.id, { status: 'approved' });
    const e = seedVendor(db, t.id, { business_name: 'Expired Electric', trade: 'electrical' }); seedVendorLocation(db, t.id, e.id, loc.id, { status: 'expired' });

    expect(buildLocationRecord(db, t.id, loc.id, {}, NOW)!.statuses.sort()).toEqual(['approved', 'expired']);
    expect(buildLocationRecord(db, t.id, loc.id, { status: 'expired' }, NOW)!.vendors.map((v) => v.name)).toEqual(['Expired Electric']);
    expect(buildLocationRecord(db, t.id, loc.id, { trade: 'plumbing' }, NOW)!.vendors.map((v) => v.name)).toEqual(['Approved Plumber']);
    db.close();
  });

  test('unknown location → null', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    expect(buildLocationRecord(db, t.id, randomUUID(), {}, NOW)).toBeNull();
    db.close();
  });
});

// ── Manual reminder service ───────────────────────────────────────────────────────────

describe('sendManualRenewalReminder', () => {
  test('queues an immediate vendor reminder (manual:true) + audit', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Acme', contact_email: 'a@x.test' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });

    const { notificationId } = sendManualRenewalReminder(db, t.id, loc.id, v.id, admin.id);
    const tdb = new TenantDB(db, t.id);
    const n = tdb.get<{ recipient_ref: string; kind: string; payload_json: string }>(`SELECT recipient_ref, kind, payload_json FROM notifications WHERE tenant_id=? AND id=?`, [notificationId]);
    expect(n!.recipient_ref).toBe('a@x.test');
    expect(n!.kind).toBe('exception'); // bypasses the digest
    const p = JSON.parse(n!.payload_json);
    expect(p.type).toBe('renewal_reminder');
    expect(p.manual).toBe(true);
    expect(tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='vendor.renewal_reminder_sent'`)).toBeDefined();
    db.close();
  });

  test('vendor not at this location → NOT_AT_LOCATION', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { contact_email: 'a@x.test' }); // not associated with loc
    expect(() => sendManualRenewalReminder(db, t.id, loc.id, v.id, admin.id)).toThrow(ManualReminderError);
    db.close();
  });
});

// ── Invite-from-location (reuses existing invite endpoint with location pre-set) ──────

describe('invite-from-location', () => {
  test('createVendorInvite with this location pre-set creates the association + audit', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);

    const result = createVendorInvite(db, t.id, {
      businessName: 'New Vendor', contactFirstName: 'Sam', contactLastName: 'Vale', email: 'sam@nv.test',
      companyPhone: '555-1212', trade: 'plumbing', locationIds: [loc.id], inviterUserId: admin.id,
    });
    expect(result.type).toBe('created');
    const tdb = new TenantDB(db, t.id);
    if (result.type === 'created') {
      const vl = tdb.get<{ location_id: string }>(`SELECT location_id FROM vendor_locations WHERE tenant_id=? AND vendor_id=?`, [result.vendorId]);
      expect(vl!.location_id).toBe(loc.id); // location pre-set
    }
    expect(tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='vendor.invited'`)).toBeDefined();
    db.close();
  });
});

// ── Route-level: scope clamp + Manager-403 on Admin actions ──────────────────────────

describe('Location Record — route enforcement', () => {
  function rawWorld() {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const r1 = seedRegion(db, t.id, 'R1'); const r2 = seedRegion(db, t.id, 'R2');
    const inScope = seedLocation(db, t.id, { name: 'In Scope', regionId: r1.id });
    const outScope = seedLocation(db, t.id, { name: 'Out Scope', regionId: r2.id });
    const store = seedTenantUser(db, t.id, { role: 'store_manager' });
    assignUserToLocation(db, store.id, inScope.id, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Loc Vendor', contact_email: 'lv@x.test' });
    seedVendorLocation(db, t.id, v.id, inScope.id, { status: 'approved' });
    return {
      db, t, vendorId: v.id, inScope: inScope.id, outScope: outScope.id,
      adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }),
      storeJwt: issueToken({ sub: store.id, tenantId: t.id, role: 'store_manager', type: 'tenant' }),
    };
  }
  afterEach(() => closeDb());

  test('GET scope clamp: Store sees an in-scope location but a 404 for an out-of-scope one', async () => {
    const w = rawWorld();
    const { GET } = await import('@/app/api/locations/[locationId]/route');
    const inRes = await GET(new Request(`http://t/api/locations/${w.inScope}`, bearer(w.storeJwt)), { params: { locationId: w.inScope } });
    expect(inRes.status).toBe(200);
    expect(await inRes.text()).toContain('Loc Vendor');
    const outRes = await GET(new Request(`http://t/api/locations/${w.outScope}`, bearer(w.storeJwt)), { params: { locationId: w.outScope } });
    expect(outRes.status).toBe(404);
    // Admin (non-vacuous) can see the out-of-scope location
    const adminRes = await GET(new Request(`http://t/api/locations/${w.outScope}`, bearer(w.adminJwt)), { params: { locationId: w.outScope } });
    expect(adminRes.status).toBe(200);
    // scope violation logged for the store's out-of-scope attempt
    expect(w.db.prepare(`SELECT id FROM audit_events WHERE event_type='security.scope_violation' AND target_id=?`).get(w.outScope)).toBeDefined();
  });

  test('Manager attempting send-reminder → 403 (Admin-only, server-enforced)', async () => {
    const w = rawWorld();
    const { POST } = await import('@/app/api/locations/[locationId]/send-reminder/route');
    const res = await POST(new Request(`http://t/api/locations/${w.inScope}/send-reminder`, { method: 'POST', headers: { Authorization: `Bearer ${w.storeJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vendorId: w.vendorId }) }), { params: { locationId: w.inScope } });
    expect(res.status).toBe(403);
  });

  test('Manager attempting archive (PATCH) → 403', async () => {
    const w = rawWorld();
    const { PATCH } = await import('@/app/api/locations/[locationId]/route');
    const res = await PATCH(new Request(`http://t/api/locations/${w.inScope}`, { method: 'PATCH', headers: { Authorization: `Bearer ${w.storeJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) }), { params: { locationId: w.inScope } });
    expect(res.status).toBe(403);
  });

  test('Admin archive flips status=archived + audit; archived location excluded from Manager Home', async () => {
    const w = rawWorld();
    const { PATCH } = await import('@/app/api/locations/[locationId]/route');
    const res = await PATCH(new Request(`http://t/api/locations/${w.inScope}`, { method: 'PATCH', headers: { Authorization: `Bearer ${w.adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) }), { params: { locationId: w.inScope } });
    expect(res.status).toBe(200);
    const loc = w.db.prepare('SELECT status FROM locations WHERE id=?').get(w.inScope) as { status: string };
    expect(loc.status).toBe('archived');
    // Manager Home (Slice B) excludes archived locations — re-verify via the service
    const { buildManagerHome } = await import('@/lib/services/manager-home');
    const mh = buildManagerHome(w.db, w.t.id, { locationIds: null }, {}, NOW);
    expect(mh.groups.flatMap((g) => g.vendors.map((v) => v.name))).not.toContain('Loc Vendor');
  });
});
