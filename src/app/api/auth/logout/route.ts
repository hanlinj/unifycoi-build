import { NextResponse } from 'next/server';
import { ok, SESSION_COOKIE } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Clears the session cookie. JWT is stateless, so logout is cookie removal (idempotent — a
// request without a valid session still succeeds at clearing it).
export async function POST(): Promise<NextResponse> {
  const res = ok({ message: 'Logged out' });
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
