'use client';

import { useState } from 'react';

interface Loc { id: string; name: string }
const input: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13 };
const btn: React.CSSProperties = { padding: '7px 16px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const card: React.CSSProperties = { border: '1px solid #d0d7de', borderRadius: 8, padding: 16, marginBottom: 26 };

// ── Add rule ───────────────────────────────────────────────────────────────────────────

export function AddRuleForm({ trades, locations }: { trades: string[]; locations: Loc[] }) {
  const [scope, setScope] = useState<'org' | 'trade' | 'location'>('org');
  const [scopeRef, setScopeRef] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) { setMsg({ ok: false, text: 'Reason must be at least 10 characters.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/requirements', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, scope_ref: scope === 'org' ? null : scopeRef, requirement_key: key.trim(), required_value: value.trim(), reason: reason.trim() }),
      });
      if (res.ok) { window.location.reload(); return; }
      const b = await res.json().catch(() => ({}));
      setMsg({ ok: false, text: (b as { error?: string }).error ?? `Error ${res.status}` });
    } catch { setMsg({ ok: false, text: 'Network error.' }); }
    finally { setBusy(false); }
  }

  return (
    <section style={card}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 10px' }}>Add / update a rule</h2>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr', alignItems: 'end' }}>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Scope
          <select value={scope} onChange={(e) => { setScope(e.target.value as 'org' | 'trade' | 'location'); setScopeRef(''); }} style={{ ...input, width: '100%', marginTop: 4 }}>
            <option value="org">Org base</option><option value="trade">Trade override</option><option value="location">Location override</option>
          </select>
        </label>
        <label style={{ fontSize: 12, fontWeight: 600 }}>{scope === 'org' ? 'Applies org-wide' : scope === 'trade' ? 'Trade' : 'Location'}
          {scope === 'trade' ? (
            <select value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} required style={{ ...input, width: '100%', marginTop: 4 }}>
              <option value="">Select trade…</option>{trades.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
          ) : scope === 'location' ? (
            <select value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} required style={{ ...input, width: '100%', marginTop: 4 }}>
              <option value="">Select location…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : <input disabled value="—" style={{ ...input, width: '100%', marginTop: 4, background: '#f6f8fa' }} />}
        </label>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Requirement key
          <input value={key} onChange={(e) => setKey(e.target.value)} required placeholder="coverage.general_liability.each_occurrence" style={{ ...input, width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Required value
          <input value={value} onChange={(e) => setValue(e.target.value)} required placeholder="2000000" style={{ ...input, width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 600, gridColumn: '1 / -1' }}>Reason (required, audit trail)
          <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} placeholder="Why this change?" style={{ ...input, width: '100%', marginTop: 4 }} />
        </label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, alignItems: 'center' }}>
          <button type="submit" disabled={busy} style={btn}>{busy ? 'Saving…' : 'Save rule'}</button>
          {msg && <span style={{ fontSize: 13, color: msg.ok ? '#1a7f37' : '#cf222e' }}>{msg.text}</span>}
        </div>
      </form>
    </section>
  );
}

// ── Precedence ─────────────────────────────────────────────────────────────────────────

export function PrecedenceSelector({ current }: { current: string }) {
  const [policy, setPolicy] = useState(current);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (reason.trim().length < 10) { setMsg('Reason must be at least 10 characters.'); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/requirements/precedence', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy, reason: reason.trim() }) });
      if (res.ok) { window.location.reload(); return; }
      const b = await res.json().catch(() => ({}));
      setMsg((b as { error?: string }).error ?? `Error ${res.status}`);
    } catch { setMsg('Network error.'); }
    finally { setBusy(false); }
  }

  const changed = policy !== current || reason.length > 0;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={policy} onChange={(e) => setPolicy(e.target.value)} style={input}>
        <option value="strictest">Strictest wins</option><option value="location">Location wins</option><option value="trade">Trade wins</option>
      </select>
      {changed && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for change (required)" style={{ ...input, flex: 1, minWidth: 220 }} />}
      {changed && <button onClick={save} disabled={busy} style={btn}>{busy ? 'Saving…' : 'Update precedence'}</button>}
      {msg && <span style={{ fontSize: 13, color: '#cf222e' }}>{msg}</span>}
    </div>
  );
}

// ── Resolved matrix preview ──────────────────────────────────────────────────────────────

interface Entry { requirement_key: string; required_value: string; source: string }

export function ResolvedMatrix({ trades, locations }: { trades: string[]; locations: Loc[] }) {
  const [trade, setTrade] = useState('');
  const [location, setLocation] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function preview() {
    if (!trade || !location) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/requirements/resolve?trade=${encodeURIComponent(trade)}&location=${encodeURIComponent(location)}`);
      setEntries(res.ok ? ((await res.json()).data.entries as Entry[]) : []);
    } catch { setEntries([]); }
    finally { setBusy(false); }
  }

  const humanize = (k: string) => k.split('.').slice(-2).join(' — ').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const sourceLabel: Record<string, string> = { org: 'org base', trade: 'trade override', location: 'location override', floor: 'platform floor' };

  return (
    <section style={card}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>Preview effective requirements</h2>
      <p style={{ fontSize: 13, color: '#57606a', margin: '0 0 10px' }}>The exact rule set the engine verifies a vendor against, with where each value came from.</p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={trade} onChange={(e) => setTrade(e.target.value)} style={input}>
          <option value="">Select trade…</option>{trades.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={location} onChange={(e) => setLocation(e.target.value)} style={input}>
          <option value="">Select location…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button onClick={preview} disabled={!trade || !location || busy} style={{ ...btn, opacity: !trade || !location ? 0.5 : 1 }}>{busy ? 'Resolving…' : 'Resolve'}</button>
      </div>
      {entries && (entries.length === 0 ? (
        <p style={{ fontSize: 13, color: '#57606a' }}>No effective requirements for this trade + location.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: '#f6f8fa', textAlign: 'left' }}><th style={th}>Requirement</th><th style={th}>Required</th><th style={th}>Source</th></tr></thead>
          <tbody>{entries.map((e) => (
            <tr key={e.requirement_key} style={{ borderTop: '1px solid #f0f3f6' }}>
              <td style={td}>{humanize(e.requirement_key)}</td>
              <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{e.required_value}</td>
              <td style={{ ...td, color: e.source === 'floor' ? '#9a6700' : '#57606a' }}>{sourceLabel[e.source] ?? e.source}</td>
            </tr>
          ))}</tbody>
        </table>
      ))}
    </section>
  );
}

const th: React.CSSProperties = { padding: '7px 10px', fontSize: 12, color: '#57606a', fontWeight: 600 };
const td: React.CSSProperties = { padding: '7px 10px', verticalAlign: 'top' };
