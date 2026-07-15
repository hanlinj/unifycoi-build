// /command-center — exception-first triage queue (Slice A).
// Three visually distinct zones (Tier 1 act-now / Tier 2 this-week / Tier 3 in-motion).
// Rows link to the Vendor Record (where decisions are made); bounced invites get Resend.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { StatCard } from '@/components/ui';
import { ResendButton } from './ResendButton';

export const dynamic = 'force-dynamic';

interface Row {
  vendorId: string;
  vendorName: string;
  trade: string;
  condition: string;
  phrase: string;
  locationsAffected: number;
  since: string | null;
  daysToExpiry: number | null;
  action: 'vendor_record' | 'resend_invite';
}
interface Stats {
  totalVendors: number;
  totalLocations: number;
  newVendorsThisMonth: number;
  expiredVendors: number;
}
interface CCData {
  tier1: Row[];
  tier2: Row[];
  tier3: { onboarding: number; pending: number; onTrack: number };
  facilitiesInScope: number;
  stats: Stats;
}

function ago(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  return `${days}d ago`;
}

export default async function CommandCenterPage() {
  const h = headers();
  const base = requestBaseUrl(h);
  const res = await fetch(`${base}/api/command-center`, {
    headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/');
  if (!res.ok) return <p style={{ padding: 32, fontFamily: 'system-ui' }}>Failed to load the Command Center.</p>;

  const { data } = (await res.json()) as { data: CCData };
  const { tier1, tier2, tier3, facilitiesInScope, stats } = data;

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' }}>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 24, fontWeight: 700 }}>Command Center</h1>
        <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>
          Compliance risk across {facilitiesInScope} {facilitiesInScope === 1 ? 'facility' : 'facilities'} in your scope.
        </p>
      </header>

      <div className="mb-7 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard size="lg" label="Total vendors" value={stats.totalVendors} href="/vendors" />
        <StatCard size="lg" label="Total locations" value={stats.totalLocations} />
        <StatCard size="lg" label="New vendors (mo)" value={stats.newVendorsThisMonth} />
        <StatCard
          size="lg"
          label="Expired vendors"
          value={stats.expiredVendors}
          valueTone={stats.expiredVendors > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <Zone
        title="Needs action now"
        count={tier1.length}
        accent="#cf222e"
        bg="#fff8f7"
        emptyText={`Nothing on fire across ${facilitiesInScope} ${facilitiesInScope === 1 ? 'facility' : 'facilities'}.`}
        rows={tier1}
      />

      <Zone
        title="Move it forward this week"
        count={tier2.length}
        accent="#9a6700"
        bg="#fffdf5"
        emptyText="Nothing waiting this week."
        rows={tier2}
      />

      {/* Tier 3 — ambient health, counts only */}
      <section style={{ marginTop: 28, borderLeft: '3px solid #d0d7de', paddingLeft: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px', color: '#57606a' }}>In motion</h2>
        {tier3.onboarding + tier3.pending + tier3.onTrack === 0 ? (
          <p style={{ fontSize: 13, color: '#57606a', margin: 0 }}>No vendors in progress.</p>
        ) : (
          <p style={{ fontSize: 14, margin: 0 }}>
            <Count n={tier3.onboarding} label="onboarding" />
            {' · '}
            <Count n={tier3.pending} label="invites pending" />
            {' · '}
            <Count n={tier3.onTrack} label="renewals on track" />
          </p>
        )}
      </section>
    </main>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</strong> {label}
    </span>
  );
}

function Zone({ title, count, accent, bg, emptyText, rows }: { title: string; count: number; accent: string; bg: string; emptyText: string; rows: Row[] }) {
  return (
    <section style={{ marginBottom: 28, borderLeft: `3px solid ${accent}`, paddingLeft: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        {title}
        <span style={{ fontSize: 12, fontWeight: 700, color: count > 0 ? accent : '#8c959f', background: count > 0 ? bg : '#f6f8fa', border: `1px solid ${count > 0 ? accent : '#d0d7de'}`, borderRadius: 999, padding: '1px 9px', fontVariantNumeric: 'tabular-nums' }}>
          {count}
        </span>
      </h2>
      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: '#57606a', margin: '0 0 4px' }}>{emptyText}</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.vendorId}-${r.condition}`} style={{ borderTop: '1px solid #eaeef2' }}>
                <td style={{ padding: '10px 12px 10px 0', width: '34%' }}>
                  <div style={{ fontWeight: 600 }}>{r.vendorName}</div>
                  <span style={{ fontSize: 11, color: '#57606a', textTransform: 'capitalize' }}>{r.trade.replace(/_/g, ' ')}</span>
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{ color: accent, fontWeight: 600 }}>{r.phrase}</span>
                </td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#57606a', fontVariantNumeric: 'tabular-nums' }}>
                  {r.locationsAffected} {r.locationsAffected === 1 ? 'location' : 'locations'}
                </td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#8c959f', fontVariantNumeric: 'tabular-nums' }}>
                  {r.daysToExpiry !== null ? '' : ago(r.since)}
                </td>
                <td style={{ padding: '10px 0', whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {r.action === 'resend_invite' ? (
                    <ResendButton vendorId={r.vendorId} />
                  ) : (
                    <a href={`/vendors/${r.vendorId}`} style={{ fontSize: 12, fontWeight: 600, color: '#0969da', textDecoration: 'none' }}>
                      Review →
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
