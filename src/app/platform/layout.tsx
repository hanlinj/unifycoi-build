// Platform route-group layout — the SEPARATE platform shell (invariant #12). Gates every
// /platform/* surface to PLATFORM users (a tenant user is bounced to their own home; an
// unauthenticated request to /login). The tenant AppShell renders nothing here
// (shouldShowChrome('/platform') === false), so no tenant chrome leaks.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth/jwt';
import { SESSION_COOKIE } from '@/lib/api';
import { getDb } from '@/lib/db/client';
import { getMeInfo } from '@/lib/services/auth';
import { PlatformShell } from '@/components/platform/PlatformShell';

export const dynamic = 'force-dynamic';

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  let payload: ReturnType<typeof verifyToken> | null = null;
  if (token) {
    try { payload = verifyToken(token); } catch { payload = null; }
  }
  if (!payload) redirect('/login');
  if (payload.type !== 'platform') redirect('/'); // tenant users → root routes them by role

  const me = (await getMeInfo(getDb(), payload)) as { name?: string } | null;
  return (
    <PlatformShell userName={me?.name ?? 'Platform'} userRole={payload.role}>
      {children}
    </PlatformShell>
  );
}
