// Phase 11 · Slice 6 — tenant-timezone-aware expiry boundary math (OPS-7, math half).
// Semantics: START of the expiration day in the TENANT's zone (spec's "safest / the moment
// the date passes"). date-only expiry → 00:00 tenant-local; full-ISO → honored as-is.
// UTC/null tenant is a byte-identical no-op vs the old Date.parse behavior.

import { expiryBoundaryMs } from '@/lib/time/zone';
import { setupTestDb, seedTenant, seedTenantUser, seedLocation, seedVendor, seedVendorLocation, seedDocument } from './helpers';
import { scheduleRenewalReminders } from '@/lib/notifications/renewal';
import { processDueNotifications } from '@/lib/notifications/worker';
import { NoOpMailer } from '@/lib/notifications/mailer';
import { buildCommandCenter } from '@/lib/services/command-center';
import { TenantDB } from '@/lib/db/tenant';
import type Database from 'better-sqlite3';

const EXP = '2027-01-01';                          // date-only, the ambiguous case
const SEED_NOW = new Date('2026-06-30T12:00:00Z'); // before every ladder rung → all schedule
const ALL = { locationIds: null as string[] | null };

function approvedVendor(db: Database.Database, tenantId: string, tz: string) {
  db.prepare('UPDATE tenants SET timezone = ? WHERE id = ?').run(tz, tenantId); // test-only; NOT the provisioning path
  const loc = seedLocation(db, tenantId);
  const v = seedVendor(db, tenantId, { contact_email: 'a@x.test' });
  seedVendorLocation(db, tenantId, v.id, loc.id, { status: 'approved' });
  const doc = seedDocument(db, tenantId, v.id, { doc_type: 'coi' });
  scheduleRenewalReminders(db, { tenantId, vendorId: v.id, documentId: doc.id, expirationDate: EXP }, SEED_NOW);
  return { vendorId: v.id };
}
const day0Job = (db: Database.Database, tenantId: string) =>
  new TenantDB(db, tenantId).get<{ scheduled_for: string }>(
    `SELECT scheduled_for FROM notifications WHERE tenant_id=? AND json_extract(payload_json,'$.type')='coi_expiration'`
  )!.scheduled_for;
const locStatus = (db: Database.Database, tenantId: string, vendorId: string) =>
  new TenantDB(db, tenantId).get<{ status: string }>(`SELECT status FROM vendor_locations WHERE tenant_id=? AND vendor_id=?`, [vendorId])!.status;

// ── expiryBoundaryMs (unit) ──────────────────────────────────────────────────

describe('expiryBoundaryMs', () => {
  test('UTC / null tenant is byte-identical to Date.parse for a date-only expiry (no-op)', () => {
    expect(expiryBoundaryMs(EXP, null)).toBe(Date.parse(EXP));
    expect(expiryBoundaryMs(EXP, 'UTC')).toBe(Date.parse(EXP));
  });

  test('west of UTC (Pacific) → boundary is LATER than UTC midnight (vendor stays current longer)', () => {
    expect(expiryBoundaryMs(EXP, 'America/Los_Angeles')).toBe(Date.parse('2027-01-01T08:00:00Z'));
    expect(expiryBoundaryMs(EXP, 'America/Los_Angeles')).toBeGreaterThan(Date.parse(EXP));
  });

  test('east of UTC (Tokyo) → boundary is EARLIER than UTC midnight (vendor flips sooner)', () => {
    expect(expiryBoundaryMs(EXP, 'Asia/Tokyo')).toBe(Date.parse('2026-12-31T15:00:00Z'));
    expect(expiryBoundaryMs(EXP, 'Asia/Tokyo')).toBeLessThan(Date.parse(EXP));
  });

  test('a full-ISO expiry (explicit time/offset) is honored as-is regardless of tz', () => {
    expect(expiryBoundaryMs('2027-01-01T12:00:00Z', 'America/Los_Angeles')).toBe(Date.parse('2027-01-01T12:00:00Z'));
  });

  test('an invalid IANA zone falls back to UTC', () => {
    expect(expiryBoundaryMs(EXP, 'Not/AZone')).toBe(Date.parse(EXP));
  });
});

// ── Day-0 flip resolves at the tenant-local boundary ─────────────────────────

describe('day-0 flip · Pacific (west of UTC)', () => {
  test('scheduled at Pacific midnight (08:00Z), NOT UTC midnight; still current after UTC midnight', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const { vendorId } = approvedVendor(db, t.id, 'America/Los_Angeles');

    expect(day0Job(db, t.id)).toBe(new Date('2027-01-01T08:00:00Z').toISOString());

    // 04:00Z Jan 1 — PAST UTC midnight (UTC-math would call this expired) but still Dec 31 in
    // Pacific, so coverage is still current: the flip must NOT have fired.
    await processDueNotifications(new NoOpMailer(), db, new Date('2027-01-01T04:00:00Z'));
    expect(locStatus(db, t.id, vendorId)).toBe('approved');

    // Past Pacific midnight → now expired.
    await processDueNotifications(new NoOpMailer(), db, new Date('2027-01-01T08:00:01Z'));
    expect(locStatus(db, t.id, vendorId)).toBe('expired');
  });

  test('Command Center agrees with the un-fired flip at 04:00Z (imminent, daysToExpiry 0 — not dropped)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const { vendorId } = approvedVendor(db, t.id, 'America/Los_Angeles');

    // Boundary 08:00Z, now 04:00Z → daysToExpiry = floor(4h/24h) = 0 → imminent.
    // (UTC-math would give floor(-4h/24h) = -1 → the imminent branch drops it → disagreement.)
    const cc = buildCommandCenter(db, t.id, ALL, new Date('2027-01-01T04:00:00Z').getTime());
    const row = cc.tier1.find((r) => r.vendorId === vendorId);
    expect(row).toBeDefined();
    expect(row!.condition).toBe('imminent_lapse');
    expect(row!.daysToExpiry).toBe(0);
  });
});

describe('day-0 flip · Tokyo (east of UTC)', () => {
  test('scheduled at Tokyo midnight (prev-day 15:00Z); expired before UTC midnight', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const { vendorId } = approvedVendor(db, t.id, 'Asia/Tokyo');

    expect(day0Job(db, t.id)).toBe(new Date('2026-12-31T15:00:00Z').toISOString());

    // 16:00Z Dec 31 — past Tokyo midnight (already Jan 1 in Tokyo) so expired, even though
    // UTC-math would still call it current until 2027-01-01T00:00Z.
    await processDueNotifications(new NoOpMailer(), db, new Date('2026-12-31T16:00:00Z'));
    expect(locStatus(db, t.id, vendorId)).toBe('expired');
  });
});

describe('day-0 flip · UTC (no-op)', () => {
  test('a UTC tenant with a date-only expiry is unchanged — flip at 2027-01-01T00:00:00Z', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    seedTenantUser(db, t.id, { role: 'admin' });
    const { vendorId } = approvedVendor(db, t.id, 'UTC');
    expect(day0Job(db, t.id)).toBe(new Date('2027-01-01T00:00:00Z').toISOString());
    expect(vendorId).toBeTruthy();
  });
});
