import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { loginResolvingTenant } from '@/lib/services/auth';
import { ok, badRequest, apiError, SESSION_COOKIE } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_MAX_AGE = 8 * 60 * 60; // 8h, matches the JWT lifetime

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
  const result = loginResolvingTenant(db, email, password, typeof tenantId === 'string' ? tenantId : undefined);
  if (!result) {
    return apiError('Invalid credentials or account is not accessible', 401);
  }

  // Establish the browser session: JWT in an HTTP-only cookie. The token is also returned in
  // the body for API/test clients.
  const res = ok({ token: result.token, user: result.user }, 200);
  res.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
