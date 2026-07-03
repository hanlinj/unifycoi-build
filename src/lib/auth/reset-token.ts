import crypto from 'crypto';

/**
 * Generate a single-use password-reset bearer token. Returns the raw token (placed ONLY in
 * the emailed link) and its SHA-256 hash (stored in password_reset_tokens.token_hash — the
 * raw token is never persisted in that table). Mirrors the invite-token pattern.
 */
export function generateResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashResetToken(rawToken) };
}

/** Hash an incoming reset token for DB lookup. */
export function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
