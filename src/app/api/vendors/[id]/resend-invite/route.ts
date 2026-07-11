// POST /api/vendors/:id/resend-invite
// Re-issue an onboarding invite for an existing vendor (bounced/expired invite recovery).
// Any tenant role may invite, but is scope-clamped: the actor must have at least one of the
// vendor's locations in scope (mirrors POST /api/vendors/invite).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound, badRequest } from '@/lib/api';
import { resolveScope, scopeIncludesLocation } from '@/lib/scope';
import { resendInvite, ResendInviteError } from '@/lib/services/resend-invite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const db = getDb();
  const tdb = new TenantDB(db, auth.tenantId);

  // Scope check: the vendor must touch at least one in-scope location.
  const locs = await tdb.all<{ location_id: string }>(
    'SELECT location_id FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2',
    [params.id]
  );
  if (locs.length === 0) return notFound('Vendor not found');
  const scope = await resolveScope(db, auth.tenantId, auth.sub, auth.role);
  const inScope = locs.some((l) => scopeIncludesLocation(scope, l.location_id));
  if (!inScope) return forbidden();

  try {
    const result = await resendInvite(db, auth.tenantId, params.id, auth.sub);
    return NextResponse.json({ data: { invite_id: result.inviteId, token_expires_at: result.tokenExpiresAt } });
  } catch (err) {
    if (err instanceof ResendInviteError) {
      if (err.code === 'NOT_FOUND') return notFound(err.message);
      if (err.code === 'NO_EMAIL') return badRequest(err.message);
    }
    throw err;
  }
}
