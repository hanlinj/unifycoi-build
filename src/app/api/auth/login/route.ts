import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { loginWithEmail } from '@/lib/services/auth';
import { ok, badRequest, apiError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be JSON');
  }

  const { email, password, tenantId } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return badRequest('email and password are required');
  }

  const db = getRawDb();
  const result = loginWithEmail(db, email, password, typeof tenantId === 'string' ? tenantId : undefined);
  if (!result) {
    return apiError('Invalid credentials or account is not accessible', 401);
  }

  return ok({ token: result.token, user: result.user }, 200);
}
