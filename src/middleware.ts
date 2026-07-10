// Edge middleware — two concerns, header-only, NO DB (edge runtime can't run jsonwebtoken
// or better-sqlite3; full JWT verification still happens in getAuth at the page/API layer):
//
//  1. CSRF (SEC-12): state-changing methods (POST/PUT/PATCH/DELETE) on COOKIE-authed
//     requests are checked via Sec-Fetch-Site (primary) then Origin (fallback). The
//     exemption logic — not the matcher — is where correctness lives (see csrfReject).
//  2. Route guard: page routes without a session cookie redirect to /login. API routes own
//     their own 401/403 via getAuth, so the middleware NEVER redirects them.
//
// The matcher now INCLUDES /api/* (it previously excluded it) so CSRF can see API mutations
// — the load-bearing change of this slice.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';

const MUTATION = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // 1. CSRF on state-changing methods.
  if (MUTATION.has(req.method)) {
    const rejection = csrfReject(req, pathname);
    if (rejection) return rejection;
  }

  // 2. API routes: never redirect — the handler owns auth (getAuth → 401/403). Pass through.
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // 2b. Page routes: presence-only session check (full verify at getAuth). No cookie → /login.
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

/**
 * CSRF decision for a state-changing request. Returns a 403 to reject, or null to allow/exempt.
 * Exemptions, in order:
 *  - Bearer present            → not an ambient credential, not a CSRF vector.
 *  - cookie-less AND not login → webhooks (signature-verified), /api/v/* (token in URL path),
 *                                password-reset (cookie-less). Not a CSRF target.
 * Login is cookie-SETTING, so it is enforced even without a prior cookie (session-fixation).
 * Enforced set: Sec-Fetch-Site first (a browser-set forbidden header JS cannot spoof); if
 * absent, fall back to Origin against the allow-list; if BOTH absent, reject.
 */
function csrfReject(req: NextRequest, pathname: string): NextResponse | null {
  if (req.headers.get('authorization')) return null; // Bearer → exempt

  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  const isLogin = pathname === '/api/auth/login';
  if (!hasCookie && !isLogin) return null; // cookie-less & not login → exempt

  const sfs = req.headers.get('sec-fetch-site');
  if (sfs) {
    return sfs === 'cross-site' ? forbidden() : null; // same-origin/same-site/none → allow
  }
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return forbidden(); // both absent → reject
  return null;
}

function forbidden(): NextResponse {
  return new NextResponse('Forbidden (CSRF)', { status: 403 });
}

/**
 * Allowed origins for the Origin fallback. From ALLOWED_ORIGINS (comma-separated exact
 * origins); dev default is APP_BASE_URL's origin + localhost:3000. In prod set
 * ALLOWED_ORIGINS explicitly (and include the Tailscale/LAN origin for non-Sec-Fetch-Site
 * clients — browsers over Tailscale send Sec-Fetch-Site: same-origin and bypass this path).
 */
function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const defaults = ['http://localhost:3000'];
  const base = process.env.APP_BASE_URL;
  if (base) {
    try {
      defaults.push(new URL(base).origin);
    } catch {
      /* ignore malformed APP_BASE_URL */
    }
  }
  return defaults;
}

export const config = {
  // Include /api/* (so CSRF can see API mutations); still exclude /login, /reset-password and
  // /billing/setup (unauthenticated, token-in-URL landing pages — the token IS the credential,
  // like /v/*), the public /v/* vendor flow, Next internals, and common static files.
  matcher: ['/((?!login|reset-password|billing/setup|v/|_next/|favicon.ico|robots.txt).*)'],
};
