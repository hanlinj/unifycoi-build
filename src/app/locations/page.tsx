// /locations — directory. Scope-clamped list of locations (GET /api/locations), each linking to
// its Location Record. The "Locations" sidebar entry (Admin/District) and "My Stores" (Store)
// both land here. Minimal by design — the record page carries the detail.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';

export const dynamic = 'force-dynamic';

interface Loc { id: string; name: string; region_name: string | null; address?: string | null }

export default async function LocationsPage() {
  const h = headers();
  const base = requestBaseUrl(h);
  const res = await fetch(`${base}/api/locations`, { headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store' });
  if (res.status === 401) redirect('/login');
  const locations = (res.ok ? ((await res.json()).data as Loc[]) : []) ?? [];

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>Locations</h1>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#57606a' }}>Facilities in your scope. Open one to see its compliance record.</p>
      {locations.length === 0 ? <p style={{ fontSize: 13, color: '#57606a' }}>No locations in your scope.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ background: '#f6f8fa', textAlign: 'left' }}>
            <th style={th}>Location</th><th style={th}>Region</th>
          </tr></thead>
          <tbody>
            {locations.map((l) => (
              <tr key={l.id} style={{ borderTop: '1px solid #f0f3f6' }}>
                <td style={td}><a href={`/locations/${l.id}`} style={{ color: '#0969da', textDecoration: 'none', fontWeight: 500 }}>{l.name}</a></td>
                <td style={{ ...td, color: '#57606a' }}>{l.region_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#57606a', fontWeight: 600 };
const td: React.CSSProperties = { padding: '9px 10px' };
