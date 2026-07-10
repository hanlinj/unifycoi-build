import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { loginResolvingTenant } from '@/lib/services/auth';
import { ok, badRequest, apiError, tooManyRequests, clientIp, SESSION_COOKIE } from '@/lib/api';
import { checkLoginRate, recordLoginFailure, clearLoginFailuresForEmail } from '@/lib/auth/rate-limit';

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

  const db = getDb();
  const ip = clientIp(request);

  // Throttle BEFORE attempting (SEC-9). A blocked attempt is not recorded, so the rolling
  // window ages out and the soft lock self-lifts. Generic 429 — never says which factor tripped.
  const decision = await checkLoginRate(db, { email, ip });
  if (!decision.allowed) {
    return tooManyRequests(decision.retryAfterSeconds);
  }

  const result = await loginResolvingTenant(db, email, password, typeof tenantId === 'string' ? tenantId : undefined);
  if (!result) {
    await recordLoginFailure(db, { email, ip });
    return apiError('Invalid credentials or account is not accessible', 401);
  }
  // Success clears the per-email soft lock (IP rolling window is preserved).
  await clearLoginFailuresForEmail(db, email);

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
