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

  const b = body as Record<string, unknown>;
  const action = typeof b.action === 'string' ? b.action : '';
  const locationIds: string[] = Array.isArray(b.location_ids) ? (b.location_ids as string[]) : [];
  const reason = typeof b.reason === 'string' ? b.reason.trim() : null;
  const acceptedUncertaintyIds: string[] = Array.isArray(b.accepted_uncertainty_ids)
    ? (b.accepted_uncertainty_ids as string[])
    : [];

  if (!['approve', 'reject', 'request_correction'].includes(action)) {
    return badRequest('action must be approve | reject | request_correction');
  }

  // location_ids is now required for every action, including request_correction — it no
  // longer means "every under-review location" implicitly; the caller must name them.
  if (locationIds.length === 0) {
    return badRequest('location_ids required');
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
