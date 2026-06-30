// /reports/[reportKey] — on-demand report view. Filters in URL query params. Real empty states.
// Per-report renderers; PDF/CSV export buttons land in Slice C.

import { cookies, headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';

export const dynamic = 'force-dynamic';

const KNOWN = new Set(['compliance-posture', 'renewal-forecast', 'vendor-roster', 'onboarding-funnel', 'deficiency-analysis', 'audit-readiness']);

function titleCase(s: string) { return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function pct(n: number | null) { return n === null ? '—' : `${n}%`; }

export default async function ReportPage({ params, searchParams }: { params: { reportKey: string }; searchParams: Record<string, string> }) {
  if (!KNOWN.has(params.reportKey)) notFound();

  const h = headers();
  const base = requestBaseUrl(h);
  const qs = new URLSearchParams();
  for (const k of ['region', 'location', 'trade', 'from', 'to']) if (searchParams[k]) qs.set(k, searchParams[k]);
  const res = await fetch(`${base}/api/reports/${params.reportKey}?${qs}`, { headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store' });
  if (res.status === 401 || res.status === 403) redirect('/');
  if (res.status === 404) notFound();
  if (!res.ok) return <main style={wrap}><p>Failed to load report.</p></main>;

  const { data: result } = (await res.json()) as { data: { meta: { name: string }; generatedAt: string; data: Record<string, unknown> } };
  const d = result.data;

  // Download links carry the current filters; the API streams the file (Content-Disposition:
  // attachment), so a plain same-origin link (cookie sent automatically) triggers the download.
  const dlBase = `/api/reports/${params.reportKey}?${qs}${qs.toString() ? '&' : ''}`;

  return (
    <main style={wrap}>
      <a href="/reports" style={{ fontSize: 12, color: '#0969da', textDecoration: 'none' }}>← All reports</a>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, margin: '6px 0 2px' }}>
        <h1 style={{ margin: 0, fontSize: 23, fontWeight: 700, flex: 1 }}>{result.meta.name}</h1>
        <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
          <a href={`${dlBase}format=csv`} style={dlBtn}>Download CSV</a>
          <a href={`${dlBase}format=pdf`} style={dlBtn}>Download PDF</a>
        </div>
      </div>
      <p style={{ margin: '0 0 22px', fontSize: 12, color: '#8c959f', fontVariantNumeric: 'tabular-nums' }}>
        Generated {new Date(result.generatedAt).toLocaleString()}
      </p>
      {renderReport(params.reportKey, d)}
    </main>
  );
}

const dlBtn: React.CSSProperties = { border: '1px solid #d0d7de', background: 'white', borderRadius: 6, padding: '6px 12px', fontSize: 13, textDecoration: 'none', color: '#24292f', fontWeight: 500, whiteSpace: 'nowrap' };

function renderReport(key: string, d: Record<string, unknown>) {
  switch (key) {
    case 'compliance-posture': return <CompliancePosture d={d} />;
    case 'renewal-forecast': return <RenewalForecast d={d} />;
    case 'vendor-roster': return <VendorRoster d={d} />;
    case 'onboarding-funnel': return <OnboardingFunnel d={d} />;
    case 'deficiency-analysis': return <DeficiencyAnalysis d={d} />;
    case 'audit-readiness': return <AuditReadiness d={d} />;
    default: return null;
  }
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: '#57606a', fontSize: 14, padding: '12px 0' }}>{children}</p>;
}

function CompliancePosture({ d }: { d: any }) {
  const s = d.snapshot;
  return (
    <>
      <Section title="Current posture">
        <p style={{ fontSize: 14 }}>
          <strong style={num}>{s.compliantPct}%</strong> compliant — <strong style={num}>{s.approved}</strong> approved of <strong style={num}>{s.total}</strong> vendor-locations.
        </p>
      </Section>
      <Section title="Activity trend (transitions per month)">
        {d.trend.length === 0 ? <Empty>No status transitions in the selected range.</Empty> : (
          <Table head={['Month', 'Approved', 'Submitted', 'Expired', 'Non-compliant', 'Declined']}
            rows={d.trend.map((t: any) => [t.period, t['vendor.approved'] ?? 0, t['vendor.submitted'] ?? 0, t['vendor.expired'] ?? 0, t['vendor.non_compliant_rule_change'] ?? 0, t['vendor.declined'] ?? 0])} />
        )}
      </Section>
      <p style={note}>{d.note}</p>
    </>
  );
}

function RenewalForecast({ d }: { d: any }) {
  return (
    <>
      <Section title="Exposure by window">
        <p style={{ fontSize: 14 }}>≤30d: <b style={num}>{d.buckets.d30}</b> · ≤60d: <b style={num}>{d.buckets.d60}</b> · ≤90d: <b style={num}>{d.buckets.d90}</b> · beyond: <b style={num}>{d.buckets.beyond}</b></p>
      </Section>
      {d.rows.length === 0 ? <Empty>No upcoming expirations in scope.</Empty> : (
        <Table head={['Vendor', 'Trade', 'Locations', 'Expires', 'Days out', 'Next reminder']}
          rows={d.rows.map((r: any) => [r.vendorName, titleCase(r.trade), r.locations.join(', '), new Date(r.expirationDate).toLocaleDateString(), r.daysOut, r.nextRung != null ? `${r.nextRung}d rung` : '—'])} />
      )}
    </>
  );
}

function VendorRoster({ d }: { d: any }) {
  if (d.rows.length === 0) return <Empty>No vendors in scope.</Empty>;
  return (
    <Table head={['Vendor', 'Trade', 'Status', 'Locations', 'GL each-occ.', 'Add’l insured', 'Waiver']}
      rows={d.rows.map((r: any) => [r.vendorName, titleCase(r.trade), titleCase(r.overallStatus), r.locations.join(', '),
        r.coverage.glEachOccurrence != null ? `$${Number(r.coverage.glEachOccurrence).toLocaleString()}` : '—',
        r.coverage.additionalInsured == null ? '—' : r.coverage.additionalInsured ? 'Yes' : 'No',
        r.coverage.waiverOfSubrogation == null ? '—' : r.coverage.waiverOfSubrogation ? 'Yes' : 'No'])} />
  );
}

function OnboardingFunnel({ d }: { d: any }) {
  return (
    <>
      <Section title="Funnel">
        <Table head={['Stage', 'Reached', 'Conversion', 'Median days in stage']}
          rows={[
            ['Invited', d.reached.invited, '—', '—'],
            ['Onboarding', d.reached.onboarding, pct(d.conversion.invited_to_onboarding), d.medianDaysInStage.invited_to_onboarding ?? '—'],
            ['Under Review', d.reached.underReview, pct(d.conversion.onboarding_to_review), d.medianDaysInStage.onboarding_to_review ?? '—'],
            ['Approved', d.reached.approved, pct(d.conversion.review_to_approved), d.medianDaysInStage.review_to_approved ?? '—'],
          ]} />
      </Section>
      <p style={note}>{d.note}</p>
    </>
  );
}

function DeficiencyAnalysis({ d }: { d: any }) {
  if (d.ranked.length === 0) return <Empty>No deficiencies or uncertainties in the selected range.</Empty>;
  return (
    <>
      <Section title="Most common findings">
        <Table head={['Requirement', 'Deficient', 'Uncertain', 'Total']}
          rows={d.ranked.map((r: any) => [titleCase(r.requirement_key), r.deficient, r.uncertain, r.total])} />
      </Section>
      {d.byTrade.length > 0 && (
        <Section title="Deficiencies by trade">
          <Table head={['Trade', 'Deficiencies']} rows={d.byTrade.map((r: any) => [titleCase(r.trade), r.deficient])} />
        </Section>
      )}
    </>
  );
}

function AuditReadiness({ d }: { d: any }) {
  const s = d.posture;
  return (
    <>
      <Section title="Posture">
        <p style={{ fontSize: 14 }}><strong style={num}>{s.compliantPct}%</strong> compliant ({s.approved}/{s.total} vendor-locations)</p>
      </Section>
      <Section title="At a glance">
        <p style={{ fontSize: 14 }}>Open exceptions: <b style={num}>{d.openExceptions}</b> · Coverage gaps: <b style={num}>{d.coverageGaps}</b> · Renewal exposure (90d): <b style={num}>{d.renewalExposure90d}</b></p>
      </Section>
      <p style={note}>{d.note}</p>
    </>
  );
}

// ── primitives ───────────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ marginBottom: 22 }}><h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 8px' }}>{title}</h2>{children}</section>;
}
function Table({ head, rows }: { head: (string)[]; rows: (string | number)[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead><tr style={{ background: '#f6f8fa', textAlign: 'left' }}>{head.map((h) => <th key={h} style={{ padding: '8px 10px', fontSize: 12, color: '#57606a', fontWeight: 600 }}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} style={{ borderTop: '1px solid #f0f3f6' }}>{r.map((c, j) => <td key={j} style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

const wrap: React.CSSProperties = { maxWidth: 940, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' };
const num: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const note: React.CSSProperties = { fontSize: 12, color: '#8c959f', marginTop: 8, fontStyle: 'italic' };
