// Notification worker — the consumer of the notifications queue. In-process for v1
// (a setInterval loop inside the Next.js server). Cross-tenant by design: it sends every
// tenant's due rows, each to that row's own recipient — like the migration runner, it is
// infrastructure that legitimately spans tenants, so it uses raw SQL (never reading one
// tenant's data into another's email).
//
// ── Concurrency / crash model: CLAIM-THEN-SEND ──────────────────────────────────
// 1. Reclaim: rows stuck in 'sending' longer than sendingStaleSeconds (a crashed worker
//    left them) are returned to 'queued'.
// 2. Claim: each due 'queued' row is atomically flipped to 'sending' (claimed_at=now)
//    via UPDATE ... WHERE id=? AND status='queued'. Only one claim wins; a 'sent' row is
//    never re-polled.
// 3. Send: via Mailer. On ok → 'sent' (+sent_at). On failure → 'failed' (error captured in
//    payload_json). No retry loop in v1 (no hammering a broken ESP).
//
// Idempotency: a row is sent at most once in steady state. The ONE double-send window is a
// crash AFTER Mailer succeeds but BEFORE the 'sent' UPDATE commits — the row reclaims and
// resends. A real ESP closes this with an idempotency key = notificationId (passed on every
// send for exactly that future use). Documented honestly; not papered over.

import type Database from 'better-sqlite3';
import { logAudit } from '@/lib/audit';
import type { Mailer } from './mailer';
import { resolveFrom } from './mailer';
import { env } from '@/lib/env';

export interface WorkerTickResult {
  reclaimed: number;
  sent: number;
  failed: number;
}

interface DueRow {
  id: string;
  tenant_id: string;
  recipient_type: string;
  recipient_ref: string;
  kind: string;
  payload_json: string;
}

/** One worker pass. Deterministic with an injected `now` for tests. */
export async function processDueNotifications(
  mailer: Mailer,
  db: Database.Database,
  now: Date = new Date(),
  opts: { staleSeconds?: number } = {}
): Promise<WorkerTickResult> {
  const staleSeconds = opts.staleSeconds ?? env.notifications.sendingStaleSeconds;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // 1. Reclaim stale 'sending' rows (a prior worker crashed mid-send).
  const staleCutoff = new Date(nowMs - staleSeconds * 1000).toISOString();
  const reclaimed = db
    .prepare(
      `UPDATE notifications SET status = 'queued', claimed_at = NULL
       WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at <= ?`
    )
    .run(staleCutoff).changes;

  // 2. Find due rows (immediate = scheduled_for null; scheduled = past due).
  const due = db
    .prepare(
      `SELECT id, tenant_id, recipient_type, recipient_ref, kind, payload_json
       FROM notifications
       WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= ?)
       ORDER BY (scheduled_for IS NULL) DESC, scheduled_for ASC`
    )
    .all(nowIso) as DueRow[];

  const claimStmt = db.prepare(
    `UPDATE notifications SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'queued'`
  );

  let sent = 0;
  let failed = 0;

  for (const row of due) {
    // Atomic claim — if another pass already took it, changes===0, skip.
    const claimed = claimStmt.run(nowIso, row.id).changes;
    if (claimed === 0) continue;

    const resolved = resolveRecipient(db, row);
    if (!resolved.ok) {
      markFailed(db, row, resolved.error);
      failed++;
      continue;
    }

    const { subject, body } = renderEmail(row);
    const result = await mailer.send({
      to: resolved.email,
      fromName: resolved.fromName,
      fromEmail: resolved.fromEmail,
      subject,
      body,
      notificationId: row.id, // future ESP idempotency key
    });

    if (result.ok) {
      db.prepare(
        `UPDATE notifications SET status = 'sent', sent_at = ?, claimed_at = NULL WHERE id = ?`
      ).run(new Date().toISOString(), row.id);
      // Comms are logged to the audit trail (Audit_Trail.md): fact + reference, no Sensitive.
      logAudit(db, {
        tenantId: row.tenant_id,
        actorType: 'system',
        actorId: 'notification-worker',
        eventType: 'notification.sent',
        targetType: 'notification',
        targetId: row.id,
        payload: { recipient_type: row.recipient_type, kind: row.kind, message_type: messageType(row) },
      });
      sent++;
    } else {
      markFailed(db, row, result.error ?? 'send failed');
      failed++;
    }
  }

  return { reclaimed, sent, failed };
}

function markFailed(db: Database.Database, row: DueRow, error: string | undefined): void {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  payload['send_error'] = error ?? 'unknown';
  db.prepare(`UPDATE notifications SET status = 'failed', claimed_at = NULL, payload_json = ? WHERE id = ?`).run(
    JSON.stringify(payload),
    row.id
  );
}

type Resolved =
  | { ok: true; email: string; fromName: string; fromEmail: string }
  | { ok: false; error: string };

function resolveRecipient(db: Database.Database, row: DueRow): Resolved {
  if (row.recipient_type === 'vendor') {
    // recipient_ref is the vendor email directly. Operator-branded From.
    if (!row.recipient_ref) return { ok: false, error: 'vendor has no email' };
    const op = db.prepare('SELECT name FROM tenants WHERE id = ?').get(row.tenant_id) as
      | { name: string }
      | undefined;
    const from = resolveFrom('vendor', op?.name ?? null);
    return { ok: true, email: row.recipient_ref, fromName: from.fromName, fromEmail: from.fromEmail };
  }
  // internal user — resolve email by user_id within the tenant.
  const user = db
    .prepare('SELECT email, status FROM users WHERE tenant_id = ? AND id = ?')
    .get(row.tenant_id, row.recipient_ref) as { email: string; status: string } | undefined;
  if (!user || user.status === 'disabled' || !user.email) {
    return { ok: false, error: 'recipient user not deliverable' };
  }
  const from = resolveFrom('internal', null);
  return { ok: true, email: user.email, fromName: from.fromName, fromEmail: from.fromEmail };
}

function messageType(row: DueRow): string {
  try {
    return String((JSON.parse(row.payload_json) as Record<string, unknown>)['type'] ?? 'notification');
  } catch {
    return 'notification';
  }
}

/** Render subject/body from the payload. Plain language; no internal status to vendors. */
function renderEmail(row: DueRow): { subject: string; body: string } {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  const type = String(p['type'] ?? 'notification');
  const vname = String(p['vendor_name'] ?? p['vendor_id'] ?? 'the vendor');

  switch (type) {
    case 'renewal_reminder': {
      const days = p['days_before'];
      return {
        subject: `Your certificate of insurance expires soon`,
        body: `Your insurance certificate expires on ${p['expiration_date']}. Please upload a renewed certificate (${days} days notice).`,
      };
    }
    case 'document_bounced_expired':
      return {
        subject: `Please upload a current certificate`,
        body: `The document you uploaded lists an expired policy and couldn't be accepted. Please upload a current certificate.`,
      };
    case 'vendor_invite':
      return { subject: `You've been invited to submit documents`, body: `Please use your secure link to get started.` };
    case 'correction_requested':
      return { subject: `A quick correction is needed`, body: `Please use your secure link to update your submission.` };
    case 'vendor_submitted':
      return { subject: `Vendor ready for review: ${vname}`, body: `${vname} submitted documents and is awaiting your review.` };
    case 'vendor_declined':
      return { subject: `Vendor declined: ${vname}`, body: `${vname} was declined.` };
    case 'non_compliant_rule_change':
      return { subject: `Vendor now non-compliant: ${vname}`, body: `A requirement change flagged ${vname} as non-compliant.` };
    default:
      return { subject: `Notification`, body: `You have a new compliance update.` };
  }
}

// ── In-process loop wrapper ─────────────────────────────────────────────────────

export interface WorkerHandle {
  stop: () => void;
}

/**
 * Start the in-process notification worker. Returns a handle to stop it. The cadence is a
 * plain setInterval; all logic lives in processDueNotifications (which tests drive directly
 * with a frozen clock). Errors in a tick are swallowed-and-logged so the loop survives.
 */
export function startNotificationWorker(
  mailer: Mailer,
  db: Database.Database,
  intervalSeconds: number = env.notifications.workerPollSeconds
): WorkerHandle {
  const timer = setInterval(() => {
    void processDueNotifications(mailer, db).catch((err) => {
      console.error('[notification-worker] tick failed:', err);
    });
  }, intervalSeconds * 1000);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
