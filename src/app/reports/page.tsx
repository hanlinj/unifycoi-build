// /reports — the fixed report catalog the user has scope to run (Admin + District).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';

export const dynamic = 'force-dynamic';

interface Meta { key: string; name: string; question: string }

export default async function ReportsIndexPage() {
  const h = headers();
  const base = requestBaseUrl(h);
  const res = await fetch(`${base}/api/reports`, { headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store' });
  if (res.status === 401) redirect('/');
  if (res.status === 403) return <main style={wrap}><p style={{ color: '#57606a' }}>Reports are available to Admins and District Managers. Your operational view is the dashboard.</p></main>;
  if (!res.ok) return <main style={wrap}><p>Failed to load reports.</p></main>;

  const { data } = (await res.json()) as { data: { reports: Meta[] } };

  return (
    <main style={wrap}>
      <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>Reports & Analytics</h1>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: '#57606a' }}>Deliberate, parameterized analytics — trends, forecasts, rosters. Each exports to PDF and CSV.</p>
      <div style={{ display: 'grid', gap: 12 }}>
        {data.reports.map((r) => (
          <a key={r.key} href={`/reports/${r.key}`} style={card}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{r.name}</div>
            <div style={{ fontSize: 13, color: '#57606a', marginTop: 2 }}>{r.question}</div>
          </a>
        ))}
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = { maxWidth: 820, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' };
const card: React.CSSProperties = { display: 'block', border: '1px solid #d0d7de', borderRadius: 8, padding: '14px 16px', textDecoration: 'none', color: '#24292f', background: 'white' };
