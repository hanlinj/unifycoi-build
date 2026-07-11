// Resend delivery webhook — verification + handling, kept as pure functions so the whole
// signature/handling surface is unit-testable without an HTTP pipeline. The route
// (src/app/api/webhooks/resend/route.ts) is thin wiring over these.
//
// Scope (Slice 1): verify authenticity, then RECORD the delivery outcome — mark the
// notification 'bounced' and log a tenant-scoped audit event. This is the spec's
// "a bounce marks the delivery state" + "every send is logged to the audit trail"
// (Notifications_and_Communications.md § Delivery & reliability). The spec's *second*
// half — re-notifying the original inviter to correct-and-resend — is NOT wired here;
// the invite notification payload doesn't carry vendor_id/inviter, so that loop is
// invite-lifecycle work beyond a transport swap. Flagged as a gap, not papered over.

import crypto from 'crypto';
import type { Db } from '@/lib/db/client';
import { logAudit } from '@/lib/audit';

/** Resend signs webhooks Svix-style: three headers + an HMAC over id.timestamp.body. */
export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export interface ResendEvent {
  type?: string;
  data?: { email_id?: string; to?: string | string[]; [k: string]: unknown };
}

const DEFAULT_TOLERANCE_SEC = 300; // reject events whose timestamp is >5m skewed (replay guard)

/**
 * Verify a Resend (Svix) webhook signature. Fails CLOSED: a missing secret, missing
 * header, malformed timestamp, stale timestamp, or non-matching HMAC all return false.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
  nowMs: number,
  toleranceSec: number = DEFAULT_TOLERANCE_SEC
): boolean {
  if (!secret) return false; // no configured secret → cannot verify → reject everything
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSec) return false;

  // Secret is base64, optionally prefixed 'whsec_'.
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // Header is a space-separated list of "v1,<sig>" entries; any match verifies.
  for (const part of signature.split(' ')) {
    const comma = part.indexOf(',');
    const sig = comma === -1 ? part : part.slice(comma + 1);
    if (timingSafeEqualStr(sig, expected)) return true;
  }
  return false;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface HandleResult {
  handled: boolean;
  reason?: string;
  notificationId?: string;
  state?: 'bounced' | 'complained';
}

interface NotifRow {
  id: string;
  tenant_id: string;
  recipient_type: string;
  kind: string;
  payload_json: Record<string, unknown>;
}

/**
 * Apply a verified delivery event to its notification row. Bounce/complaint only;
 * everything else is acknowledged and ignored. Idempotent enough for at-least-once
 * webhook delivery (re-applying the same terminal state is harmless).
 */
export async function handleResendEvent(
  db: Db,
  event: ResendEvent,
  now: Date = new Date()
): Promise<HandleResult> {
  const type = event.type;
  if (type !== 'email.bounced' && type !== 'email.complained') {
    return { handled: false, reason: 'ignored event type' };
  }
  const emailId = event.data?.email_id;
  if (!emailId) return { handled: false, reason: 'no email id' };

  const row = await db
    .selectFrom('notifications')
    .select(['id', 'tenant_id', 'recipient_type', 'kind', 'payload_json'])
    .where('provider_message_id', '=', emailId)
    .executeTakeFirst() as NotifRow | undefined;
  if (!row) return { handled: false, reason: 'unknown message id' };

  const state = type === 'email.bounced' ? 'bounced' : 'complained';

  const payload: Record<string, unknown> = { ...row.payload_json };
  payload['delivery'] = { state, at: now.toISOString() };
  const messageType = String(payload['type'] ?? 'notification');

  // A hard bounce is a terminal send outcome → flip status. A complaint (spam report) is
  // not a delivery failure, so status is left as-is; the outcome is recorded + audited.
  if (state === 'bounced') {
    await db.updateTable('notifications').set({ status: 'bounced', payload_json: JSON.stringify(payload) }).where('id', '=', row.id).execute();
  } else {
    await db.updateTable('notifications').set({ payload_json: JSON.stringify(payload) }).where('id', '=', row.id).execute();
  }

  await logAudit(db, {
    tenantId: row.tenant_id,
    actorType: 'system',
    actorId: 'resend-webhook',
    eventType: state === 'bounced' ? 'notification.bounced' : 'notification.complained',
    targetType: 'notification',
    targetId: row.id,
    payload: { kind: row.kind, recipient_type: row.recipient_type, message_type: messageType },
  });

  return { handled: true, notificationId: row.id, state };
}
