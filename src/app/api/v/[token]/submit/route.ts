// POST /api/v/:token/submit
// Vendor submit — transitions vendor to Under Review and enqueues a verification run.
// Token lookup is always by SHA-256 hash of the raw bearer token.
// Submission and engine wiring are completed in Slice C.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import { runVerification } from '@/lib/verification/run';

interface VendorRow { id: string; trade: string }

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

  const trigger =
    invite.purpose === 'renewal' ? 'renewal'
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
