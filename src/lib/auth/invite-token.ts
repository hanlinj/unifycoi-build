import crypto, { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { withTransaction } from '@/lib/db/transaction';

/**
 * Generate a vendor invite bearer token.
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

export interface IssueInviteTokenInput {
  tenantId: string;
  vendorId: string;
  inviterUserId: string;
  purpose: 'onboarding' | 'correction';
  ttlMs: number;
}

export interface IssuedInviteToken {
  rawToken: string;
  inviteId: string;
  expiresAt: Date;
}

/**
 * Phase 13 Stage 6a — the SINGLE choke point for minting a vendor invite token. Every mint
 * site (createVendorInvite, resendInvite, applyDecision's request_correction branch) routes
 * through this; none of them write the `invites` table directly.
 *
 * **Revoke-on-issue (deliberate security change, not behavior-preservation — see ADR-013-01):**
 * inside one transaction, first sets `revoked_at = now()` on every still-live (not already
 * revoked, not already expired) prior invite for this (tenant_id, vendor_id) — across ALL
 * purposes, not just the one being issued — THEN inserts the new invite row. Before this stage,
 * a vendor invite token was reusable for its full 14-day TTL with no consumption/invalidation
 * step at all, and `resendInvite` minted a fresh token without revoking the old one (both still
 * live simultaneously). TTL itself is unchanged — callers pass their own `ttlMs`, still 14 days
 * for both onboarding and correction. Validating `revoked_at IS NULL` on the read side is 6b's
 * job (`validateInviteToken`, `src/lib/services/vendor-token.ts`) — this function only writes
 * the revocation; portal-side files are out of scope for 6a.
 */
export async function issueInviteToken(db: Db, input: IssueInviteTokenInput): Promise<IssuedInviteToken> {
  const { rawToken, tokenHash } = generateInviteToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const inviteId = randomUUID();

  await withTransaction(db, async (trx) => {
    // TenantDB.update() can only express `col = val` equality WHERE clauses — this predicate
    // needs `IS NULL` and `>`, neither of which fits, so this drops to the Kysely builder
    // directly (same manual tenant_id-scoping TenantDB's own helpers apply internally).
    await trx
      .updateTable('invites')
      .set({ revoked_at: now })
      .where('tenant_id', '=', input.tenantId)
      .where('vendor_id', '=', input.vendorId)
      .where('revoked_at', 'is', null)
      .where('token_expires_at', '>', now)
      .execute();

    const tdb = new TenantDB(trx, input.tenantId);
    await tdb.insert('invites', {
      id: inviteId,
      vendor_id: input.vendorId,
      inviter_user_id: input.inviterUserId,
      token: tokenHash,
      token_expires_at: expiresAt,
      purpose: input.purpose,
      delivery_state: 'sent',
      created_at: now,
    });
  });

  return { rawToken, inviteId, expiresAt };
}
