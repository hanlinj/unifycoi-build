// Password reset (SEC-8), invite-accept (Slice 4), and billing-setup links (Slice 5a.1) — one
// table (password_reset_tokens), one crypto primitive (reset-token.ts), distinguished by a
// `purpose` column ('reset' | 'invite' | 'billing_setup'). Reset/invite are single-use
// (consumed_at) and interchangeable through confirmPasswordReset — status (invited/active) is
// the authoritative signal for copy, not which purpose minted the token. billing_setup is
// deliberately excluded from confirmPasswordReset/peekResetToken (a billing link must never be
// usable to touch a password) and is never "consumed" — it's revisitable until the tenant
// activates, which the caller reads off lifecycle_state.
//
// Request:  resolve email → tenant user (SAME first-match order as login's tenant scan),
//           issue a hashed token, and queue a 'password_reset' notification — the reset
//           email rides the real notification pipeline (worker + resolveFrom), it is not a
//           bespoke send. Enumeration-safe: the caller returns an identical response whether
//           or not the email resolves; this function just no-ops when it doesn't.
// Confirm:  verify hash + not expired + not consumed → set the new password → consume the
//           token AND invalidate every other outstanding reset/invite token for that user.
//
// Reset does NOT invalidate live JWT sessions this phase (stateless JWT; 8h expiry is the
// bound). token_version session-invalidation is deferred to Phase 12.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { hashPassword } from '@/lib/auth/password';
import { generateResetToken, hashResetToken } from '@/lib/auth/reset-token';
import { queueNotification } from '@/lib/notifications/queue';
import { isPasswordValid } from '@/lib/auth/password-policy';
import { logAudit } from '@/lib/audit';

const RESET_TTL_MS = 60 * 60 * 1000; // ~1h
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ~7d — white-glove onboarding pace, not urgent

interface ResettableUser {
  id: string;
  tenant_id: string;
}

/**
 * Resolve an email to the user who may reset — mirrors login's tenant-scan first-match
 * (loginResolvingTenant): first non-disabled tenant user with a usable password, in the
 * same DB order login uses. Multi-tenant-email ambiguity inherits login's first-match
 * behavior (named in the checkpoint). Platform users are out of scope this phase.
 */
function resolveResettableUser(db: Database.Database, email: string): ResettableUser | null {
  const rows = db
    .prepare(
      `SELECT id, tenant_id, password_hash, status FROM users WHERE email = ? COLLATE NOCASE`
    )
    .all(email) as { id: string; tenant_id: string; password_hash: string | null; status: string }[];
  for (const r of rows) {
    if (r.status !== 'disabled' && r.password_hash) return { id: r.id, tenant_id: r.tenant_id };
  }
  return null;
}

/**
 * Issue a reset token + queue the email IFF the email resolves. Always does the token-hash
 * work (even for an unknown email) so the crypto term doesn't diverge; see the checkpoint's
 * timing note for the residual (the DB writes only happen on the found path).
 *
 * Audit (SEC-18): logs `password_reset.requested` ONLY on the match path, attributed to the
 * matched user — never on a no-match. This is not a style choice: audit_events.tenant_id is
 * NOT NULL (tenant isolation is structural, invariant #2), and a no-match request has no tenant
 * to attribute an event to (the email doesn't resolve to any account, anywhere). There is
 * nowhere honest to put a "no-match" row without either inventing a sentinel tenant (a worse
 * hack than not logging) or weakening that NOT NULL constraint (a bigger, unrelated change).
 * This preserves enumeration-safety by construction, not by restraint: the HTTP response this
 * function's caller sends back is identical match-or-not either way (unchanged from Slice 4a),
 * and the audit event is never reflected in that response — it's an internal record an
 * authenticated Admin can see only for THEIR OWN tenant's users, not a probe surface an
 * anonymous requester can query. actorType is 'system' (no authenticated actor exists — the
 * requester isn't logged in), actorId is a fixed descriptive string, same convention as
 * activateTenantOnFirstPayment's 'stripe-webhook'. The payload carries no token/hash/expiry —
 * audit records that a reset was requested, not the credential itself (same principle as the
 * dev-gated logDevInviteUrl never being reachable in production).
 */
export function requestPasswordReset(
  db: Database.Database,
  input: { email: string },
  now: Date = new Date()
): void {
  const { rawToken, tokenHash } = generateResetToken(); // computed regardless (timing symmetry)
  const user = resolveResettableUser(db, input.email);
  if (!user) return; // unknown / disabled / platform-only → silently no-op (no enumeration)

  db.prepare(
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at, purpose)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'reset')`
  ).run(
    randomUUID(),
    user.tenant_id,
    user.id,
    tokenHash,
    new Date(now.getTime() + RESET_TTL_MS).toISOString(),
    now.toISOString()
  );

  logAudit(db, {
    tenantId: user.tenant_id,
    actorType: 'system',
    actorId: 'password-reset-request',
    eventType: 'password_reset.requested',
    targetType: 'user',
    targetId: user.id,
  });

  // A reset is just another notification type — queued to the internal user, sent by the
  // Slice 1 worker with internal (UnifyCOI) From. The raw token rides in the link only.
  queueNotification(db, user.tenant_id, {
    recipientType: 'user',
    recipientRef: user.id,
    kind: 'exception', // action-needed → immediate
    payload: { type: 'password_reset', reset_path: `/reset-password?token=${rawToken}` },
  });
}

/**
 * Issue a first-login credential-set token for a just-provisioned (invited, no password)
 * admin — reuses password_reset_tokens/generateResetToken verbatim (same hash-at-rest, same
 * expiry shape) rather than a parallel token system. Unlike requestPasswordReset, this does
 * NOT queue a notification: the wizard surfaces the raw link directly to the operator, who
 * sends it out-of-band at their own pace (white-glove onboarding, not an emailed reset).
 */
export function issueInviteToken(
  db: Database.Database,
  input: { tenantId: string; userId: string },
  now: Date = new Date()
): { rawToken: string; expiresAt: string } {
  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at, purpose)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'invite')`
  ).run(randomUUID(), input.tenantId, input.userId, tokenHash, expiresAt, now.toISOString());

  return { rawToken, expiresAt };
}

const BILLING_SETUP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // ~90d — operator-paced, same spirit as invites

/**
 * Issue a billing-setup link token (Slice 5a.1) — the SAME table/crypto as reset/invite,
 * distinguished by `purpose` (the ledger's predicted moment to add that column: this is the
 * first consumer that actually needs to query by it, since a billing-setup token must never be
 * usable to reset/accept a password, and vice versa). Unlike reset/invite, this token is NOT
 * single-use-then-dead: the card-entry page must stay revisitable if the customer abandons it
 * mid-entry, so nothing here ever sets consumed_at. Whether setup is "done" is read off the
 * tenant's lifecycle_state by the caller — same status-is-authoritative principle as Slice 4a.
 */
export function issueBillingSetupToken(
  db: Database.Database,
  input: { tenantId: string; userId: string },
  now: Date = new Date()
): { rawToken: string; expiresAt: string } {
  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(now.getTime() + BILLING_SETUP_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at, purpose)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'billing_setup')`
  ).run(randomUUID(), input.tenantId, input.userId, tokenHash, expiresAt, now.toISOString());

  return { rawToken, expiresAt };
}

export type BillingSetupTokenStatus = 'valid' | 'expired' | 'invalid';

export interface BillingSetupTokenPeek {
  status: BillingSetupTokenStatus;
  tenantId?: string;
}

/**
 * Resolve a billing-setup token to its tenant — gated on purpose='billing_setup' so a
 * reset/invite token (or vice versa) can never cross-use this path. No consumed_at check: the
 * page is meant to be revisited (declined card, closed tab) until the tenant actually activates,
 * which the caller checks via lifecycle_state, not via this function.
 */
export function resolveBillingSetupToken(
  db: Database.Database,
  rawToken: string,
  now: Date = new Date()
): BillingSetupTokenPeek {
  const row = db
    .prepare(`SELECT tenant_id, expires_at, purpose FROM password_reset_tokens WHERE token_hash = ?`)
    .get(hashResetToken(rawToken)) as { tenant_id: string; expires_at: string; purpose: string } | undefined;
  if (!row || row.purpose !== 'billing_setup') return { status: 'invalid' };
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { status: 'expired' };
  return { status: 'valid', tenantId: row.tenant_id };
}

export interface TokenPeek {
  status: 'valid' | 'expired' | 'consumed' | 'invalid';
  userId?: string;
  tenantId?: string;
  /** The target user's status ('invited' | 'active' | 'disabled') — the credential-set landing
   *  page branches its copy on THIS, not on token origin (the table carries no reset/invite
   *  discriminator, and status is the more correct signal: token-origin is just history). */
  userStatus?: string;
  tenantName?: string;
}

/**
 * Read-only pre-check for the credential-set landing page: distinguishes invalid / expired /
 * consumed / valid WITHOUT consuming the token, so the page can render status-appropriate copy
 * (and the right dead-end) before ever showing a password field. confirmPasswordReset (the
 * write path) deliberately collapses all three failure cases into 'invalid_token' — that's a
 * separate, intentional choice (see its docstring); this function exists precisely to give the
 * landing page the finer-grained read that the write path doesn't expose.
 *
 * Note (flagged, not hidden): this reveals slightly more about a token's history than the
 * confirm endpoint does (e.g. "this token existed and was already used" vs a flat "invalid").
 * The raw token is an unguessable 256-bit value, so the marginal oracle value to an attacker
 * is negligible — but it IS a real, deliberate trade for the UX this page needs.
 */
export function peekResetToken(
  db: Database.Database,
  rawToken: string,
  now: Date = new Date()
): TokenPeek {
  const row = db
    .prepare(
      `SELECT user_id, tenant_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = ? AND purpose != 'billing_setup'`
    )
    .get(hashResetToken(rawToken)) as
    | { user_id: string; tenant_id: string; expires_at: string; consumed_at: string | null }
    | undefined;
  if (!row) return { status: 'invalid' };

  const user = db
    .prepare(`SELECT status FROM users WHERE id = ? AND tenant_id = ?`)
    .get(row.user_id, row.tenant_id) as { status: string } | undefined;
  const tenant = db.prepare(`SELECT name FROM tenants WHERE id = ?`).get(row.tenant_id) as { name: string } | undefined;
  const userStatus = user?.status;
  const tenantName = tenant?.name;

  if (row.consumed_at) return { status: 'consumed', userStatus, tenantName };
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { status: 'expired', userStatus, tenantName };
  if (!user || !tenant) return { status: 'invalid' }; // defensive; FK integrity should prevent this
  return { status: 'valid', userId: row.user_id, tenantId: row.tenant_id, userStatus, tenantName };
}

export type ConfirmResult =
  | { ok: true; userId: string; tenantId: string }
  | { ok: false; reason: 'invalid_token' | 'weak_password' };

/**
 * Confirm a reset: validate the token, set the new password, consume this token, and
 * invalidate all other outstanding tokens for that user.
 */
export function confirmPasswordReset(
  db: Database.Database,
  input: { rawToken: string; newPassword: string },
  now: Date = new Date()
): ConfirmResult {
  if (!isPasswordValid(input.newPassword)) {
    return { ok: false, reason: 'weak_password' };
  }

  const row = db
    .prepare(
      `SELECT id, tenant_id, user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = ? AND purpose != 'billing_setup'`
    )
    .get(hashResetToken(input.rawToken)) as
    | { id: string; tenant_id: string; user_id: string; expires_at: string; consumed_at: string | null }
    | undefined;

  if (!row) return { ok: false, reason: 'invalid_token' };
  if (row.consumed_at) return { ok: false, reason: 'invalid_token' }; // single-use
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'invalid_token' };

  const nowIso = now.toISOString();
  const tx = db.transaction(() => {
    // Setting a password consumes the "invited" (no-credential) state too — this same token
    // machinery backs both password-reset (already active) and invite-accept (first login),
    // so an invited user who lands here via their invite link becomes active in one step.
    db.prepare(
      `UPDATE users SET password_hash = ?, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
       WHERE id = ? AND tenant_id = ?`
    ).run(hashPassword(input.newPassword), row.user_id, row.tenant_id);
    // Consume this token and invalidate every other outstanding reset/invite token for the
    // user — a password change invalidates all of those. Billing-setup tokens are excluded:
    // they're a different purpose (never "consumed" in this sense; gated on lifecycle_state,
    // not consumed_at) and shouldn't be touched by an unrelated credential change.
    db.prepare(
      `UPDATE password_reset_tokens SET consumed_at = ?
       WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL AND purpose != 'billing_setup'`
    ).run(nowIso, row.tenant_id, row.user_id);
  });
  tx();

  return { ok: true, userId: row.user_id, tenantId: row.tenant_id };
}
