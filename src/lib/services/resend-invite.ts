// Resend a vendor invite — issues a fresh onboarding token for an EXISTING vendor (e.g. after
// a bounce or an expired invite) and re-queues the branded invite email. Distinct from
// createVendorInvite (which creates a new vendor); this reuses the vendor record.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { issueInviteToken } from '@/lib/auth/invite-token';
import { logDevInviteUrl } from '@/lib/dev/log-invite-url';
import { queueNotification } from '@/lib/notifications/queue';
import { logAudit } from '@/lib/audit';

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export class ResendInviteError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'NO_EMAIL') {
    super(message);
  }
}

export interface ResendResult {
  inviteId: string;
  tokenExpiresAt: string;
}

export async function resendInvite(
  db: Db,
  tenantId: string,
  vendorId: string,
  actorUserId: string
): Promise<ResendResult> {
  const tdb = new TenantDB(db, tenantId);
  const vendor = await tdb.get<{ id: string; business_name: string; contact_email: string | null; contact_name: string | null }>(
    'SELECT id, business_name, contact_email, contact_name FROM vendors WHERE tenant_id = $1 AND id = $2',
    [vendorId]
  );
  if (!vendor) throw new ResendInviteError('Vendor not found', 'NOT_FOUND');
  if (!vendor.contact_email) throw new ResendInviteError('Vendor has no contact email to resend to', 'NO_EMAIL');

  // Routes through the shared revoke-on-issue choke point (ADR-013-01) — this is the mint
  // site the revocation invariant matters most for: a resend is precisely when a prior
  // still-live token (e.g. one that bounced) should stop being usable.
  const { rawToken, inviteId, expiresAt } = await issueInviteToken(db, {
    tenantId,
    vendorId,
    inviterUserId: actorUserId,
    purpose: 'onboarding',
    ttlMs: INVITE_LIFETIME_MS,
  });
  logDevInviteUrl(rawToken, `resent onboarding invite · ${vendor.business_name ?? 'vendor'}`);

  await queueNotification(db, tenantId, {
    recipientType: 'vendor',
    recipientRef: vendor.contact_email,
    kind: 'exception', // vendor-facing onboarding link — immediate
    payload: {
      type: 'vendor_invite',
      business_name: vendor.business_name,
      contact_name: vendor.contact_name,
      invite_path: `/v/${rawToken}`,
      expires_at: expiresAt.toISOString(),
      resent: true,
    },
  });

  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId: actorUserId,
    eventType: 'vendor.invite_resent',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { invite_id: inviteId },
  });

  return { inviteId, tokenExpiresAt: expiresAt.toISOString() };
}
