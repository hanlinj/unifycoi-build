// Decision service — Admin-only approve/reject/request_correction for vendor locations.
// Per-location status writes (invariant #5). All mutations go through TenantDB.

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { issueInviteToken } from '@/lib/auth/invite-token';
import { logDevInviteUrl } from '@/lib/dev/log-invite-url';
import { notifyTenantAdmins } from '@/lib/notifications/queue';

const CORRECTION_INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_REASONING_LENGTH = 10;

export type DecisionAction = 'approve' | 'reject' | 'request_correction';

export interface DecisionInput {
  db: Db;
  tenantId: string;
  vendorId: string;
  actorUserId: string;
  action: DecisionAction;
  locationIds: string[];        // for approve/reject; ignored for request_correction
  reason?: string | null;
  acceptedUncertaintyIds?: string[];
  deficientRequirements?: string[];  // requirement_keys pre-scoped for request_correction
}

// ── Accept uncertain evaluation ───────────────────────────────────────────────

export interface AcceptEvaluationInput {
  db: Db;
  tenantId: string;
  vendorId: string;
  evaluationId: string;
  actorUserId: string;
  reasoning: string;  // required, minimum length enforced
}

export class AcceptEvaluationError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'NOT_UNCERTAIN' | 'REASONING_REQUIRED'
  ) {
    super(message);
  }
}

export async function acceptUncertainEvaluation(input: AcceptEvaluationInput): Promise<void> {
  const { db, tenantId, vendorId, evaluationId, actorUserId, reasoning } = input;

  if (!reasoning || reasoning.trim().length < MIN_REASONING_LENGTH) {
    throw new AcceptEvaluationError(
      `Reasoning must be at least ${MIN_REASONING_LENGTH} characters`,
      'REASONING_REQUIRED'
    );
  }

  const tdb = new TenantDB(db, tenantId);

  interface EvalRow { id: string; vendor_id: string; requirement_key: string; outcome: string }
  const evaluation = await tdb.get<EvalRow>(
    `SELECT id, vendor_id, requirement_key, outcome FROM requirement_evaluations
     WHERE tenant_id = $1 AND id = $2 AND vendor_id = $3`,
    [evaluationId, vendorId]
  );

  if (!evaluation) throw new AcceptEvaluationError('Evaluation not found', 'NOT_FOUND');
  if (evaluation.outcome !== 'uncertain') {
    throw new AcceptEvaluationError(
      `Evaluation outcome is '${evaluation.outcome}', not 'uncertain'`,
      'NOT_UNCERTAIN'
    );
  }

  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId: actorUserId,
    eventType: 'evaluation.uncertain_accepted',
    targetType: 'vendor',
    targetId: vendorId,
    payload: {
      evaluation_id: evaluationId,
      requirement_key: evaluation.requirement_key,
      reasoning: reasoning.trim(),
    },
  });
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

export async function applyDecision(input: DecisionInput): Promise<DecisionResult> {
  const { db, tenantId, vendorId, actorUserId, action, locationIds, reason, acceptedUncertaintyIds, deficientRequirements } = input;
  const tdb = new TenantDB(db, tenantId);
  const now = new Date();

  interface VendorRow { id: string; business_name: string; contact_email: string | null }
  const vendor = await tdb.get<VendorRow>(
    'SELECT id, business_name, contact_email FROM vendors WHERE tenant_id = $1 AND id = $2',
    [vendorId]
  );
  if (!vendor) throw new DecisionError('Vendor not found', 'NOT_FOUND');

  if (action === 'approve' || action === 'reject') {
    const updated: string[] = [];
    const skipped: string[] = [];

    for (const locId of locationIds) {
      // flags_json is jsonb — Kysely/pg returns it already parsed, never a string to JSON.parse().
      interface VLRow { id: string; location_id: string; status: string; flags_json: Record<string, unknown> | null }
      const vl = await tdb.get<VLRow>(
        'SELECT id, location_id, status, flags_json FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2 AND location_id = $3',
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
        const flags = vl.flags_json ? { ...vl.flags_json } : {};
        delete flags.action_needed;
        const newFlags = Object.keys(flags).length > 0 ? JSON.stringify(flags) : null;

        await tdb.update(
          'vendor_locations',
          { status: 'approved', approved_by: actorUserId, approved_at: now, flags_json: newFlags },
          { vendor_id: vendorId, location_id: locId }
        );

        await logAudit(db, {
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
        await tdb.update(
          'vendor_locations',
          { status: 'declined' },
          { vendor_id: vendorId, location_id: locId }
        );

        await logAudit(db, {
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

    // A hard decline is a terminal decision admins should learn about immediately (it's
    // not a fix-request the vendor can act on, so it isn't vendor-facing). One exception
    // notification per decline, to all admins. (Recipient choice documented in the
    // Phase 7 checkpoint — the spec catalog has no dedicated declined-vendor row.)
    if (action === 'reject' && updated.length > 0) {
      await notifyTenantAdmins(db, tenantId, {
        type: 'vendor_declined',
        vendor_id: vendorId,
        vendor_name: vendor.business_name,
        location_ids: updated,
        ...(reason ? { reason } : {}),
      });
    }

    return { action, updated, skipped };
  }

  // request_correction: scoped to the passed-in locationIds only — same validation approach
  // approve/reject already use (not-found → skipped, wrong status → throws CONFLICT). No
  // longer an implicit "every under-review location" sweep; the caller must name them.
  interface VLRow { id: string; location_id: string; status: string; flags_json: Record<string, unknown> | null }
  const scoped: VLRow[] = [];
  const skipped: string[] = [];

  for (const locId of locationIds) {
    const vl = await tdb.get<VLRow>(
      'SELECT id, location_id, status, flags_json FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2 AND location_id = $3',
      [vendorId, locId]
    );
    if (!vl) { skipped.push(locId); continue; }

    if (vl.status !== 'under_review') {
      throw new DecisionError(
        `Location ${locId} is not in under_review status (current: ${vl.status})`,
        'CONFLICT'
      );
    }
    scoped.push(vl);
  }

  if (scoped.length === 0) {
    throw new DecisionError('No locations in under_review status among the ones provided — cannot request correction', 'NO_UNDER_REVIEW');
  }

  for (const vl of scoped) {
    const flags = vl.flags_json ? { ...vl.flags_json } : {};
    flags.action_needed = true;
    await tdb.update(
      'vendor_locations',
      { status: 'onboarding', flags_json: JSON.stringify(flags) },
      { vendor_id: vendorId, location_id: vl.location_id }
    );
  }

  // Invite/notification: UNCHANGED this stage — still one vendor-level correction invite and
  // one email, regardless of how many locations were scoped (stage three reworks the email
  // itself). Routes through the shared revoke-on-issue choke point (ADR-013-01) — a correction
  // request revokes ANY prior still-live invite for this vendor, regardless of purpose (e.g. a
  // still-outstanding onboarding link becomes invalid the moment a correction is requested),
  // not just prior correction tokens.
  //
  // FLAGGED, NOT FIXED (out of this stage's scope): the vendor's next resubmission goes through
  // fsmTransition(db, tenantId, vendorId, 'submit') (src/lib/services/vendor-fsm.ts), which
  // requires EVERY vendor_locations row for the vendor to be 'onboarding' before allowing the
  // transition — a location left in some other status (e.g. 'approved' from an earlier decision
  // in the same session, or one never scoped into this correction) would make that resubmit
  // throw IllegalTransitionError. This isn't new: today's all-sweep correction can already
  // produce the same mixed approved/onboarding split via a prior partial approve — but scoping
  // correction to a subset makes that the common case rather than an edge case. Left untouched
  // here; needs its own deliberate fix before this feature is usable end-to-end.
  const { rawToken, inviteId, expiresAt } = await issueInviteToken(db, {
    tenantId,
    vendorId,
    inviterUserId: actorUserId,
    purpose: 'correction',
    ttlMs: CORRECTION_INVITE_LIFETIME_MS,
  });
  logDevInviteUrl(rawToken, 'correction request');

  if (vendor.contact_email) {
    await tdb.insert('notifications', {
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
        expires_at: expiresAt.toISOString(),
        ...(reason ? { reason } : {}),
        ...(deficientRequirements?.length ? { deficient_requirements: deficientRequirements } : {}),
      }),
      created_at: now,
    });
  }

  // Per-location audit — one vendor.correction_requested event per affected location (same
  // shape approve/reject already emit: location_id in the payload), replacing the single
  // count-only event. deficient_requirements is a requirement_key list, not location-specific,
  // so it rides identically on every event for this batch, same as reason.
  for (const vl of scoped) {
    await logAudit(db, {
      tenantId,
      actorType: 'user',
      actorId: actorUserId,
      eventType: 'vendor.correction_requested',
      targetType: 'vendor',
      targetId: vendorId,
      payload: {
        location_id: vl.location_id,
        invite_id: inviteId,
        ...(reason ? { reason } : {}),
        ...(deficientRequirements?.length ? { deficient_requirements: deficientRequirements } : {}),
      },
    });
  }

  return {
    action: 'request_correction',
    inviteId,
    locationsTransitioned: scoped.map((vl) => vl.location_id),
    skipped,
  };
}
