// Password-reset REQUEST (SEC-8). Enumeration-safe: identical response whether or not the
// email resolves. Shares the Slice 2 login limiter so reset-spam is throttled on the same
// {email, ip} key. Cookie-less (unauthenticated) — must be CSRF-exempt in Slice 4.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { ok, badRequest, tooManyRequests, clientIp } from '@/lib/api';
import { checkLoginRate, recordLoginFailure } from '@/lib/auth/rate-limit';
import { requestPasswordReset } from '@/lib/services/password-reset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC = 'If an account exists for that email, a reset link has been sent.';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be JSON');
  }
  const { email } = body as Record<string, unknown>;
  if (typeof email !== 'string' || !email) return badRequest('email is required');

  const db = getRawDb();
  const ip = clientIp(request);

  // Same throttle as login: a reset request counts against the {email, ip} key, so
  // reset-spam is bounded and pools with failed logins. Generic 429 — no factor revealed.
  const decision = checkLoginRate(db, { email, ip });
  if (!decision.allowed) return tooManyRequests(decision.retryAfterSeconds);
  recordLoginFailure(db, { email, ip });

  requestPasswordReset(db, { email }); // no-op when the email doesn't resolve
  return ok({ message: GENERIC }, 200); // identical regardless of existence
}
