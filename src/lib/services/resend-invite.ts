// Resend a vendor invite — issues a fresh onboarding token for an EXISTING vendor (e.g. after
// a bounce or an expired invite) and re-queues the branded invite email. Distinct from
// createVendorInvite (which creates a new vendor); this reuses the vendor record.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { generateInviteToken } from '@/lib/auth/invite-token';
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

export function resendInvite(
  db: Database.Database,
  tenantId: string,
  vendorId: string,
  actorUserId: string
): ResendResult {
  const tdb = new TenantDB(db, tenantId);
  const vendor = tdb.get<{ id: string; business_name: string; contact_email: string | null; contact_name: string | null }>(
    'SELECT id, business_name, contact_email, contact_name FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  if (!vendor) throw new ResendInviteError('Vendor not found', 'NOT_FOUND');
  if (!vendor.contact_email) throw new ResendInviteError('Vendor has no contact email to resend to', 'NO_EMAIL');

  const { rawToken, tokenHash } = generateInviteToken();
  logDevInviteUrl(rawToken, `resent onboarding invite · ${vendor.business_name ?? 'vendor'}`);
  const inviteId = randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();

  tdb.insert('invites', {
    id: inviteId,
    vendor_id: vendorId,
    inviter_user_id: actorUserId,
    token: tokenHash,
    token_expires_at: expiresAt,
    purpose: 'onboarding',
    delivery_state: 'sent',
    created_at: now,
  });

  queueNotification(db, tenantId, {
    recipientType: 'vendor',
    recipientRef: vendor.contact_email,
    kind: 'exception', // vendor-facing onboarding link — immediate
    payload: {
      type: 'vendor_invite',
      business_name: vendor.business_name,
      contact_name: vendor.contact_name,
      invite_path: `/v/${rawToken}`,
      expires_at: expiresAt,
      resent: true,
    },
  });

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId: actorUserId,
    eventType: 'vendor.invite_resent',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { invite_id: inviteId },
  });

  return { inviteId, tokenExpiresAt: expiresAt };
}
