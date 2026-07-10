// /login — the only unauthenticated internal surface. Already-authenticated users are bounced
// to their landing. No tenant chrome (no session yet).

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth/jwt';
import { SESSION_COOKIE } from '@/lib/api';
import { landingPathFor } from '@/lib/auth/landing';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage({ searchParams }: { searchParams: { notice?: string } }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  // Compute the landing inside the try (verify can throw); redirect OUTSIDE it so Next's
  // NEXT_REDIRECT isn't swallowed by the catch.
  let landing: string | null = null;
  if (token) {
    try {
      const p = verifyToken(token);
      landing = landingPathFor({ type: p.type, role: p.role });
    } catch {
      /* invalid/expired cookie → show the form */
    }
  }
  if (landing) redirect(landing);

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui, sans-serif', color: '#24292f', background: '#f6f8fa' }}>
      <div style={{ width: 360, background: 'white', border: '1px solid #d0d7de', borderRadius: 10, padding: 28 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700 }}>UnifyCOI</h1>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#57606a' }}>Sign in to your account.</p>
        <LoginForm notice={searchParams.notice} />
      </div>
    </main>
  );
}
