// Decision service — Admin-only approve/reject/request_correction for vendor locations.
// Per-location status writes (invariant #5). All mutations go through TenantDB.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { generateInviteToken } from '@/lib/auth/invite-token';

const CORRECTION_INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export type DecisionAction = 'approve' | 'reject' | 'request_correction';

export interface DecisionInput {
  db: Database.Database;
  tenantId: string;
  vendorId: string;
  actorUserId: string;
  action: DecisionAction;
  locationIds: string[];        // for approve/reject; ignored for request_correction
  reason?: string | null;
  acceptedUncertaintyIds?: string[];
}

export interface DecisionResult {
  action: DecisionAction;
  updated?: string[];
  skipped?: string[];
  inviteId?: string;
  locationsTransitioned?: string[];
}

export class DecisionError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'CONFLICT' | 'NO_UNDER_REVIEW'
  ) {
    super(message);
  }
}

export function applyDecision(input: DecisionInput): DecisionResult {
  const { db, tenantId, vendorId, actorUserId, action, locationIds, reason, acceptedUncertaintyIds } = input;
  const tdb = new TenantDB(db, tenantId);
  const now = new Date().toISOString();

  interface VendorRow { id: string; business_name: string; contact_email: string | null }
  const vendor = tdb.get<VendorRow>(
    'SELECT id, business_name, contact_email FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  if (!vendor) throw new DecisionError('Vendor not found', 'NOT_FOUND');

  if (action === 'approve' || action === 'reject') {
    const updated: string[] = [];
    const skipped: string[] = [];

    for (const locId of locationIds) {
      interface VLRow { id: string; location_id: string; status: string; flags_json: string | null }
      const vl = tdb.get<VLRow>(
        'SELECT id, location_id, status, flags_json FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ? AND location_id = ?',
        [vendorId, locId]
      );
      if (!vl) { skipped.push(locId); continue; }

      if (vl.status !== 'under_review') {
        throw new DecisionError(
          `Location ${locId} is not in under_review status (current: ${vl.status})`,
          'CONFLICT'
        );
      }

      if (action === 'approve') {
        const flags = vl.flags_json ? JSON.parse(vl.flags_json) : {};
        delete flags.action_needed;
        const newFlags = Object.keys(flags).length > 0 ? JSON.stringify(flags) : null;

        tdb.update(
          'vendor_locations',
          { status: 'approved', approved_by: actorUserId, approved_at: now, flags_json: newFlags },
          { vendor_id: vendorId, location_id: locId }
        );

        logAudit(db, {
          tenantId,
          actorType: 'user',
          actorId: actorUserId,
          eventType: 'vendor.approved',
          targetType: 'vendor',
          targetId: vendorId,
          payload: {
            location_id: locId,
            ...(acceptedUncertaintyIds?.length ? { accepted_uncertainty_ids: acceptedUncertaintyIds } : {}),
            ...(reason ? { reason } : {}),
          },
        });
      } else {
        tdb.update(
          'vendor_locations',
          { status: 'declined' },
          { vendor_id: vendorId, location_id: locId }
        );

        logAudit(db, {
          tenantId,
          actorType: 'user',
          actorId: actorUserId,
          eventType: 'vendor.declined',
          targetType: 'vendor',
          targetId: vendorId,
          payload: { location_id: locId, ...(reason ? { reason } : {}) },
        });
      }

      updated.push(locId);
    }

    return { action, updated, skipped };
  }

  // request_correction: ALL under_review locations → onboarding + action_needed flag
  interface VLRow { id: string; location_id: string; status: string; flags_json: string | null }
  const underReview = tdb.all<VLRow>(
    `SELECT id, location_id, status, flags_json FROM vendor_locations
     WHERE tenant_id = ? AND vendor_id = ? AND status = 'under_review'`,
    [vendorId]
  );

  if (underReview.length === 0) {
    throw new DecisionError('No locations in under_review status — cannot request correction', 'NO_UNDER_REVIEW');
  }

  for (const vl of underReview) {
    const flags = vl.flags_json ? JSON.parse(vl.flags_json) : {};
    flags.action_needed = true;
    tdb.update(
      'vendor_locations',
      { status: 'onboarding', flags_json: JSON.stringify(flags) },
      { vendor_id: vendorId, location_id: vl.location_id }
    );
  }

  const { rawToken, tokenHash } = generateInviteToken();
  const inviteId = randomUUID();
  const expiresAt = new Date(Date.now() + CORRECTION_INVITE_LIFETIME_MS).toISOString();

  tdb.insert('invites', {
    id: inviteId,
    vendor_id: vendorId,
    inviter_user_id: actorUserId,
    token: tokenHash,
    token_expires_at: expiresAt,
    purpose: 'correction',
    delivery_state: 'sent',
    created_at: now,
  });

  if (vendor.contact_email) {
    tdb.insert('notifications', {
      id: randomUUID(),
      recipient_type: 'vendor',
      recipient_ref: vendor.contact_email,
      channel: 'email',
      kind: 'exception',
      status: 'queued',
      scheduled_for: null,
      sent_at: null,
      payload_json: JSON.stringify({
        type: 'correction_requested',
        vendor_id: vendorId,
        vendor_name: vendor.business_name,
        invite_path: `/v/${rawToken}`,
        expires_at: expiresAt,
        ...(reason ? { reason } : {}),
      }),
      created_at: now,
    });
  }

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId: actorUserId,
    eventType: 'vendor.correction_requested',
    targetType: 'vendor',
    targetId: vendorId,
    payload: {
      invite_id: inviteId,
      location_count: underReview.length,
      ...(reason ? { reason } : {}),
    },
  });

  return {
    action: 'request_correction',
    inviteId,
    locationsTransitioned: underReview.map((vl) => vl.location_id),
  };
}
