import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { hashInviteToken } from '@/lib/auth/invite-token';

export interface ValidatedToken {
  invite: {
    id: string;
    tenant_id: string;
    vendor_id: string;
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
 *
 * Lookup is always by SHA-256 hash of the raw token. The raw token is never stored.
 * The invite row carries tenant_id; all subsequent queries are tenant-scoped via TenantDB.
 */
export function validateInviteToken(
  db: Database.Database,
  rawToken: string
): ValidatedToken | null {
  const tokenHash = hashInviteToken(rawToken);

  const invite = db
    .prepare(
      `SELECT id, tenant_id, vendor_id, token_expires_at, purpose, delivery_state
       FROM invites WHERE token = ?`
    )
    .get(tokenHash) as ValidatedToken['invite'] | undefined;

  if (!invite) return null;
  if (new Date(invite.token_expires_at) < new Date()) return null;
  if (invite.delivery_state === 'bounced' || invite.delivery_state === 'expired_invite') return null;

  const vendor = db
    .prepare(
      `SELECT id, business_name, contact_name, trade
       FROM vendors WHERE tenant_id = ? AND id = ?`
    )
    .get(invite.tenant_id, invite.vendor_id) as ValidatedToken['vendor'] | undefined;

  if (!vendor) return null;

  const tdb = new TenantDB(db, invite.tenant_id);
  const vendorLocations = tdb.all<{ location_id: string; status: string }>(
    'SELECT location_id, status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ?',
    [invite.vendor_id]
  );

  return { invite, vendor, vendorLocations };
}

/** Uniform 401 message for all invalid-token states (unknown / expired / revoked). */
export const INVALID_TOKEN_MESSAGE =
  'This link is invalid or has expired. Ask your contact to resend it.';
