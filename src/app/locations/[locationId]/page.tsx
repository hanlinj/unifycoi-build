// /locations/[locationId] — Location Record. Read-only single-store compliance view +
// location-scoped Admin actions (send reminder, archive). Decisions still happen at the
// Vendor Record (rows click through). Scope-clamped server-side via the API.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { SendReminderButton, ArchiveLocationButton } from './LocationActions';

export const dynamic = 'force-dynamic';

interface VendorRow {
  vendorId: string; name: string; trade: string; status: string;
  approvedAt: string | null; expiresAt: string | null; daysToExpiry: number | null;
}
interface LocationRecord {
  location: { id: string; name: string; address: string | null; region_name: string | null; status: string };
  vendors: VendorRow[];
  trades: string[];
  statuses: string[];
  activeFilters: { status: string | null; trade: string | null };
  role: string;
}

const STATUS_LABEL: Record<string, string> = {
  invited_pending: 'Invited / Pending', onboarding: 'Onboarding', under_review: 'Under Review',
  approved: 'Approved', expired: 'Expired', non_compliant: 'Non-Compliant', declined: 'Declined',
};
function titleCase(s: string) { return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function statusColor(s: string) {
  if (s === 'approved') return '#1a7f37';
  if (['expired', 'non_compliant', 'declined'].includes(s)) return '#cf222e';
  if (s === 'under_review') return '#9a6700';
  return '#57606a';
}
function fmtDate(iso: string | null) { return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }

export default async function LocationRecordPage({ params, searchParams }: { params: { locationId: string }; searchParams: { status?: string; trade?: string } }) {
  const status = searchParams.status ?? '';
  const trade = searchParams.trade ?? '';
  const h = headers();
  const base = requestBaseUrl(h);
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (trade) qs.set('trade', trade);
  const res = await fetch(`${base}/api/locations/${params.locationId}?${qs}`, {
    headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/');
  if (res.status === 404) return <p style={{ padding: 32, fontFamily: 'system-ui' }}>Location not found.</p>;
  if (!res.ok) return <p style={{ padding: 32, fontFamily: 'system-ui' }}>Failed to load the location record.</p>;

  const { data } = (await res.json()) as { data: LocationRecord };
  const { location, vendors, statuses, trades, role } = data;
  const isAdmin = role === 'admin';
  const archived = location.status === 'archived';

  const filterHref = (next: { status?: string | null; trade?: string | null }) => {
    const p = new URLSearchParams();
    const st = next.status === undefined ? status : (next.status ?? '');
    const tr = next.trade === undefined ? trade : (next.trade ?? '');
    if (st) p.set('status', st); if (tr) p.set('trade', tr);
    const s = p.toString();
    return `/locations/${location.id}${s ? `?${s}` : ''}`;
  };
  const chip = (active: boolean): React.CSSProperties => ({ padding: '3px 10px', borderRadius: 999, fontSize: 12, textDecoration: 'none', border: '1px solid #d0d7de', background: active ? '#0969da' : 'white', color: active ? 'white' : '#24292f', fontWeight: active ? 600 : 400 });

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' }}>
      {/* Zone 1 — identity + posture */}
      <header style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>
            {location.name}
            {archived && <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 600, color: '#57606a', border: '1px solid #d0d7de', borderRadius: 999, padding: '2px 10px' }}>Archived</span>}
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>
            {location.address ?? 'No address on file'}{location.region_name ? ` · ${location.region_name}` : ''}
          </p>
        </div>
        {isAdmin && !archived && <ArchiveLocationButton locationId={location.id} locationName={location.name} />}
      </header>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#57606a' }}>Status</span>
          <a href={filterHref({ status: null })} style={chip(!status)}>All</a>
          {statuses.map((st) => <a key={st} href={filterHref({ status: st })} style={chip(status === st)}>{STATUS_LABEL[st] ?? st}</a>)}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#57606a' }}>Trade</span>
          <a href={filterHref({ trade: null })} style={chip(!trade)}>All</a>
          {trades.map((tr) => <a key={tr} href={filterHref({ trade: tr })} style={chip(trade === tr)}>{titleCase(tr)}</a>)}
        </div>
      </div>

      {/* Zone — vendors at this location */}
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 10px' }}>Vendors at this location <span style={{ color: '#57606a', fontWeight: 400 }}>({vendors.length})</span></h2>
      {vendors.length === 0 ? (
        <p style={{ color: '#57606a', fontSize: 14 }}>No vendors at this store yet{status || trade ? ' match the filters' : ''}.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f6f8fa', textAlign: 'left' }}>
              <th style={th}>Vendor</th><th style={th}>Trade</th><th style={th}>Status</th>
              <th style={th}>Last approval</th><th style={th}>Next expiration</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.vendorId} style={{ borderTop: '1px solid #f0f3f6' }}>
                <td style={td}><a href={`/vendors/${v.vendorId}`} style={{ fontWeight: 600, color: '#0969da', textDecoration: 'none' }}>{v.name}</a></td>
                <td style={td}>{titleCase(v.trade)}</td>
                <td style={{ ...td, color: statusColor(v.status), fontWeight: 600 }}>{STATUS_LABEL[v.status] ?? v.status}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{fmtDate(v.approvedAt)}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: v.daysToExpiry !== null && v.daysToExpiry <= 30 ? '#cf222e' : '#24292f', fontWeight: v.daysToExpiry !== null && v.daysToExpiry <= 30 ? 600 : 400 }}>
                  {fmtDate(v.expiresAt)}{v.daysToExpiry !== null ? ` (${v.daysToExpiry}d)` : ''}
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {isAdmin && v.expiresAt && <SendReminderButton locationId={location.id} vendorId={v.vendorId} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Invite affordance — Admin / District-in-scope / Store-in-scope (Location_Record.md).
          Anyone who can view this record is in scope to invite here. Reuses the global invite
          (chrome) prefilled with this location; the modal is Phase 10 navigation, backend
          reuse is verified by test. */}
      {!archived && (
        <p style={{ marginTop: 18, fontSize: 13, color: '#57606a' }}>
          To add a vendor here, use <strong>Invite</strong> (prefilled with this location).
        </p>
      )}
    </main>
  );
}

const th: React.CSSProperties = { padding: '8px 12px', fontSize: 12, fontWeight: 600, color: '#57606a' };
const td: React.CSSProperties = { padding: '9px 12px', verticalAlign: 'top' };
