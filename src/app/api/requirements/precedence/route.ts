import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { setPrecedence } from '@/lib/services/requirements';
import type { Precedence } from '@/lib/services/requirements';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_POLICIES: Precedence[] = ['strictest', 'location', 'trade'];

export async function PUT(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const { policy, reason } = body as Record<string, unknown>;
  if (!policy || !VALID_POLICIES.includes(policy as Precedence)) {
    return badRequest(`policy must be one of: ${VALID_POLICIES.join(', ')}`);
  }
  // A precedence change is a requirement change → reason required (audit invariant #10).
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    return badRequest('reason is required (min 10 characters) for a precedence change');
  }

  const db = getRawDb();
  setPrecedence(db, auth.tenantId, policy as Precedence, auth.sub, reason.trim());
  return ok({ policy });
}
