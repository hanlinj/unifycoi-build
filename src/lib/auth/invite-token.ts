import crypto from 'crypto';

/**
 * Generate a single-use invite bearer token.
 * Returns both the raw token (sent to vendor in the link) and its SHA-256 hash
 * (stored in invites.token — raw token is never persisted in the DB).
 */
export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashInviteToken(rawToken) };
}

/** Hash an incoming bearer token for DB lookup. */
export function hashInviteToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
