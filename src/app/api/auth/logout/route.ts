import { NextResponse } from 'next/server';
import { ok, unauthorized, getAuth } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// JWT is stateless; logout is client-side token discard.
// This endpoint validates the current token so the client can confirm it was valid.
export async function POST(request: Request): Promise<NextResponse> {
  const auth = getAuth(request);
  if (!auth) return unauthorized();
  return ok({ message: 'Logged out' });
}
