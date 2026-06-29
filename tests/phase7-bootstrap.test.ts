// Phase 7 closing loop — worker bootstrap + tz-aware digest cycle.
//
// Proves the three background workers actually start (return stoppable handles) and that the
// daily digest fires per-tenant based on the tenant's local timezone hour.

import { setupTestDb, seedTenant, seedTenantUser, seedVendor } from './helpers';
import { NoOpMailer } from '@/lib/notifications/mailer';
import { queueNotification } from '@/lib/notifications/queue';
import { startAllWorkers, stopAllWorkers } from '@/lib/workers/bootstrap';
import { runDigestCycle, localHourInZone } from '@/lib/notifications/digest';

// ── startAllWorkers ───────────────────────────────────────────────────────────────

describe('startAllWorkers', () => {
  test('starts all three workers and returns stoppable handles', () => {
    const db = setupTestDb();
    const mailer = new NoOpMailer();

    const handles = startAllWorkers(mailer, db);
    expect(typeof handles.notification.stop).toBe('function');
    expect(typeof handles.digest.stop).toBe('function');
    expect(typeof handles.retention.stop).toBe('function');

    // Stopping must not throw, and leaves no live timers (they are unref'd anyway).
    expect(() => stopAllWorkers(handles)).not.toThrow();
    db.close();
  });
});

// ── localHourInZone ───────────────────────────────────────────────────────────────

describe('localHourInZone', () => {
  const at13Utc = new Date('2026-06-29T13:00:00.000Z'); // summer (DST in US)

  test('UTC is the raw hour', () => {
    expect(localHourInZone(at13Utc, 'UTC')).toBe(13);
  });
  test('America/Chicago (CDT, UTC-5 in summer) is 5 hours back', () => {
    expect(localHourInZone(at13Utc, 'America/Chicago')).toBe(8);
  });
  test('America/New_York (EDT, UTC-4 in summer)', () => {
    expect(localHourInZone(at13Utc, 'America/New_York')).toBe(9);
  });
  test('midnight normalizes to 0, not 24', () => {
    // 05:00Z is 00:00 in Chicago (CDT).
    expect(localHourInZone(new Date('2026-06-29T05:00:00.000Z'), 'America/Chicago')).toBe(0);
  });
});

// ── runDigestCycle (tz-aware firing) ──────────────────────────────────────────────

describe('runDigestCycle', () => {
  // now = 13:00Z. With digestHour=8: Chicago(8) fires; NY(9) and UTC(13) do not.
  const NOW = new Date('2026-06-29T13:00:00.000Z');
  const DIGEST_HOUR = 8;

  function tenantWithTz(db: ReturnType<typeof setupTestDb>, tz: string | null) {
    const t = seedTenant(db);
    db.prepare('UPDATE tenants SET timezone = ? WHERE id = ?').run(tz, t.id);
    return t;
  }

  test('fires only for tenants whose LOCAL hour equals DIGEST_HOUR_LOCAL', async () => {
    const db = setupTestDb();
    const chicago = tenantWithTz(db, 'America/Chicago'); // local 8 → fires
    const ny = tenantWithTz(db, 'America/New_York');      // local 9 → no
    const utc = tenantWithTz(db, 'UTC');                  // local 13 → no

    // Give each a queued digest item + a user recipient.
    for (const t of [chicago, ny, utc]) {
      const admin = seedTenantUser(db, t.id, { role: 'admin' });
      seedVendor(db, t.id);
      queueNotification(db, t.id, { recipientType: 'user', recipientRef: admin.id, kind: 'digest', payload: { type: 'vendor_submitted', vendor_name: 'Acme' } });
    }

    const mailer = new NoOpMailer();
    const res = await runDigestCycle(mailer, db, NOW, DIGEST_HOUR);

    expect(res.tenantsConsidered).toBe(3);
    expect(res.tenantsFired).toBe(1);          // only Chicago
    expect(mailer.sent).toHaveLength(1);
    db.close();
  });

  test('null timezone falls back to UTC and is counted (warning path)', async () => {
    const db = setupTestDb();
    // now=13:00Z → UTC local hour 13. With digestHour=13 the null-tz tenant fires via UTC fallback.
    const nullTz = tenantWithTz(db, null);
    const admin = seedTenantUser(db, nullTz.id, { role: 'admin' });
    queueNotification(db, nullTz.id, { recipientType: 'user', recipientRef: admin.id, kind: 'digest', payload: { type: 'vendor_submitted' } });

    const mailer = new NoOpMailer();
    const res = await runDigestCycle(mailer, db, NOW, 13);
    expect(res.utcFallbacks).toBe(1);
    expect(res.tenantsFired).toBe(1);          // fired via UTC fallback
    expect(mailer.sent).toHaveLength(1);
    db.close();
  });

  test('does not fire for a suspended/non-active tenant even at the right hour', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { lifecycle_state: 'suspended' });
    db.prepare('UPDATE tenants SET timezone = ? WHERE id = ?').run('UTC', t.id);
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    queueNotification(db, t.id, { recipientType: 'user', recipientRef: admin.id, kind: 'digest', payload: { type: 'x' } });

    const mailer = new NoOpMailer();
    const res = await runDigestCycle(mailer, db, NOW, 13); // UTC hour 13 matches, but tenant inactive
    expect(res.tenantsConsidered).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    db.close();
  });
});
