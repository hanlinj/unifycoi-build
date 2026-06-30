// Root route — server-determined landing. Unauthenticated → /login. Authenticated → the role's
// default landing (Navigation.md): Admin/District → Command Center, Store → Dashboard, Platform
// → platform shell. No client-side flash; the redirect happens before any surface renders.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth/jwt';
import { SESSION_COOKIE } from '@/lib/api';
import { landingPathFor } from '@/lib/auth/landing';

export const dynamic = 'force-dynamic';

export default function RootPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');
  let payload;
  try {
    payload = verifyToken(token!);
  } catch {
    redirect('/login');
  }
  redirect(landingPathFor({ type: payload.type, role: payload.role }));
}
