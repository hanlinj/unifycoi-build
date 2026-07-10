// Password-reset/invite-accept PEEK (Slice 4a). Read-only, cookie-less, unauthenticated GET —
// lets the /reset-password landing page render status-appropriate copy (and the right
// dead-end) BEFORE showing a password field, without consuming the token. GET is never a CSRF
// target (middleware only checks POST/PUT/PATCH/DELETE), so no exemption plumbing is needed.
//
// Deliberately more granular than confirmPasswordReset's collapsed 'invalid_token' reason —
// see peekResetToken's docstring for the (small, flagged) trade-off.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { ok, badRequest } from '@/lib/api';
import { peekResetToken } from '@/lib/services/password-reset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return badRequest('token is required');

  return ok(await peekResetToken(getDb(), token));
}
