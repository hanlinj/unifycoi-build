// GET /api/platform/tenants/check-slug?slug=… — live uniqueness pre-check for the wizard's
// Tenant step, so a collision is caught before the operator reaches Review/submit rather than
// surfacing as a 409 on the final provision POST. provisionTenant + createTenant still
// re-validate at submit time (this is a UX convenience, not the enforcement point).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { isSlugTaken, isValidSlug } from '@/lib/services/tenants';
import { requirePlatformAuth, isResponse, ok, badRequest } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  const slug = new URL(request.url).searchParams.get('slug') ?? '';
  if (!isValidSlug(slug)) return badRequest('slug must be lowercase letters, numbers, and hyphens');

  return ok({ slug, available: !(await isSlugTaken(getDb(), slug)) });
}
