// HTTP helpers and auth extraction for route handlers.
import { NextResponse } from 'next/server';
import { verifyToken, extractBearerToken } from '@/lib/auth/jwt';
import type { TokenPayload } from '@/lib/auth/jwt';

export type { TokenPayload };

export const ok = (data: unknown, status = 200): NextResponse =>
  NextResponse.json({ data }, { status });

export const created = (data: unknown): NextResponse => ok(data, 201);

export const noContent = (): NextResponse => new NextResponse(null, { status: 204 });

export const apiError = (message: string, status: number): NextResponse =>
  NextResponse.json({ error: message }, { status });

export const unauthorized = (): NextResponse => apiError('Unauthorized', 401);
export const forbidden = (): NextResponse => apiError('Forbidden', 403);
export const notFound = (what = 'Not found'): NextResponse => apiError(what, 404);
export const badRequest = (msg: string): NextResponse => apiError(msg, 400);
export const conflict = (msg: string): NextResponse => apiError(msg, 409);
export const unprocessable = (msg: string): NextResponse => apiError(msg, 422);

/**
 * 429 with a generic message + Retry-After. The message must NOT reveal which factor
 * (email vs IP) tripped the throttle (SEC-9) — it is deliberately opaque.
 */
export const tooManyRequests = (retryAfterSeconds: number): NextResponse =>
  NextResponse.json(
    { error: 'Too many attempts. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, retryAfterSeconds)) } }
  );

/** Best-effort client IP from proxy headers (x-forwarded-for first hop, then x-real-ip). */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xr = request.headers.get('x-real-ip')?.trim();
  if (xr) return xr;
  return 'unknown';
}

/** Name of the HTTP-only session cookie holding the JWT for browser sessions. */
export { SESSION_COOKIE } from '@/lib/auth/session-cookie';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';

/** Read the session token from a request: Authorization: Bearer … first, else the cookie. */
function tokenFromRequest(request: Request): string | null {
  const bearer = extractBearerToken(request.headers.get('Authorization'));
  if (bearer) return bearer;
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/** Parse and verify the session token (Bearer header or cookie); returns null on any failure. */
export function getAuth(request: Request): TokenPayload | null {
  const token = tokenFromRequest(request);
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

/** Returns the payload or throws a NextResponse (use with isResponse guard). */
export function requirePlatformAuth(request: Request): TokenPayload | NextResponse {
  const auth = getAuth(request);
  if (!auth) return unauthorized();
  if (auth.type !== 'platform') return forbidden();
  return auth;
}

export function requireTenantAuth(request: Request): TokenPayload | NextResponse {
  const auth = getAuth(request);
  if (!auth) return unauthorized();
  if (auth.type !== 'tenant') return forbidden();
  return auth;
}

/** Type guard: true when requireXAuth returned an error response. */
export function isResponse(val: unknown): val is NextResponse {
  return val instanceof NextResponse;
}
