// GET /api/v/:token
// Returns the current vendor onboarding flow state.
// Fires the open_link FSM transition (invited_pending → onboarding) on the first valid request.
// Token lookup is always by SHA-256 hash — the raw bearer token is never stored.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import { fireOnboardingStarted } from '@/lib/services/vendor-onboarding';

// Required document types: COI, W-9, and ACH are the platform floor for v1.
// All three are always required; future per-trade overrides will come from the resolver.
const REQUIRED_DOC_TYPES = ['coi', 'w9', 'ach'] as const;

interface DocumentRow {
  id: string;
  doc_type: string;
  uploaded_at: string;
}

interface RunRow {
  id: string;
  recommendation: string;
  created_at: string;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const db = getDb();
  const validated = await validateInviteToken(db, params.token);

  if (!validated) {
    return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 401 });
  }

  const { invite, vendor, vendorLocations } = validated;

  // Fire open_link (Invited/Pending → Onboarding) + audit on the vendor's first access.
  // Idempotent — see fireOnboardingStarted.
  await fireOnboardingStarted(db, {
    tenantId: invite.tenant_id,
    vendorId: invite.vendor_id,
    inviteId: invite.id,
    purpose: invite.purpose,
    vendorLocations,
  });

  const tdb = new TenantDB(db, invite.tenant_id);

  const documents = await tdb.all<DocumentRow>(
    `SELECT id, doc_type, uploaded_at
     FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND superseded_by IS NULL AND state = 'active'
     ORDER BY uploaded_at ASC`,
    [invite.vendor_id]
  );

  const latestRun = await tdb.get<RunRow>(
    `SELECT id, recommendation, created_at
     FROM verification_runs
     WHERE tenant_id = $1 AND vendor_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [invite.vendor_id]
  );

  const uploadedTypes = new Set(documents.map((d) => d.doc_type));
  const allUploaded = REQUIRED_DOC_TYPES.every((t) => uploadedTypes.has(t));

  const flowState = latestRun
    ? 'submitted'
    : allUploaded
      ? 'ready_to_submit'
      : documents.length > 0
        ? 'uploading'
        : 'awaiting_upload';

  return NextResponse.json({
    data: {
      invite: {
        id: invite.id,
        purpose: invite.purpose,
        expires_at: invite.token_expires_at,
      },
      vendor: {
        business_name: vendor.business_name,
        trade: vendor.trade,
      },
      required_docs: REQUIRED_DOC_TYPES,
      uploaded_docs: documents.map((d) => ({
        id: d.id,
        doc_type: d.doc_type,
        uploaded_at: d.uploaded_at,
      })),
      flow_state: flowState,
      verification: latestRun
        ? { run_id: latestRun.id, recommendation: latestRun.recommendation }
        : null,
    },
  });
}
