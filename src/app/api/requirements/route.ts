import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { getRequirements, setRequirementRule } from '@/lib/services/requirements';
import type { ScopeType } from '@/lib/services/requirements';
import { requireTenantAuth, isResponse, ok, badRequest, forbidden, unprocessable } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  const db = getDb();
  return ok(await getRequirements(db, auth.tenantId));
}

export async function PUT(request: Request): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (auth.role !== 'admin') return forbidden();
  if (!auth.tenantId) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch { return badRequest('JSON body required'); }

  const { scope, scope_ref, requirement_key, required_value, reason } = body as Record<string, unknown>;

  if (!scope || !['org', 'trade', 'location'].includes(scope as string)) {
    return badRequest('scope must be one of: org, trade, location');
  }
  if (typeof requirement_key !== 'string' || !requirement_key.trim()) {
    return badRequest('requirement_key is required');
  }
  if (typeof required_value !== 'string' || !required_value.trim()) {
    return badRequest('required_value is required');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return badRequest('reason is required (audit invariant)');
  }

  const db = getDb();
  try {
    const rule = await setRequirementRule(
      db,
      auth.tenantId,
      {
        scope: scope as ScopeType,
        scope_ref: typeof scope_ref === 'string' ? scope_ref : null,
        requirement_key: requirement_key.trim(),
        required_value: required_value.trim(),
        reason: reason.trim(),
      },
      auth.sub
    );
    return ok(rule);
  } catch (e: unknown) {
    const err = e as { message: string; status?: number };
    const status = err.status ?? 500;
    if (status === 422) return unprocessable(err.message);
    return new NextResponse(JSON.stringify({ error: err.message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
