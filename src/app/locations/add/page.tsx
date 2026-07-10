// /locations/add — bulk add locations + primary store managers (Slice 12/5b, Feature 1).
// Admin-only (mirrors /api/locations/bulk-import's own gate). Created managers land dormant
// (invited, no link sent) — send their invites from /users (Feature 2).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { ImportableLocationsSection } from '../ImportableLocationsSection';

export const dynamic = 'force-dynamic';

export default async function AddLocationsPage() {
  const h = headers();
  const base = requestBaseUrl(h);
  const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store' });
  if (res.status === 401) redirect('/login');
  const me = res.ok ? ((await res.json()).data as { role?: string }) : {};
  if (me.role !== 'admin') redirect('/locations');

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>Add locations</h1>
      <p style={{ margin: '0 0 4px', fontSize: 13, color: '#57606a' }}>Bulk-add stores and their primary managers.</p>
      <a href="/locations" style={{ fontSize: 12, color: '#0969da', textDecoration: 'none' }}>← Back to locations</a>
      <ImportableLocationsSection />
    </div>
  );
}
