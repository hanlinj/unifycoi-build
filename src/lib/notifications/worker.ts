// Notification worker — the consumer of the notifications queue. In-process for v1
// (a setInterval loop inside the Next.js server). Cross-tenant by design: it sends every
// tenant's due rows, each to that row's own recipient — like the migration runner, it is
// infrastructure that legitimately spans tenants, so it uses raw Kysely (never reading one
// tenant's data into another's email).
//
// ── Concurrency / crash model: CLAIM-THEN-SEND ──────────────────────────────────
// 1. Reclaim: rows stuck in 'sending' longer than sendingStaleSeconds (a crashed worker
//    left them) are returned to 'queued'.
// 2. Claim: each due 'queued' row is atomically flipped to 'sending' (claimed_at=now)
//    via UPDATE ... WHERE id=? AND status='queued'. Only one claim wins; a 'sent' row is
//    never re-polled. Phase 13 migration, Stage 8b: the discovery SELECT above is
//    non-binding — correctness rests entirely on this per-row guarded UPDATE, whose WHERE
//    predicate Postgres evaluates transactionally at the row level. That already makes this
//    claim safe under arbitrary concurrency (overlapping ticks, or genuinely separate app
//    instances) with no FOR UPDATE SKIP LOCKED needed — checked and confirmed, not assumed;
//    see ADR-013-01's Stage 8b entry. (OPS-6, docs/launch-prep.md: this worker is one of the
//    two already claim-guarded ones — unlike digest/retention, which are NOT leader-elected
//    and still require single-instance deployment.)
// 3. Send: via Mailer. On ok → 'sent' (+sent_at). On failure → 'failed' (error captured in
//    payload_json). No retry loop in v1 (no hammering a broken ESP).
//
// Idempotency: a row is sent at most once in steady state. The ONE double-send window is a
// crash AFTER Mailer succeeds but BEFORE the 'sent' UPDATE commits — the row reclaims and
// resends. A real ESP closes this with an idempotency key = notificationId (passed on every
// send for exactly that future use). Documented honestly; not papered over.

import { sql } from 'kysely';
import type { Db } from '@/lib/db/client';
import { logAudit } from '@/lib/audit';
import type { Mailer } from './mailer';
import { resolveFrom } from './mailer';
import { applyExpirationFlip } from './renewal';
import { captureSecurityAlert } from '@/lib/observability';
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
  payload_json: Record<string, unknown>;
}

/** One worker pass. Deterministic with an injected `now` for tests. */
export async function processDueNotifications(
  mailer: Mailer,
  db: Db,
  now: Date = new Date(),
  opts: { staleSeconds?: number } = {}
): Promise<WorkerTickResult> {
  const staleSeconds = opts.staleSeconds ?? env.notifications.sendingStaleSeconds;
  const staleCutoff = new Date(now.getTime() - staleSeconds * 1000);

  // 1. Reclaim stale 'sending' rows (a prior worker crashed mid-send).
  const reclaimRes = await db
    .updateTable('notifications')
    .set({ status: 'queued', claimed_at: null })
    .where('status', '=', 'sending')
    .where('claimed_at', 'is not', null)
    .where('claimed_at', '<=', staleCutoff)
    .executeTakeFirst();
  const reclaimed = Number(reclaimRes.numUpdatedRows);

  // 2. Find due rows (immediate = scheduled_for null; scheduled = past due). Discovery only —
  //    not a claim; see the module doc comment on the claim's own atomicity.
  const due = (await db
    .selectFrom('notifications')
    .select(['id', 'tenant_id', 'recipient_type', 'recipient_ref', 'kind', 'payload_json'])
    .where('status', '=', 'queued')
    .where((eb) => eb.or([eb('scheduled_for', 'is', null), eb('scheduled_for', '<=', now)]))
    .orderBy(sql`(scheduled_for IS NULL)`, 'desc')
    .orderBy('scheduled_for', 'asc')
    .execute()) as DueRow[];

  let sent = 0;
  let failed = 0;

  for (const row of due) {
    // Atomic claim — if another pass already took it, numUpdatedRows===0, skip.
    const claimRes = await db
      .updateTable('notifications')
      .set({ status: 'sending', claimed_at: now })
      .where('id', '=', row.id)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    if (Number(claimRes.numUpdatedRows) === 0) continue;

    // Internal action job, not an email: the day-0 expiration flip.
    if (messageType(row) === 'coi_expiration') {
      try {
        const payload = row.payload_json as { vendor_id?: string; document_id?: string | null };
        if (payload.vendor_id) {
          await applyExpirationFlip(db, { tenantId: row.tenant_id, vendorId: payload.vendor_id, documentId: payload.document_id ?? null }, now);
        }
        await db.updateTable('notifications').set({ status: 'sent', sent_at: new Date(), claimed_at: null }).where('id', '=', row.id).execute();
        sent++;
      } catch (err) {
        await markFailed(db, row, (err as Error).message);
        failed++;
      }
      continue;
    }

    const resolved = await resolveRecipient(db, row);
    if (!resolved.ok) {
      await markFailed(db, row, resolved.error);
      failed++;
      continue;
    }

    // resolved.fromName is already the operator's display name for a vendor recipient
    // (resolveFrom('vendor', ...) inside resolveRecipient) — surfaced into the body so vendor
    // copy can reference the same name that's already branding the From header.
    const { subject, body } = renderEmail(row, resolved.fromName);
    const result = await mailer.send({
      to: resolved.email,
      fromName: resolved.fromName,
      fromEmail: resolved.fromEmail,
      subject,
      body,
      notificationId: row.id, // future ESP idempotency key
    });

    if (result.ok) {
      // Persist the ESP message id (when the transport returns one) so the delivery
      // webhook can correlate a bounce/complaint back to this row. NoOp mailer → null.
      // Password-reset only: scrub the raw token from the row now that the link has been
      // delivered (see scrubResetToken) — it must not persist at rest past send.
      const scrubbed = scrubResetToken(row.payload_json);
      if (scrubbed !== null) {
        await db
          .updateTable('notifications')
          .set({ status: 'sent', sent_at: new Date(), claimed_at: null, provider_message_id: result.providerId ?? null, payload_json: JSON.stringify(scrubbed) })
          .where('id', '=', row.id)
          .execute();
      } else {
        await db
          .updateTable('notifications')
          .set({ status: 'sent', sent_at: new Date(), claimed_at: null, provider_message_id: result.providerId ?? null })
          .where('id', '=', row.id)
          .execute();
      }
      // Comms are logged to the audit trail (Audit_Trail.md): fact + reference, no Sensitive.
      await logAudit(db, {
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
      await markFailed(db, row, result.error ?? 'send failed');
      failed++;
    }
  }

  return { reclaimed, sent, failed };
}

async function markFailed(db: Db, row: DueRow, error: string | undefined): Promise<void> {
  const payload: Record<string, unknown> = { ...row.payload_json };
  payload['send_error'] = error ?? 'unknown';
  // Password-reset only: scrub the raw token on a FAILED send-attempt too, so the goal
  // ("cleartext only in the send-pending window") holds even when delivery fails and the
  // row would otherwise linger as 'failed' with the token for the token's full TTL. A
  // failed reset is undelivered anyway — the user re-requests to get a fresh token.
  if (payload['type'] === 'password_reset') {
    payload['reset_path'] = null;
    payload['token_scrubbed'] = true;
  }
  await db
    .updateTable('notifications')
    .set({ status: 'failed', claimed_at: null, payload_json: JSON.stringify(payload) })
    .where('id', '=', row.id)
    .execute();
  // OPS-3: a send failure is an ops signal. IDs + kind only; error message scrubbed.
  captureSecurityAlert('notification.failed', {
    tenant_id: row.tenant_id, notification_id: row.id, kind: row.kind, error: error ?? 'unknown',
  });
}

/**
 * Password-reset ONLY (Slice 3 amendment): the raw reset token must ride payload_json so
 * the worker can render the emailed link — but a reset token takes over an existing account
 * on /confirm (higher blast radius than an invite token), and payload_json lives in the SAME
 * DB as the hash-only verifier table, so a raw token sitting there at rest partly undoes the
 * hash-only property for the token's TTL. Once the link is delivered, null the token-bearing
 * field. Returns the scrubbed payload for a reset row, or null for any other message type
 * (nothing to scrub). Invite tokens are deliberately untouched — separate risk object.
 */
function scrubResetToken(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload['type'] !== 'password_reset') return null;
  return { ...payload, reset_path: null, token_scrubbed: true };
}

type Resolved =
  | { ok: true; email: string; fromName: string; fromEmail: string }
  | { ok: false; error: string };

async function resolveRecipient(db: Db, row: DueRow): Promise<Resolved> {
  if (row.recipient_type === 'vendor') {
    // recipient_ref is the vendor email directly. Operator-branded From.
    if (!row.recipient_ref) return { ok: false, error: 'vendor has no email' };
    const op = await db.selectFrom('tenants').select('name').where('id', '=', row.tenant_id).executeTakeFirst();
    const from = resolveFrom('vendor', op?.name ?? null);
    return { ok: true, email: row.recipient_ref, fromName: from.fromName, fromEmail: from.fromEmail };
  }
  // internal user — resolve email by user_id within the tenant.
  const user = await db
    .selectFrom('users')
    .select(['email', 'status'])
    .where('tenant_id', '=', row.tenant_id)
    .where('id', '=', row.recipient_ref)
    .executeTakeFirst();
  if (!user || user.status === 'disabled' || !user.email) {
    return { ok: false, error: 'recipient user not deliverable' };
  }
  const from = resolveFrom('internal', null);
  return { ok: true, email: user.email, fromName: from.fromName, fromEmail: from.fromEmail };
}

function messageType(row: DueRow): string {
  return String(row.payload_json['type'] ?? 'notification');
}

// Every link emailed on the queue path must be absolute (env.app.baseUrl + the relative path
// already in payload_json) — mirrors what the direct-send flows (provisioning.ts,
// stripe-webhook.ts) already do at their own point of construction. `path` is always one of
// the relative paths this codebase mints (invite_path: `/v/${token}`, reset_path:
// `/reset-password?token=${token}`), never itself absolute.
function absoluteLink(path: unknown): string {
  return `${env.app.baseUrl}${String(path ?? '')}`;
}

/** ISO timestamp -> human-readable date ("July 27, 2026"). Falls back to the raw value if it
 *  doesn't parse, rather than emitting "Invalid Date". */
function formatExpiry(value: unknown): string {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** requirement_key[] -> a readable comma list ("General Liability Limit, Additional Insured"). */
function formatDeficientRequirements(keys: unknown): string {
  if (!Array.isArray(keys)) return '';
  return keys
    .map((k) => String(k).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(', ');
}

/**
 * Render subject/body from the payload. Plain language; no internal status to vendors.
 * `operatorName` is the same already-resolved operator display name that brands the From
 * header (resolveFrom('vendor', ...) inside resolveRecipient) — passed in because
 * payload_json never carries the tenant's own name, only the vendor's.
 */
function renderEmail(row: DueRow, operatorName: string): { subject: string; body: string } {
  const p = row.payload_json;
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
    case 'vendor_invite': {
      // contact_first_name is always present here: the initial invite (createVendorInvite)
      // gets it straight from the onboarding form; a resend derives it from contact_name with
      // a business_name fallback (src/lib/services/resend-invite.ts) — never blank/undefined.
      const firstName = String(p['contact_first_name'] ?? '');
      const businessName = String(p['business_name'] ?? '');
      const inviteUrl = absoluteLink(p['invite_path']);
      const expires = formatExpiry(p['expires_at']);
      const customNotes = typeof p['custom_notes'] === 'string' ? p['custom_notes'].trim() : '';
      return {
        subject: `${operatorName} — finish your vendor setup`,
        body:
          `Hi ${firstName},\n\n` +
          `Following up on your conversation with ${operatorName} — here's the secure link to finish setting up ${businessName} as an approved vendor:\n\n` +
          `${inviteUrl}\n\n` +
          `It's quick, but it helps to have three things handy before you start: your certificate of insurance, a completed W-9, and your preferred payment info. You can upload everything in one sitting.\n\n` +
          `This link is unique to your business and expires ${expires}. Any questions, just reply.` +
          (customNotes ? `\n\n${customNotes}` : ''),
      };
    }
    case 'password_reset':
      return {
        subject: `Reset your password`,
        body: `We received a request to reset your password. Use this link to choose a new one (it expires in 1 hour): ${absoluteLink(p['reset_path'])}\n\nIf you didn't request this, you can ignore this email.`,
      };
    case 'correction_requested': {
      // decision.ts (off-limits — decision logic) never selects a contact name for this path,
      // only business_name (stored here under vendor_name) — so the greeting uses the business
      // name in place of a person's name, unlike vendor_invite which does have one.
      const businessName = String(p['vendor_name'] ?? 'there');
      const inviteUrl = absoluteLink(p['invite_path']);
      const expires = formatExpiry(p['expires_at']);
      const reason = typeof p['reason'] === 'string' ? p['reason'].trim() : '';
      const deficientList = formatDeficientRequirements(p['deficient_requirements']);
      const correctionLine = reason || deficientList;
      return {
        subject: `One correction needed on your vendor submission`,
        body:
          `Hi ${businessName},\n\n` +
          `Thanks for your submission. ${operatorName} reviewed it for ${businessName} and needs one correction before it can be approved:\n\n` +
          (correctionLine ? `${correctionLine}\n\n` : '') +
          `Update your submission here:\n\n` +
          `${inviteUrl}\n\n` +
          `This secure link expires ${expires}.`,
      };
    }
    case 'vendor_submitted':
      return { subject: `Vendor ready for review: ${vname}`, body: `${vname} submitted documents and is awaiting your review.` };
    case 'vendor_declined':
      return { subject: `Vendor declined: ${vname}`, body: `${vname} was declined.` };
    case 'vendor_expired':
      return { subject: `Vendor coverage expired: ${vname}`, body: `${vname}'s coverage has lapsed and the vendor is no longer hireable.` };
    case 'imminent_lapse_admin': {
      const days = p['days_before'];
      return { subject: `Coverage expiring in ${days}d: ${vname}`, body: `${vname} expires in ${days} days with no renewal uploaded yet.` };
    }
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
 * Safe under multiple app instances (claim-guarded — see the module doc comment above); no
 * OPS-6 single-instance constraint applies to this worker specifically.
 */
export function startNotificationWorker(
  mailer: Mailer,
  db: Db,
  intervalSeconds: number = env.notifications.workerPollSeconds
): WorkerHandle {
  const timer = setInterval(() => {
    void processDueNotifications(mailer, db)
      .then((result) => {
        console.log('[notification-worker] tick ok, processed', result.sent + result.failed);
      })
      .catch((err) => {
        console.error('[notification-worker] tick failed:', err);
      });
  }, intervalSeconds * 1000);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
