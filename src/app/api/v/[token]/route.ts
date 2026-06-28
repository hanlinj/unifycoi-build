// GET /api/v/:token
// Returns the current vendor onboarding flow state (tokenized — no login required).
// Vendors use this to resume a save-and-resume session or see submission status.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';

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
  business_name: string;
  trade: string;
}

interface DocumentRow {
  id: string;
  doc_type: string;
  state: string;
  uploaded_at: string;
}

interface RunRow {
  id: string;
  recommendation: string;
  created_at: string;
}

export async function GET(
  _request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getRawDb();
  const { token } = params;

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
  if (invite.delivery_state === 'bounced' || invite.delivery_state === 'expired_invite') {
    return NextResponse.json({ error: 'Invite no longer valid' }, { status: 401 });
  }

  const { tenant_id: tenantId, vendor_id: vendorId } = invite;

  const vendor = db
    .prepare('SELECT id, business_name, trade FROM vendors WHERE tenant_id = ? AND id = ?')
    .get(tenantId, vendorId) as VendorRow | undefined;

  if (!vendor) {
    return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
  }

  // Documents: all non-superseded docs for this vendor
  const documents = db
    .prepare(
      `SELECT id, doc_type, state, uploaded_at
       FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND superseded_by IS NULL
       ORDER BY uploaded_at ASC`
    )
    .all(tenantId, vendorId) as DocumentRow[];

  // Latest verification run (if any)
  const latestRun = db
    .prepare(
      `SELECT id, recommendation, created_at
       FROM verification_runs
       WHERE tenant_id = ? AND vendor_id = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(tenantId, vendorId) as RunRow | undefined;

  const flowState = latestRun
    ? 'submitted'
    : documents.length > 0
      ? 'uploading'
      : 'awaiting_upload';

  return NextResponse.json({
    data: {
      invite: {
        purpose: invite.purpose,
        vendor_id: vendorId,
        expires_at: invite.token_expires_at,
        delivery_state: invite.delivery_state,
      },
      vendor: {
        business_name: vendor.business_name,
        trade: vendor.trade,
      },
      documents: documents.map((d) => ({
        id: d.id,
        doc_type: d.doc_type,
        state: d.state,
        uploaded_at: d.uploaded_at,
      })),
      verification: latestRun
        ? { run_id: latestRun.id, recommendation: latestRun.recommendation, created_at: latestRun.created_at }
        : null,
      flow_state: flowState,
    },
  });
}
