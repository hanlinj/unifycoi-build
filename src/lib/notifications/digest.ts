// Daily digest builder — batches routine (kind='digest') notifications into ONE email per
// internal recipient per run (Notifications_and_Communications.md § Two tiers). Exceptions
// never come through here; they are sent individually by the worker.
//
// "Runs once daily per tenant" — this function does the aggregation+send for one tenant; the
// daily cadence (at DIGEST_HOUR_LOCAL in the tenant timezone) is driven by the scheduling
// worker (Slice C). Kept separate so it is unit-testable with a frozen clock.

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import type { Mailer } from './mailer';
import { resolveFrom } from './mailer';
import { getOperatorName } from './queue';

interface DigestRow {
  id: string;
  recipient_ref: string;        // user_id
  payload_json: string;
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
  db: Database.Database,
  tenantId: string,
  now: Date = new Date()
): Promise<DigestResult> {
  const tdb = new TenantDB(db, tenantId);
  const nowIso = now.toISOString();

  const rows = tdb.all<DigestRow>(
    `SELECT id, recipient_ref, payload_json FROM notifications
     WHERE tenant_id = ? AND kind = 'digest' AND status = 'queued'
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
     ORDER BY recipient_ref, created_at`,
    [nowIso]
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

  const operatorName = getOperatorName(db, tenantId);
  const from = resolveFrom('internal', operatorName);
  let emailsSent = 0;

  for (const [userId, items] of byRecipient) {
    const user = tdb.get<{ email: string; status: string }>(
      'SELECT email, status FROM users WHERE tenant_id = ? AND id = ?',
      [userId]
    );

    if (!user || user.status === 'disabled' || !user.email) {
      // No deliverable recipient — fail the rows so they don't recycle forever.
      for (const it of items) {
        tdb.update('notifications', { status: 'failed' }, { id: it.id });
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

    const nowSent = new Date().toISOString();
    for (const it of items) {
      tdb.update(
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
function digestLine(payloadJson: string): string {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return 'Update';
  }
  const type = String(p['type'] ?? 'update');
  switch (type) {
    case 'vendor_ready_for_review':
      return `Vendor ready for review: ${p['vendor_name'] ?? p['vendor_id']}`;
    case 'clean_auto_continue':
      return `Renewal auto-continued: ${p['vendor_name'] ?? p['vendor_id']}`;
    case 'new_location_activation_ready':
      return `New-location association ready to activate: ${p['vendor_name'] ?? p['vendor_id']}`;
    case 'vendor_activated_at_location':
      return `Vendor activated at a new location: ${p['vendor_name'] ?? p['vendor_id']}`;
    case 'lapse_recovered':
      return `Coverage restored: ${p['vendor_name'] ?? p['vendor_id']}`;
    default:
      return `Update: ${type}`;
  }
}
