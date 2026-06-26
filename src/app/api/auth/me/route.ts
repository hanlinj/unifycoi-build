import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { getMeInfo } from '@/lib/services/auth';
import { getAuth, ok, unauthorized, notFound } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const auth = getAuth(request);
  if (!auth) return unauthorized();

  const db = getRawDb();
  const info = getMeInfo(db, auth);
  if (!info) return notFound('User not found');

  return ok(info);
}
