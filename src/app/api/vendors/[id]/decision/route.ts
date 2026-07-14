// POST /api/vendors/:id/decision
// Admin-only. Three actions: approve | reject | request_correction.
// Delegates to applyDecision() service for testable business logic.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, notFound, conflict } from '@/lib/api';
import { applyDecision, DecisionError } from '@/lib/services/decision';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  // Only Admin can approve, reject, or request correction (invariant #4)
  if (auth.role !== 'admin') return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body required');
  }

  const ALLOWED_DOC_TYPES = ['coi', 'w9', 'ach'];

  const b = body as Record<string, unknown>;
  const action = typeof b.action === 'string' ? b.action : '';
  const locationIds: string[] = Array.isArray(b.location_ids) ? (b.location_ids as string[]) : [];
  const reason = typeof b.reason === 'string' ? b.reason.trim() : null;
  const acceptedUncertaintyIds: string[] = Array.isArray(b.accepted_uncertainty_ids)
    ? (b.accepted_uncertainty_ids as string[])
    : [];
  const docTypes: string[] = Array.isArray(b.doc_types) ? (b.doc_types as string[]) : [];

  if (!['approve', 'reject', 'request_correction'].includes(action)) {
    return badRequest('action must be approve | reject | request_correction');
  }

  // location_ids is required for approve/reject (caller names the locations). request_correction
  // is vendor-level — it sweeps every under_review location itself — so it doesn't need them.
  if ((action === 'approve' || action === 'reject') && locationIds.length === 0) {
    return badRequest('location_ids required');
  }

  // doc_types is required for request_correction — the "Request more info" panel always names
  // at least one document (the admin picks which ones need replacement).
  if (action === 'request_correction') {
    if (docTypes.length === 0) return badRequest('doc_types required');
    const invalid = docTypes.filter((t) => !ALLOWED_DOC_TYPES.includes(t));
    if (invalid.length > 0) return badRequest(`invalid doc_types: ${invalid.join(', ')}`);
  }

  try {
    const result = await applyDecision({
      db: getDb(),
      tenantId: auth.tenantId,
      vendorId: params.id,
      actorUserId: auth.sub,
      action: action as 'approve' | 'reject' | 'request_correction',
      locationIds,
      reason,
      acceptedUncertaintyIds,
      docTypes,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof DecisionError) {
      if (err.code === 'NOT_FOUND') return notFound(err.message);
      if (err.code === 'CONFLICT') return conflict(err.message);
      if (err.code === 'NO_UNDER_REVIEW') return conflict(err.message);
    }
    throw err;
  }
}
