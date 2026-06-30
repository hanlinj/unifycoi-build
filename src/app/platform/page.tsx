// /platform — placeholder. The real platform shell (fleet/tenants, provisioning, billing,
// support) is not built in v1 (API-only; banked in launch-prep). This prevents a confusing 404
// for a platform user after login and names what exists. No tenant chrome (shouldShowChrome).

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth/jwt';
import { SESSION_COOKIE } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default function PlatformPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  let payload: { type: string; role: string; sub: string } | null = null;
  if (token) { try { payload = verifyToken(token); } catch { payload = null; } }
  if (!payload) redirect('/login');

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui, sans-serif', color: '#24292f', background: '#f6f8fa' }}>
      <div style={{ width: 520, maxWidth: '92vw', background: 'white', border: '1px solid #d0d7de', borderRadius: 12, padding: 32 }}>
        <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 700 }}>Platform console — coming soon</h1>
        <p style={{ margin: '0 0 18px', fontSize: 14, color: '#57606a' }}>
          The platform administration UI (fleet &amp; tenants, provisioning, billing, support) isn’t available in this release.
          The underlying platform APIs are operational.
        </p>
        <div style={{ fontSize: 13, color: '#24292f', borderTop: '1px solid #eaeef2', paddingTop: 14 }}>
          Signed in as <strong>{payload!.role}</strong> (platform){' '}
          <span style={{ color: '#8c959f' }}>· {payload!.sub}</span>
        </div>
        <p style={{ fontSize: 12, color: '#8c959f', marginTop: 16 }}>
          Available platform API surfaces: <code>/api/platform/tenants</code>, <code>/api/platform/provisioning</code>.
        </p>
        <form action="/api/auth/logout" method="post" style={{ marginTop: 18 }}>
          <a href="/login" style={{ fontSize: 13, color: '#0969da' }}>Return to sign in</a>
        </form>
      </div>
    </main>
  );
}
