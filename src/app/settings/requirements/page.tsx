// /settings/requirements — Admin-only Requirements Configuration (Requirements_Configuration.md).
// Org base + Trade overrides + Location overrides, the platform floor (locked), the precedence
// policy, an Add-rule form, and the "preview effective requirements" resolver with provenance.
// Mutations reuse the Phase 3 endpoints; the matrix uses GET /api/requirements/resolve.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { REQUIREMENT_TRADES } from '@/lib/services/requirements';
import { AddRuleForm, PrecedenceSelector, ResolvedMatrix } from './RequirementsClient';

export const dynamic = 'force-dynamic';

interface Rule { id: string; scope_type: string; scope_ref: string | null; requirement_key: string; required_value: string; created_by: string; reason: string; created_at: string }
interface ReqData { rules: { org: Rule[]; trade: Rule[]; location: Rule[] }; precedence: string; floor: Record<string, string> }
interface Loc { id: string; name: string }

export function humanizeKey(key: string): string {
  const parts = key.split('.');
  const head = parts[0];
  const rest = ['coverage', 'coverage_required', 'endorsement', 'doc_required'].includes(head) ? parts.slice(1) : parts;
  return rest.map((p) => p.replace(/_/g, ' ')).join(' — ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchJson(base: string, p: string, h: Headers): Promise<{ status: number; data?: unknown }> {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store' });
  if (!res.ok) return { status: res.status };
  return { status: res.status, data: (await res.json()).data };
}

export default async function RequirementsPage() {
  const h = headers();
  const host = h.get('host') ?? 'localhost:3000';
  const base = `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;

  const req = await fetchJson(base, '/api/requirements', h);
  if (req.status === 401) redirect('/login');
  if (req.status === 403) redirect('/'); // not an Admin
  if (!req.data) return <main style={wrap}><p>Failed to load requirements.</p></main>;
  const data = req.data as ReqData;

  const locsRes = await fetchJson(base, '/api/locations', h);
  const locations = (Array.isArray(locsRes.data) ? locsRes.data : []) as Loc[];
  const usersRes = await fetchJson(base, '/api/users', h);
  const users = (Array.isArray(usersRes.data) ? usersRes.data : []) as { id: string; name: string }[];
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const locName = (id: string | null) => (id ? locations.find((l) => l.id === id)?.name ?? id : '');

  const floorKeys = Object.keys(data.floor).sort();

  return (
    <main style={wrap}>
      <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>Requirements</h1>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: '#57606a' }}>Coverage rules vendors are verified against. You can make requirements stricter; never below the platform floor.</p>

      <Precedence data={data} />

      <RuleSection title="Org base" empty="No org rules defined; the platform floor applies." rules={data.rules.org} scopeLabel={() => 'org'} nameOf={nameOf} />
      <RuleSection title="Trade overrides" empty="No trade overrides." rules={data.rules.trade} scopeLabel={(r) => r.scope_ref ?? ''} nameOf={nameOf} />
      <RuleSection title="Location overrides" empty="No location overrides." rules={data.rules.location} scopeLabel={(r) => locName(r.scope_ref)} nameOf={nameOf} />

      {floorKeys.length > 0 && (
        <section style={section}>
          <h2 style={h2}>Platform floor <span style={{ fontWeight: 400, color: '#57606a', fontSize: 12 }}>(locked — minimums you cannot go below)</span></h2>
          <table style={table}><tbody>
            {floorKeys.map((k) => (
              <tr key={k} style={tr}><td style={td}>🔒 {humanizeKey(k)}</td><td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{data.floor[k]}</td></tr>
            ))}
          </tbody></table>
        </section>
      )}

      <AddRuleForm trades={[...REQUIREMENT_TRADES]} locations={locations} />
      <ResolvedMatrix trades={[...REQUIREMENT_TRADES]} locations={locations} />
    </main>
  );
}

function Precedence({ data }: { data: ReqData }) {
  return (
    <section style={section}>
      <h2 style={h2}>Conflict precedence</h2>
      <p style={{ fontSize: 13, color: '#57606a', margin: '0 0 8px' }}>When a trade override and a location override touch the same field, this decides which wins (never below floor).</p>
      <PrecedenceSelector current={data.precedence} />
    </section>
  );
}

function RuleSection({ title, empty, rules, scopeLabel, nameOf }: { title: string; empty: string; rules: Rule[]; scopeLabel: (r: Rule) => string; nameOf: (id: string) => string }) {
  return (
    <section style={section}>
      <h2 style={h2}>{title} <span style={{ fontWeight: 400, color: '#57606a' }}>({rules.length})</span></h2>
      {rules.length === 0 ? <p style={{ fontSize: 13, color: '#57606a', margin: 0 }}>{empty}</p> : (
        <table style={table}>
          <thead><tr style={{ background: '#f6f8fa', textAlign: 'left' }}>
            <th style={th}>Requirement</th><th style={th}>Required</th><th style={th}>Scope</th><th style={th}>Set by</th><th style={th}>When</th><th style={th}>Reason</th>
          </tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} style={tr}>
                <td style={td}>{humanizeKey(r.requirement_key)}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.required_value}</td>
                <td style={td}>{scopeLabel(r)}</td>
                <td style={td}>{nameOf(r.created_by)}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                <td style={{ ...td, color: '#57606a' }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const wrap: React.CSSProperties = { maxWidth: 960, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' };
const section: React.CSSProperties = { marginBottom: 26 };
const h2: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: '0 0 8px' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: React.CSSProperties = { padding: '7px 10px', fontSize: 12, color: '#57606a', fontWeight: 600 };
const tr: React.CSSProperties = { borderTop: '1px solid #f0f3f6' };
const td: React.CSSProperties = { padding: '7px 10px', verticalAlign: 'top' };
