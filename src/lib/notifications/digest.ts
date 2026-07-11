// Daily digest builder — batches routine (kind='digest') notifications into ONE email per
// internal recipient per run (Notifications_and_Communications.md § Two tiers). Exceptions
// never come through here; they are sent individually by the worker.
//
// "Runs once daily per tenant" — this function does the aggregation+send for one tenant; the
// daily cadence (at DIGEST_HOUR_LOCAL in the tenant timezone) is driven by the scheduling
// worker (Slice C). Kept separate so it is unit-testable with a frozen clock.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import type { Mailer } from './mailer';
import { resolveFrom } from './mailer';
import { getOperatorName } from './queue';
import { env } from '@/lib/env';
import { localHourInZone } from '@/lib/time/zone';
// Re-exported so existing importers (`@/lib/notifications/digest`) keep working after the
// tz helpers were consolidated into @/lib/time/zone (one timezone treatment).
export { localHourInZone } from '@/lib/time/zone';

interface DigestRow {
  id: string;
  recipient_ref: string;        // user_id
  payload_json: Record<string, unknown>;
}

export interface DigestResult {
  tenantId: string;
  recipients: number;
  itemsBatched: number;
  emailsSent: number;
  skippedEmpty: boolean;
}

/**
 * Aggregate and send the daily digest for one tenant.
 * - Collects all kind='digest', status='queued' rows due at/before `now`.
 * - Groups by recipient, sends one email each (internal branding), marks rows 'sent'.
 * - Empty digest → no send (spec: don't email an empty summary).
 * - A recipient with no resolvable email → their rows marked 'failed' (not left stuck).
 */
export async function buildAndSendDigest(
  mailer: Mailer,
  db: Db,
  tenantId: string,
  now: Date = new Date()
): Promise<DigestResult> {
  const tdb = new TenantDB(db, tenantId);

  const rows = await tdb.all<DigestRow>(
    `SELECT id, recipient_ref, payload_json FROM notifications
     WHERE tenant_id = $1 AND kind = 'digest' AND status = 'queued'
       AND (scheduled_for IS NULL OR scheduled_for <= $2)
     ORDER BY recipient_ref, created_at`,
    [now]
  );

  if (rows.length === 0) {
    return { tenantId, recipients: 0, itemsBatched: 0, emailsSent: 0, skippedEmpty: true };
  }

  // Group by recipient (user_id)
  const byRecipient = new Map<string, DigestRow[]>();
  for (const r of rows) {
    const list = byRecipient.get(r.recipient_ref) ?? [];
    list.push(r);
    byRecipient.set(r.recipient_ref, list);
  }

  const operatorName = await getOperatorName(db, tenantId);
  const from = resolveFrom('internal', operatorName);
  let emailsSent = 0;

  for (const [userId, items] of byRecipient) {
    const user = await tdb.get<{ email: string; status: string }>(
      'SELECT email, status FROM users WHERE tenant_id = $1 AND id = $2',
      [userId]
    );

    if (!user || user.status === 'disabled' || !user.email) {
      // No deliverable recipient — fail the rows so they don't recycle forever.
      for (const it of items) {
        await tdb.update('notifications', { status: 'failed' }, { id: it.id });
      }
      continue;
    }

    const lines = items.map((it) => digestLine(it.payload_json));
    const body =
      `Here's your daily compliance summary (${items.length} item${items.length === 1 ? '' : 's'}):\n\n` +
      lines.map((l) => `• ${l}`).join('\n');

    const result = await mailer.send({
      to: user.email,
      fromName: from.fromName,
      fromEmail: from.fromEmail,
      subject: `Daily compliance digest — ${items.length} item${items.length === 1 ? '' : 's'}`,
      body,
    });

    const nowSent = new Date();
    for (const it of items) {
      await tdb.update(
        'notifications',
        result.ok ? { status: 'sent', sent_at: nowSent } : { status: 'failed' },
        { id: it.id }
      );
    }
    if (result.ok) emailsSent++;
  }

  return {
    tenantId,
    recipients: byRecipient.size,
    itemsBatched: rows.length,
    emailsSent,
    skippedEmpty: false,
  };
}

/** Render a single human-readable digest line from a notification payload. */
function digestLine(payload: Record<string, unknown>): string {
  const type = String(payload['type'] ?? 'update');
  switch (type) {
    case 'vendor_submitted':
    case 'vendor_ready_for_review':
      return `Vendor ready for review: ${payload['vendor_name'] ?? payload['vendor_id']}`;
    case 'clean_auto_continue':
      return `Renewal auto-continued: ${payload['vendor_name'] ?? payload['vendor_id']}`;
    case 'new_location_activation_ready':
      return `New-location association ready to activate: ${payload['vendor_name'] ?? payload['vendor_id']}`;
    case 'vendor_activated_at_location':
      return `Vendor activated at a new location: ${payload['vendor_name'] ?? payload['vendor_id']}`;
    case 'lapse_recovered':
      return `Coverage restored: ${payload['vendor_name'] ?? payload['vendor_id']}`;
    default:
      return `Update: ${type}`;
  }
}

// ── Timezone-aware daily cycle ────────────────────────────────────────────────────
// localHourInZone now lives in @/lib/time/zone (imported + re-exported above).

export interface DigestCycleResult {
  tenantsConsidered: number;
  tenantsFired: number;
  utcFallbacks: number;
}

/**
 * Run the daily digest for every ACTIVE tenant whose LOCAL hour right now equals
 * DIGEST_HOUR_LOCAL. Tenants with no configured timezone fall back to UTC (per the kickoff
 * assumption) and emit a warning so the gap surfaces in operational logs.
 *
 * Intended to be called once per hour (see startDigestWorker); the hour-match gate makes it
 * fire ~once/day per tenant. Idempotent within the hour: buildAndSendDigest drains queued
 * rows, so a second call the same hour finds nothing new.
 */
export async function runDigestCycle(
  mailer: Mailer,
  db: Db,
  now: Date = new Date(),
  digestHour: number = env.notifications.digestHourLocal
): Promise<DigestCycleResult> {
  const tenants = await db
    .selectFrom('tenants')
    .select(['id', 'timezone'])
    .where('lifecycle_state', '=', 'active')
    .execute() as { id: string; timezone: string | null }[];

  let tenantsFired = 0;
  let utcFallbacks = 0;

  for (const t of tenants) {
    let tz = t.timezone;
    if (!tz) {
      tz = 'UTC';
      utcFallbacks++;
      console.warn(`[digest] tenant ${t.id} has no timezone; falling back to UTC for digest timing`);
    }

    let hour: number;
    try {
      hour = localHourInZone(now, tz);
    } catch {
      // Bad tz string — fail safe to UTC and warn.
      console.warn(`[digest] tenant ${t.id} has invalid timezone "${tz}"; falling back to UTC`);
      hour = localHourInZone(now, 'UTC');
      utcFallbacks++;
    }

    if (hour === digestHour) {
      await buildAndSendDigest(mailer, db, t.id, now);
      tenantsFired++;
    }
  }

  return { tenantsConsidered: tenants.length, tenantsFired, utcFallbacks };
}

export interface DigestWorkerHandle {
  stop: () => void;
}

/**
 * Start the hourly digest cycle. Logic lives in runDigestCycle (tested with a frozen clock).
 *
 * OPS-6 (docs/launch-prep.md): this worker is NOT leader-elected — running more than one app
 * instance double-runs the daily digest cycle for every tenant (each instance's hourly tick
 * fires the same tenant's digest independently). Deliberately deferred to "before any
 * horizontal scaling," not fixed here — single-instance deployment is a real, current
 * precondition for this worker's correctness, not just a performance nicety.
 */
export function startDigestWorker(
  mailer: Mailer,
  db: Db,
  intervalSeconds: number = 60 * 60
): DigestWorkerHandle {
  const timer = setInterval(() => {
    void runDigestCycle(mailer, db).catch((err) => {
      console.error('[digest-worker] cycle failed:', err);
    });
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
