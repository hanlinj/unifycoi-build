// POST /api/vendors/:id/evaluations/:evalId/accept
// Admin-only. Accepts an uncertain requirement evaluation as satisfied for approval.
// This is the human-in-control checkpoint (MISSION #4): an AI "uncertain" finding is
// resolved by an Admin with required written reasoning, logged to the audit trail.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, forbidden, badRequest, notFound, conflict } from '@/lib/api';
import { acceptUncertainEvaluation, AcceptEvaluationError } from '@/lib/services/decision';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string; evalId: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  // Only Admin can accept an uncertain finding (invariant #4)
  if (auth.role !== 'admin') return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body required');
  }

  const b = body as Record<string, unknown>;
  const reasoning = typeof b.reasoning === 'string' ? b.reasoning : '';

  try {
    await acceptUncertainEvaluation({
      db: getDb(),
      tenantId: auth.tenantId,
      vendorId: params.id,
      evaluationId: params.evalId,
      actorUserId: auth.sub,
      reasoning,
    });
    return NextResponse.json({ data: { accepted: true, evaluation_id: params.evalId } });
  } catch (err) {
    if (err instanceof AcceptEvaluationError) {
      if (err.code === 'NOT_FOUND') return notFound(err.message);
      if (err.code === 'REASONING_REQUIRED') return badRequest(err.message);
      if (err.code === 'NOT_UNCERTAIN') return conflict(err.message);
    }
    throw err;
  }
}
