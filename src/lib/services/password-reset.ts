// Password reset (SEC-8) and invite-accept (Slice 4). One table (password_reset_tokens), one
// crypto primitive (reset-token.ts). Reset and invite tokens are interchangeable through
// confirmPasswordReset — status (invited/active) is the authoritative signal for copy, not
// which flow minted the token.
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

const RESET_TTL_MS = 60 * 60 * 1000; // ~1h
const MIN_PASSWORD_LENGTH = 8;
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
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    randomUUID(),
    user.tenant_id,
    user.id,
    tokenHash,
    new Date(now.getTime() + RESET_TTL_MS).toISOString(),
    now.toISOString()
  );

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
    `INSERT INTO password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(randomUUID(), input.tenantId, input.userId, tokenHash, expiresAt, now.toISOString());

  return { rawToken, expiresAt };
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
  if (!input.newPassword || input.newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'weak_password' };
  }

  const row = db
    .prepare(
      `SELECT id, tenant_id, user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = ?`
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
    // user — a password change invalidates all of those.
    db.prepare(
      `UPDATE password_reset_tokens SET consumed_at = ?
       WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL`
    ).run(nowIso, row.tenant_id, row.user_id);
  });
  tx();

  return { ok: true, userId: row.user_id, tenantId: row.tenant_id };
}
