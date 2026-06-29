// /dashboard — Manager Home Dashboard. "Who can I hire right now?"
// Approved vendors grouped by trade, with expiration urgency, a trade facet, and name search.
// Search + trade filter are plain GET params (no client JS needed). Rows → read-only Vendor Record.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface VendorRow {
  vendorId: string;
  name: string;
  trade: string;
  locations: { id: string; name: string }[];
  expiresAt: string | null;
  daysToExpiry: number | null;
  expiringSoon: boolean;
}
interface DashboardData {
  groups: { trade: string; vendors: VendorRow[] }[];
  trades: string[];
  totalApproved: number;
  facilitiesInScope: number;
  activeFilters: { trade: string | null; q: string | null };
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function expiryLabel(row: VendorRow): { text: string; urgent: boolean } {
  if (row.expiresAt === null || row.daysToExpiry === null) return { text: 'No expiration on file', urgent: false };
  const d = new Date(row.expiresAt);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (row.daysToExpiry < 0) return { text: `Expired ${date}`, urgent: true };
  return { text: `Expires ${date} (${row.daysToExpiry}d)`, urgent: row.expiringSoon };
}

export default async function DashboardPage({ searchParams }: { searchParams: { trade?: string; q?: string } }) {
  const trade = searchParams.trade ?? '';
  const q = searchParams.q ?? '';

  const h = headers();
  const host = h.get('host') ?? 'localhost:3000';
  const base = `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
  const qs = new URLSearchParams();
  if (trade) qs.set('trade', trade);
  if (q) qs.set('q', q);
  const res = await fetch(`${base}/api/dashboard?${qs.toString()}`, {
    headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/');
  if (!res.ok) return <p style={{ padding: 32, fontFamily: 'system-ui' }}>Failed to load the dashboard.</p>;

  const { data } = (await res.json()) as { data: DashboardData };

  const chipBase: React.CSSProperties = { padding: '4px 12px', borderRadius: 999, fontSize: 13, textDecoration: 'none', border: '1px solid #d0d7de', whiteSpace: 'nowrap' };
  const chip = (active: boolean): React.CSSProperties => ({
    ...chipBase,
    background: active ? '#0969da' : 'white',
    color: active ? 'white' : '#24292f',
    fontWeight: active ? 600 : 400,
  });
  const tradeHref = (t: string | null) => {
    const p = new URLSearchParams();
    if (t) p.set('trade', t);
    if (q) p.set('q', q);
    const s = p.toString();
    return `/dashboard${s ? `?${s}` : ''}`;
  };

  return (
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 24, fontWeight: 700 }}>Who can I hire?</h1>
        <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>
          {data.totalApproved} approved {data.totalApproved === 1 ? 'vendor' : 'vendors'} across {data.facilitiesInScope}{' '}
          {data.facilitiesInScope === 1 ? 'facility' : 'facilities'}.
        </p>
      </header>

      {/* Name search — plain GET form, preserves the active trade */}
      <form method="get" action="/dashboard" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {trade ? <input type="hidden" name="trade" value={trade} /> : null}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by vendor name…"
          style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 14 }}
        />
        <button type="submit" style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #d0d7de', background: '#f6f8fa', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          Search
        </button>
        {q ? <a href={tradeHref(trade || null)} style={{ alignSelf: 'center', fontSize: 13, color: '#57606a' }}>clear</a> : null}
      </form>

      {/* Trade facet chips */}
      {data.trades.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 22 }}>
          <a href={tradeHref(null)} style={chip(!trade)}>All trades</a>
          {data.trades.map((t) => (
            <a key={t} href={tradeHref(t)} style={chip(trade === t)}>{titleCase(t)}</a>
          ))}
        </div>
      )}

      {/* Results */}
      {data.groups.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', color: '#57606a' }}>
          {q || trade
            ? <p style={{ margin: 0 }}>No approved vendors match {trade ? `trade “${titleCase(trade)}”` : ''}{trade && q ? ' and ' : ''}{q ? `“${q}”` : ''}.</p>
            : <p style={{ margin: 0 }}>No approved vendors yet — invite your first vendor.</p>}
        </div>
      ) : (
        data.groups.map((g) => (
          <details key={g.trade} open style={{ marginBottom: 14, border: '1px solid #eaeef2', borderRadius: 8 }}>
            <summary style={{ cursor: 'pointer', padding: '10px 14px', fontWeight: 600, fontSize: 14, display: 'flex', justifyContent: 'space-between' }}>
              <span>{titleCase(g.trade)}</span>
              <span style={{ color: '#57606a', fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>{g.vendors.length}</span>
            </summary>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {g.vendors.map((v) => {
                  const exp = expiryLabel(v);
                  return (
                    <tr key={v.vendorId} style={{ borderTop: '1px solid #f0f3f6' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, width: '34%' }}>{v.name}</td>
                      <td style={{ padding: '10px 14px', color: exp.urgent ? '#cf222e' : '#57606a', fontWeight: exp.urgent ? 600 : 400, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {exp.urgent && row_dot()}
                        {exp.text}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#57606a' }}>
                        {v.locations.map((l) => l.name).join(', ')}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <a href={`/vendors/${v.vendorId}`} style={{ fontSize: 12, fontWeight: 600, color: '#0969da', textDecoration: 'none' }}>View →</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        ))
      )}
    </main>
  );
}

function row_dot() {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#cf222e', marginRight: 6, verticalAlign: 'middle' }} />;
}
