'use client';

// Global vendor-invite modal (Navigation.md: Invite is the primary action in tenant chrome,
// scoped, for Admin / District / Store). Opens blank with a scope-clamped location selector —
// the Location Record's pre-populated affordance (Phase 8) continues to work alongside this.
// Reuses POST /api/vendors/invite (scope-clamped server-side). Triggered by 'uc:open-invite'.

import { useEffect, useState } from 'react';
import { VALID_TRADES } from '@/lib/trades';

interface Loc { id: string; name: string }

const input: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13, boxSizing: 'border-box', marginTop: 4 };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600 };

export function InviteVendorModal() {
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [businessName, setBusinessName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [trade, setTrade] = useState('');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('uc:open-invite', onOpen as EventListener);
    return () => window.removeEventListener('uc:open-invite', onOpen as EventListener);
  }, []);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    fetch('/api/locations').then(async (r) => { if (r.ok) setLocations(((await r.json()).data as Loc[]) ?? []); }).catch(() => {});
  }, [open]);

  function reset() {
    setBusinessName(''); setFirstName(''); setLastName(''); setEmail(''); setPhone(''); setTrade(''); setLocationIds([]); setErr(null);
  }
  const toggleLoc = (id: string) => setLocationIds((a) => a.includes(id) ? a.filter((x) => x !== id) : [...a, id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (locationIds.length === 0) { setErr('Select at least one location.'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/vendors/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName, contactFirstName: firstName, contactLastName: lastName, email, companyPhone: phone, trade, locationIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const vid = (body as { data?: { vendor_id?: string } }).data?.vendor_id;
        setOpen(false); reset();
        setToast('Invite sent.');
        setTimeout(() => setToast(null), 4000);
        if (vid) window.location.assign(`/vendors/${vid}`);
        return;
      }
      setErr((body as { error?: string }).error ?? `Error ${res.status}`);
    } catch { setErr('Network error.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      {toast && <div role="status" style={{ position: 'fixed', bottom: 20, right: 20, background: '#1a7f37', color: 'white', padding: '10px 16px', borderRadius: 8, fontSize: 14, zIndex: 1100, fontFamily: 'system-ui, sans-serif' }}>{toast}</div>}
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '8vh', zIndex: 1050, fontFamily: 'system-ui, sans-serif' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '94vw', maxHeight: '84vh', overflowY: 'auto', background: 'white', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', padding: 24, color: '#24292f' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, flex: 1 }}>Invite a vendor</h2>
              <button aria-label="Close" onClick={() => setOpen(false)} style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: '#57606a' }}>×</button>
            </div>
            <form onSubmit={submit} style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
              <label style={{ ...lbl, gridColumn: '1 / -1' }}>Business name<input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required style={input} /></label>
              <label style={lbl}>Contact first name<input value={firstName} onChange={(e) => setFirstName(e.target.value)} required style={input} /></label>
              <label style={lbl}>Contact last name<input value={lastName} onChange={(e) => setLastName(e.target.value)} required style={input} /></label>
              <label style={lbl}>Contact email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={input} /></label>
              <label style={lbl}>Company phone<input value={phone} onChange={(e) => setPhone(e.target.value)} required style={input} /></label>
              <label style={{ ...lbl, gridColumn: '1 / -1' }}>Trade
                <select value={trade} onChange={(e) => setTrade(e.target.value)} required style={input}>
                  <option value="">Select trade…</option>
                  {VALID_TRADES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                </select>
              </label>
              <fieldset style={{ gridColumn: '1 / -1', border: '1px solid #eaeef2', borderRadius: 6, padding: 8, margin: 0 }}>
                <legend style={{ fontSize: 12, fontWeight: 600 }}>Locations (in your scope)</legend>
                {locations.length === 0 ? <span style={{ fontSize: 12, color: '#8c959f' }}>No locations in your scope.</span> : locations.map((l) => (
                  <label key={l.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, marginRight: 12 }}>
                    <input type="checkbox" checked={locationIds.includes(l.id)} onChange={() => toggleLoc(l.id)} /> {l.name}
                  </label>
                ))}
              </fieldset>
              {err && <p role="alert" style={{ gridColumn: '1 / -1', margin: 0, color: '#cf222e', fontSize: 13 }}>{err}</p>}
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" onClick={() => setOpen(false)} style={{ ...input, width: 'auto', cursor: 'pointer', background: 'white' }}>Cancel</button>
                <button type="submit" disabled={busy} style={{ padding: '8px 18px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{busy ? 'Sending…' : 'Send invite'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
