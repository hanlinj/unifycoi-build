import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { hashInviteToken } from '@/lib/auth/invite-token';

export interface ValidatedToken {
  invite: {
    id: string;
    tenant_id: string;
    vendor_id: string;
    inviter_user_id: string;
    token_expires_at: string;
    purpose: string;
    delivery_state: string;
  };
  vendor: {
    id: string;
    business_name: string;
    contact_name: string | null;
    trade: string;
  };
  vendorLocations: { location_id: string; status: string }[];
}

/**
 * Validates a raw invite bearer token for the vendor flow.
 * Returns null for unknown, expired, or revoked tokens — uniform null so
 * callers return the same 401 response for all three cases (enumeration-resistant).
 * Stage 6b wires up the `revoked_at IS NOT NULL` check (revoke-on-issue was written by Stage
 * 6a; this is where it's read) — it joins the SAME uniform-null return as the other invalid
 * cases below, deliberately not a distinguishable branch: a revoked token must be
 * indistinguishable from a token that never existed, or `revoked_at` itself becomes an
 * enumeration oracle.
 *
 * Lookup is always by SHA-256 hash of the raw token. The raw token is never stored.
 * The invite row carries tenant_id; all subsequent queries are tenant-scoped via TenantDB —
 * scoping comes from the resolved invite row, never from anything in the request.
 */
export async function validateInviteToken(
  db: Db,
  rawToken: string
): Promise<ValidatedToken | null> {
  const tokenHash = hashInviteToken(rawToken);

  const invite = await db
    .selectFrom('invites')
    .select(['id', 'tenant_id', 'vendor_id', 'inviter_user_id', 'token_expires_at', 'purpose', 'delivery_state', 'revoked_at'])
    .where('token', '=', tokenHash)
    .executeTakeFirst();

  if (!invite) return null;
  if (invite.revoked_at !== null) return null;
  if (invite.token_expires_at.getTime() < Date.now()) return null;
  if (invite.delivery_state === 'bounced' || invite.delivery_state === 'expired_invite') return null;

  const tdb = new TenantDB(db, invite.tenant_id);

  const vendor = await tdb.get<ValidatedToken['vendor']>(
    'SELECT id, business_name, contact_name, trade FROM vendors WHERE tenant_id = $1 AND id = $2',
    [invite.vendor_id]
  );
  if (!vendor) return null;

  const vendorLocations = await tdb.all<{ location_id: string; status: string }>(
    'SELECT location_id, status FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2',
    [invite.vendor_id]
  );

  return {
    invite: {
      id: invite.id,
      tenant_id: invite.tenant_id,
      vendor_id: invite.vendor_id,
      inviter_user_id: invite.inviter_user_id,
      token_expires_at: invite.token_expires_at.toISOString(),
      purpose: invite.purpose,
      delivery_state: invite.delivery_state,
    },
    vendor,
    vendorLocations,
  };
}

/** Uniform 401 message for all invalid-token states (unknown / expired / revoked). */
export const INVALID_TOKEN_MESSAGE =
  'This link is invalid or has expired. Ask your contact to resend it.';
