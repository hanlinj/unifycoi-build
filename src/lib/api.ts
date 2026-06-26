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

/** Parse and verify the Bearer token; returns null on any failure. */
export function getAuth(request: Request): TokenPayload | null {
  const token = extractBearerToken(request.headers.get('Authorization'));
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
