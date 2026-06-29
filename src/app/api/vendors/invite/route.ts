// POST /api/vendors/invite
// Creates a vendor record, issues a hashed invite token, and queues the onboarding email.
// Accessible to all tenant user roles (Admin, District Manager, Store Manager).
// Store/District callers are scoped to locations they're authorized for.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { requireTenantAuth, isResponse, created, badRequest, forbidden, conflict } from '@/lib/api';
import { resolveScope, scopeIncludesLocation } from '@/lib/scope';
import { createVendorInvite, VALID_TRADES } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const b = body as Record<string, unknown>;
  const businessName = typeof b.businessName === 'string' ? b.businessName.trim() : '';
  const contactFirstName = typeof b.contactFirstName === 'string' ? b.contactFirstName.trim() : '';
  const contactLastName = typeof b.contactLastName === 'string' ? b.contactLastName.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const companyPhone = typeof b.companyPhone === 'string' ? b.companyPhone.trim() : '';
  const trade = typeof b.trade === 'string' ? b.trade.trim() : '';
  const locationIds = Array.isArray(b.locationIds) ? b.locationIds : [];

  if (!businessName) return badRequest('businessName is required');
  if (!contactFirstName) return badRequest('contactFirstName is required');
  if (!contactLastName) return badRequest('contactLastName is required');
  if (!email) return badRequest('email is required');
  if (!companyPhone) return badRequest('companyPhone is required');
  if (!(VALID_TRADES as readonly string[]).includes(trade)) {
    return badRequest(`trade must be one of: ${VALID_TRADES.join(', ')}`);
  }
  if (locationIds.length === 0) return badRequest('locationIds must contain at least one location');
  if (!locationIds.every((id) => typeof id === 'string')) {
    return badRequest('locationIds must be an array of strings');
  }

  const db = getRawDb();
  const scope = resolveScope(db, auth.tenantId, auth.sub, auth.role);

  for (const locId of locationIds as string[]) {
    if (!scopeIncludesLocation(scope, locId)) {
      return forbidden();
    }
  }

  try {
    const result = createVendorInvite(db, auth.tenantId, {
      businessName,
      contactFirstName,
      contactLastName,
      contactTitle: typeof b.contactTitle === 'string' ? b.contactTitle.trim() : undefined,
      email,
      companyPhone,
      contactCellPhone: typeof b.contactCellPhone === 'string' ? b.contactCellPhone.trim() : undefined,
      trade,
      locationIds: locationIds as string[],
      customNotes: typeof b.customNotes === 'string' ? b.customNotes.trim() : undefined,
      inviterUserId: auth.sub,
    });

    if (result.type === 'duplicate') {
      return conflict(
        `A vendor with this email already exists in your organization (id: ${result.existingVendorId}). ` +
        `Use POST /api/vendors/${result.existingVendorId}/locations to add locations instead.`
      );
    }

    return created({
      vendor_id: result.vendorId,
      invite_id: result.inviteId,
      expires_at: result.tokenExpiresAt,
      delivery_state: result.deliveryState,
    });
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
