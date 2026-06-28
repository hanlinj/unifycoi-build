// POST /api/v/:token/submit
// Vendor submit endpoint — enqueues a verification run.
// For v1: runs synchronously in-process (no external queue).
//
// Vendor hits this after uploading all required documents via /documents.
// Returns immediately with the run result (recommendation + any evaluations).

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { runVerification } from '@/lib/verification/run';

interface InviteRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  token_expires_at: string;
  purpose: string;
  delivery_state: string;
}

interface VendorRow {
  id: string;
  trade: string;
}

export async function POST(
  _request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getRawDb();
  const { token } = params;

  // Validate vendor invite token
  const invite = db
    .prepare(
      `SELECT id, tenant_id, vendor_id, token_expires_at, purpose, delivery_state
       FROM invites WHERE token = ?`
    )
    .get(token) as InviteRow | undefined;

  if (!invite) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }
  if (new Date(invite.token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'Token has expired' }, { status: 401 });
  }

  const tenantId = invite.tenant_id;
  const vendorId = invite.vendor_id;
  const tdb = new TenantDB(db, tenantId);

  // Load vendor trade
  const vendor = tdb.get<VendorRow>(
    'SELECT id, trade FROM vendors WHERE tenant_id = ? AND id = ?',
    [vendorId]
  );

  if (!vendor) {
    return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
  }

  const trigger = invite.purpose === 'renewal' ? 'renewal'
    : invite.purpose === 'correction' ? 'resubmission'
    : 'onboarding';

  try {
    const result = await runVerification(db, {
      tenantId,
      vendorId,
      vendorTrade: vendor.trade,
      trigger,
    });

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
