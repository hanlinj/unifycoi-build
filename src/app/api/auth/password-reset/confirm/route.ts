// Password-reset CONFIRM (SEC-8). Verifies the single-use token, sets the new password,
// consumes the token, and invalidates the user's other outstanding tokens. Cookie-less —
// must be CSRF-exempt in Slice 4. Reset does NOT invalidate live JWT sessions this phase.

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { ok, badRequest, apiError, unprocessable } from '@/lib/api';
import { confirmPasswordReset } from '@/lib/services/password-reset';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be JSON');
  }
  const { token, password } = body as Record<string, unknown>;
  if (typeof token !== 'string' || typeof password !== 'string') {
    return badRequest('token and password are required');
  }

  const db = getRawDb();
  const res = confirmPasswordReset(db, { rawToken: token, newPassword: password });
  if (!res.ok) {
    if (res.reason === 'weak_password') return unprocessable(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    return apiError('This reset link is invalid or has expired.', 400);
  }
  return ok({ message: 'Your password has been reset. You can now sign in.' }, 200);
}
