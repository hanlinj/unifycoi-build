import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { createTenant, listTenants } from '@/lib/services/tenants';
import { requirePlatformAuth, isResponse, ok, created, badRequest } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  const db = getDb();
  return ok(await listTenants(db));
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requirePlatformAuth(request);
  if (isResponse(auth)) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const { name, monthlyRateCents } = body as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    return badRequest('name is required');
  }

  const db = getDb();
  const tenant = await createTenant(
    db,
    { name, monthlyRateCents: typeof monthlyRateCents === 'number' ? monthlyRateCents : undefined },
    auth.sub
  );
  return created(tenant);
}
