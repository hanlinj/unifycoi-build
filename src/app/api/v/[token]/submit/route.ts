// POST /api/v/:token/submit
// Vendor submit — validates all required docs are uploaded, transitions the FSM
// (onboarding → under_review), then queues background verification (extraction + the
// verification run) instead of running it inline. The vendor gets an immediate response and
// never waits on Vision — see src/lib/verification/worker.ts for the background pipeline.
// Token lookup is always by SHA-256 hash of the raw bearer token.

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import { fsmTransition, IllegalTransitionError } from '@/lib/services/vendor-fsm';
import { logAudit } from '@/lib/audit';

interface VendorRow { id: string; business_name: string; trade: string }
interface DocRow { doc_type: string }

const REQUIRED_DOC_TYPES = ['coi', 'w9', 'ach'] as const;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getDb();
  const validated = await validateInviteToken(db, params.token);

  if (!validated) {
    return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 401 });
  }

  const { invite } = validated;
  const tenantId = invite.tenant_id;
  const vendorId = invite.vendor_id;
  const tdb = new TenantDB(db, tenantId);

  const vendor = await tdb.get<VendorRow>(
    'SELECT id, business_name, trade FROM vendors WHERE tenant_id = $1 AND id = $2',
    [vendorId]
  );
  if (!vendor) {
    return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
  }

  // Require all three doc types to be present and active before allowing submit
  const activeDocs = await tdb.all<DocRow>(
    `SELECT DISTINCT doc_type FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND state = 'active' AND superseded_by IS NULL`,
    [vendorId]
  );
  const uploadedTypes = new Set(activeDocs.map((d) => d.doc_type));
  const missing = REQUIRED_DOC_TYPES.filter((t) => !uploadedTypes.has(t));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Upload all required documents before submitting', missing },
      { status: 422 }
    );
  }

  // FSM: onboarding → under_review, partial mode — only 'onboarding' rows advance.
  // 'approved'/'declined' rows (from an earlier partial decision, before a correction request
  // reset just the still-under-review locations back to 'onboarding') are left untouched, not
  // re-evaluated. IllegalTransitionError here means zero rows were 'onboarding' — nothing to
  // submit — return 409.
  try {
    await fsmTransition(db, tenantId, vendorId, 'submit', { partial: true });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return NextResponse.json({ error: 'Already submitted' }, { status: 409 });
    }
    throw err;
  }

  const trigger =
    invite.purpose === 'renewal'    ? 'renewal'
    : invite.purpose === 'correction' ? 'resubmission'
    : 'onboarding';

  // Queue background verification (src/lib/verification/worker.ts) instead of running inline —
  // extraction + runVerification() happen after this request returns. The vendor profile shows
  // "Verification in progress" until a verification_runs row exists (src/app/api/vendors/[id]/route.ts).
  const jobId = randomUUID();
  await tdb.insert('verification_jobs', {
    id: jobId,
    vendor_id: vendorId,
    trigger,
    status: 'queued',
    created_at: new Date(),
  });

  // Notify the Admin who sent the invite. Per Notifications_and_Communications.md catalog
  // ("Vendor ready for review → Admin → Digest"), this is ROUTINE throughput, batched into
  // the daily digest — not an immediate exception. Fires at submit (not run-completion): the
  // rendered copy ("submitted documents and is awaiting your review") is accurate the moment
  // the vendor submits, regardless of whether the background run has finished yet.
  const now = new Date();
  await tdb.insert('notifications', {
    id: randomUUID(),
    recipient_type: 'user',
    recipient_ref: invite.inviter_user_id,
    channel: 'email',
    kind: 'digest',
    status: 'queued',
    scheduled_for: null,
    sent_at: null,
    payload_json: JSON.stringify({
      type: 'vendor_submitted',
      vendor_id: vendorId,
      vendor_name: vendor.business_name,
      trade: vendor.trade,
    }),
    created_at: now,
  });

  await logAudit(db, {
    tenantId,
    actorType: 'vendor',
    actorId: vendorId,
    eventType: 'vendor.submitted',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { invite_id: invite.id, verification_job_id: jobId },
  });

  return NextResponse.json({ data: { status: 'received', job_id: jobId } }, { status: 202 });
}
