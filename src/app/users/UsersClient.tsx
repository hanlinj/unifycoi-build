'use client';

import { useState } from 'react';

interface Opt { id: string; name: string }
const input: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13 };
const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white', fontWeight: 600, fontSize: 12, cursor: 'pointer' };

// ── Invite / add ───────────────────────────────────────────────────────────────────────

export function InviteUserForm({ callerRole, regions, locations }: { callerRole: string; regions: Opt[]; locations: Opt[] }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  // A District can assign DM/SM within region, never Admin.
  const roleOptions = callerRole === 'admin' ? ['admin', 'district_manager', 'store_manager'] : ['district_manager', 'store_manager'];
  const [role, setRole] = useState(roleOptions[roleOptions.length - 1]); // default store_manager
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { email: email.trim(), name: `${first.trim()} ${last.trim()}`.trim(), role };
      if (role === 'district_manager') body.regionIds = regionIds;
      if (role === 'store_manager') body.locationIds = locationIds;
      const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { window.location.reload(); return; }
      const b = await res.json().catch(() => ({}));
      setMsg({ ok: false, text: (b as { error?: string }).error ?? `Error ${res.status}` });
    } catch { setMsg({ ok: false, text: 'Network error.' }); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: 16, marginTop: 26 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 10px' }}>Invite a user</h2>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr 1fr', alignItems: 'end' }}>
        <label style={lbl}>First name<input value={first} onChange={(e) => setFirst(e.target.value)} required style={{ ...input, width: '100%', marginTop: 4 }} /></label>
        <label style={lbl}>Last name<input value={last} onChange={(e) => setLast(e.target.value)} required style={{ ...input, width: '100%', marginTop: 4 }} /></label>
        <label style={lbl}>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ ...input, width: '100%', marginTop: 4 }} /></label>
        <label style={lbl}>Role
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ ...input, width: '100%', marginTop: 4 }}>
            {roleOptions.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        {role === 'district_manager' && (
          <fieldset style={{ ...lbl, gridColumn: '2 / -1', border: '1px solid #eaeef2', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12 }}>Regions</legend>
            {regions.length === 0 ? <span style={{ fontSize: 12, color: '#8c959f' }}>No regions in scope</span> : regions.map((r) => (
              <label key={r.id} style={chk}><input type="checkbox" checked={regionIds.includes(r.id)} onChange={() => toggle(regionIds, setRegionIds, r.id)} /> {r.name}</label>
            ))}
          </fieldset>
        )}
        {role === 'store_manager' && (
          <fieldset style={{ ...lbl, gridColumn: '2 / -1', border: '1px solid #eaeef2', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12 }}>Locations</legend>
            {locations.length === 0 ? <span style={{ fontSize: 12, color: '#8c959f' }}>No locations in scope</span> : locations.map((l) => (
              <label key={l.id} style={chk}><input type="checkbox" checked={locationIds.includes(l.id)} onChange={() => toggle(locationIds, setLocationIds, l.id)} /> {l.name}</label>
            ))}
          </fieldset>
        )}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, alignItems: 'center' }}>
          <button type="submit" disabled={busy} style={{ ...btn, padding: '8px 16px', fontSize: 13 }}>{busy ? 'Sending…' : 'Send invite'}</button>
          {msg && <span style={{ fontSize: 13, color: msg.ok ? '#1a7f37' : '#cf222e' }}>{msg.text}</span>}
        </div>
      </form>
    </section>
  );
}

// ── Per-row actions: deactivate / reactivate + edit scope ─────────────────────────────────

export function UserRowActions({ user, regions, locations }: { user: { id: string; role: string; status: string; inviteSentAt: string | null; regionIds: string[]; locationIds: string[] }; regions: Opt[]; locations: Opt[] }) {
  const [editing, setEditing] = useState(false);
  const [regionIds, setRegionIds] = useState(user.regionIds);
  const [locationIds, setLocationIds] = useState(user.locationIds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { window.location.reload(); return; }
      const b = await res.json().catch(() => ({}));
      setErr((b as { error?: string }).error ?? `Error ${res.status}`);
    } catch { setErr('Network error.'); } finally { setBusy(false); }
  }
  async function sendInvite() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/users/${user.id}/send-invite`, { method: 'POST' });
      const b = await res.json().catch(() => ({}));
      if (res.ok) { setInviteUrl((b as { data: { inviteUrl: string } }).data.inviteUrl); return; }
      setErr((b as { error?: string }).error ?? `Error ${res.status}`);
    } catch { setErr('Network error.'); } finally { setBusy(false); }
  }
  async function copyInviteUrl() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the link is still visible/selectable below.
    }
  }
  const toggle = (arr: string[], set: (v: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {user.status === 'disabled'
        ? <button disabled={busy} onClick={() => patch({ status: 'active' })} style={{ ...btn, background: '#1f883d' }}>Reactivate</button>
        : <button disabled={busy} onClick={() => { if (confirm('Deactivate this user? They will be blocked from signing in. History is retained.')) patch({ status: 'disabled' }); }} style={{ ...btn, background: 'white', color: '#cf222e', border: '1px solid #cf222e' }}>Deactivate</button>}
      {(user.role === 'district_manager' || user.role === 'store_manager') && (
        <button disabled={busy} onClick={() => setEditing((v) => !v)} style={{ ...btn, background: 'white', color: '#24292f', border: '1px solid #d0d7de' }}>{editing ? 'Cancel' : 'Edit scope'}</button>
      )}
      {user.status === 'invited' && (
        <button disabled={busy} onClick={sendInvite} style={{ ...btn, background: 'white', color: '#0969da', border: '1px solid #0969da' }}>
          {busy ? 'Sending…' : user.inviteSentAt ? 'Resend invite' : 'Send invite'}
        </button>
      )}
      {inviteUrl && (
        <div style={{ flexBasis: '100%', display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, fontSize: 12 }} />
          <button onClick={copyInviteUrl} style={{ ...btn, padding: '5px 10px' }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {editing && (
        <div style={{ flexBasis: '100%', border: '1px solid #eaeef2', borderRadius: 6, padding: 8, marginTop: 4 }}>
          {(user.role === 'district_manager' ? regions : locations).map((o) => {
            const arr = user.role === 'district_manager' ? regionIds : locationIds;
            const set = user.role === 'district_manager' ? setRegionIds : setLocationIds;
            return <label key={o.id} style={chk}><input type="checkbox" checked={arr.includes(o.id)} onChange={() => toggle(arr, set, o.id)} /> {o.name}</label>;
          })}
          <div style={{ marginTop: 6 }}>
            <button disabled={busy} onClick={() => patch(user.role === 'district_manager' ? { regionIds } : { locationIds })} style={btn}>Save scope</button>
          </div>
        </div>
      )}
      {err && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: '#cf222e' }}>{err}</span>}
    </div>
  );
}

const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
const chk: React.CSSProperties = { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, marginRight: 12, fontWeight: 400 };
