import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { withTransaction } from '@/lib/db/transaction';
import { logAudit } from '@/lib/audit';
import { issueInviteToken } from '@/lib/auth/invite-token';
import { logDevInviteUrl } from '@/lib/dev/log-invite-url';

// Single shared trade enum (see src/lib/trades.ts) — re-exported for existing importers.
export { VALID_TRADES } from '@/lib/trades';
export type { Trade } from '@/lib/trades';

export interface CreateInviteInput {
  businessName: string;
  contactFirstName: string;
  contactLastName: string;
  contactTitle?: string;
  email: string;
  companyPhone: string;
  contactCellPhone?: string;
  trade: string;
  locationIds: string[];
  customNotes?: string;
  inviterUserId: string;
}

export interface InviteCreated {
  type: 'created';
  vendorId: string;
  inviteId: string;
  tokenExpiresAt: string;
  deliveryState: 'sent';
}

export interface InviteDuplicate {
  type: 'duplicate';
  existingVendorId: string;
  existingBusinessName: string;
}

export type CreateInviteResult = InviteCreated | InviteDuplicate;

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export async function createVendorInvite(
  db: Db,
  tenantId: string,
  input: CreateInviteInput
): Promise<CreateInviteResult> {
  const tdb = new TenantDB(db, tenantId);

  // Duplicate check: same email already exists for this tenant
  // COLLATE NOCASE -> lower() (Stage 0's catalogued rework spot)
  const existing = await tdb.get<{ id: string; business_name: string }>(
    'SELECT id, business_name FROM vendors WHERE tenant_id = $1 AND lower(contact_email) = lower($2)',
    [input.email]
  );
  if (existing) {
    return { type: 'duplicate', existingVendorId: existing.id, existingBusinessName: existing.business_name };
  }

  // Location validation: all must exist and be active within this tenant
  for (const locId of input.locationIds) {
    const loc = await tdb.get<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
      [locId]
    );
    if (!loc) {
      const err = new Error(`Location not found or not active: ${locId}`);
      (err as NodeJS.ErrnoException & { status: number }).status = 400;
      throw err;
    }
  }

  const vendorId = randomUUID();
  const now = new Date();

  return withTransaction(db, async (trx) => {
    const txTdb = new TenantDB(trx, tenantId);

    await txTdb.insert('vendors', {
      id: vendorId,
      business_name: input.businessName,
      contact_name: `${input.contactFirstName} ${input.contactLastName}`.trim(),
      contact_email: input.email,
      contact_phone: input.companyPhone,
      trade: input.trade,
      created_at: now,
    });

    // Routes through the shared revoke-on-issue choke point (ADR-013-01) — a brand-new
    // vendor has no prior invites to revoke, so this is a harmless no-op UPDATE here, but
    // every mint site uses the same path uniformly; none writes `invites` directly.
    const { rawToken, inviteId, expiresAt } = await issueInviteToken(trx, {
      tenantId,
      vendorId,
      inviterUserId: input.inviterUserId,
      purpose: 'onboarding',
      ttlMs: INVITE_LIFETIME_MS,
    });
    logDevInviteUrl(rawToken, `onboarding invite · ${input.businessName}`);

    for (const locationId of input.locationIds) {
      await txTdb.insert('vendor_locations', {
        id: randomUUID(),
        vendor_id: vendorId,
        location_id: locationId,
        status: 'invited_pending',
        flags_json: null,
        approved_by: null,
        approved_at: null,
        created_at: now,
      });
    }

    // Tradeoff note: raw token appears here so the email sender can construct the URL.
    // The notifications table is a short-lived operational queue (not the enumeration
    // attack surface that the invites.token hash protects against).
    await txTdb.insert('notifications', {
      id: randomUUID(),
      recipient_type: 'vendor',
      recipient_ref: input.email,
      channel: 'email',
      kind: 'exception',
      status: 'queued',
      scheduled_for: null,
      sent_at: null,
      payload_json: JSON.stringify({
        type: 'vendor_invite',
        business_name: input.businessName,
        contact_first_name: input.contactFirstName,
        invite_path: `/v/${rawToken}`,
        expires_at: expiresAt.toISOString(),
        custom_notes: input.customNotes ?? null,
      }),
      created_at: now,
    });

    await logAudit(trx, {
      tenantId,
      actorType: 'user',
      actorId: input.inviterUserId,
      eventType: 'vendor.invited',
      targetType: 'vendor',
      targetId: vendorId,
      payload: {
        invite_id: inviteId,
        business_name: input.businessName,
        trade: input.trade,
        location_count: input.locationIds.length,
      },
    });

    return {
      type: 'created',
      vendorId,
      inviteId,
      tokenExpiresAt: expiresAt.toISOString(),
      deliveryState: 'sent',
    } satisfies InviteCreated;
  });
}
