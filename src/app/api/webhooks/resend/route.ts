// Resend delivery webhook. Cookie-less and signature-authenticated (NOT session-authed),
// so Slice 4's CSRF/route-guard middleware must exempt /api/webhooks/*. All logic lives in
// lib/notifications/resend-webhook.ts; this is thin wiring over it.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { env } from '@/lib/env';
import { verifyResendWebhook, handleResendEvent, type ResendEvent } from '@/lib/notifications/resend-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // Raw body is required for signature verification — read it before any JSON parse.
  const rawBody = await request.text();

  const verified = verifyResendWebhook(
    rawBody,
    {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    env.email.webhookSecret,
    Date.now()
  );
  if (!verified) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const result = await handleResendEvent(getDb(), event);
  // Always 2xx once authenticated so Resend doesn't retry-storm on an ignored/unknown event.
  return NextResponse.json(result, { status: 200 });
}
