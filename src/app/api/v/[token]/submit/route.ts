// POST /api/v/:token/submit
// Vendor submit — validates all required docs are uploaded, transitions the FSM
// (onboarding → under_review), then runs the verification engine.
// Token lookup is always by SHA-256 hash of the raw bearer token.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import { fsmTransition, IllegalTransitionError } from '@/lib/services/vendor-fsm';
import { runVerification } from '@/lib/verification/run';

interface VendorRow { id: string; trade: string }
interface DocRow { doc_type: string }

const REQUIRED_DOC_TYPES = ['coi', 'w9', 'ach'] as const;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getRawDb();
  const validated = validateInviteToken(db, params.token);

  if (!validated) {
    return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 401 });
  }

  const { invite } = validated;
  const tenantId = invite.tenant_id;
  const vendorId = invite.vendor_id;
  const tdb = new TenantDB(db, tenantId);

  const vendor = tdb.get<VendorRow>(
    'SELECT id, trade FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );
  if (!vendor) {
    return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
  }

  // Require all three doc types to be present and active before allowing submit
  const activeDocs = tdb.all<DocRow>(
    `SELECT DISTINCT doc_type FROM documents
     WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
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

  // FSM: onboarding → under_review
  // IllegalTransitionError means vendor already submitted (or wrong state) — return 409
  try {
    fsmTransition(db, tenantId, vendorId, 'submit');
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

  try {
    const result = await runVerification(db, { tenantId, vendorId, vendorTrade: vendor.trade, trigger });
    return NextResponse.json({
      data: {
        run_id: result.runId,
        recommendation: result.recommendation,
        evaluation_count: result.evaluationCount,
        advisory_count: result.advisoryCount,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Verification run failed', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
