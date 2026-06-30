// Route guard: any tenant app route without a session cookie redirects to /login (cleaner than
// each page handling its own 401). This is a cheap PRESENCE check only — full JWT verification
// still happens in getAuth at the page/API layer (edge runtime can't run jsonwebtoken). The
// matcher already excludes /login, the public /v/* vendor flow, /api/*, and static assets.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';

export function middleware(req: NextRequest): NextResponse {
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Guard everything except: login, the public vendor token flow, API routes, Next internals,
  // and common static files.
  matcher: ['/((?!login|v/|api/|_next/|favicon.ico|robots.txt).*)'],
};
