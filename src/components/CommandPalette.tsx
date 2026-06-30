'use client';

// Global command palette (Cmd-K / Ctrl-K, or the header search icon). Modal overlay — does not
// navigate away until a result is chosen. Results are grouped by type (Vendors, Locations,
// Users), max 10 each; empty query shows recently-viewed. Keyboard: ↑/↓ move, Enter selects,
// Esc closes. Server does the scope clamp (/api/search); this is presentation + interaction.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface VendorHit { id: string; name: string; trade: string }
interface LocationHit { id: string; name: string; region: string | null }
interface UserHit { id: string; name: string; email: string; role: string }
interface Results { query: string; recent: boolean; vendors: VendorHit[]; locations: LocationHit[]; users: UserHit[] }

type Flat = { kind: 'vendor' | 'location' | 'user'; id: string; label: string; sub: string; href: string };

function flatten(r: Results): Flat[] {
  return [
    ...r.vendors.map((v) => ({ kind: 'vendor' as const, id: v.id, label: v.name, sub: v.trade.replace(/_/g, ' '), href: `/vendors/${v.id}` })),
    ...r.locations.map((l) => ({ kind: 'location' as const, id: l.id, label: l.name, sub: l.region ?? '', href: `/locations/${l.id}` })),
    ...r.users.map((u) => ({ kind: 'user' as const, id: u.id, label: u.name, sub: `${u.email} · ${u.role.replace(/_/g, ' ')}`, href: `/settings/users` })),
  ];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd-K / Ctrl-K toggles; header "search" button dispatches the same custom event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('uc:open-search', onOpen as EventListener);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('uc:open-search', onOpen as EventListener); };
  }, []);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); else { setQ(''); setResults(null); setActive(0); } }, [open]);

  // Fetch results (debounced) whenever the query changes while open.
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (res.ok) { setResults((await res.json()).data as Results); setActive(0); }
      } catch { /* ignore */ }
    }, 120);
    return () => clearTimeout(h);
  }, [q, open]);

  const flat = useMemo(() => (results ? flatten(results) : []), [results]);
  const select = useCallback((f: Flat | undefined) => { if (f) { setOpen(false); window.location.assign(f.href); } }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(flat.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); select(flat[active]); }
  };

  if (!open) return null;

  let idx = -1;
  const group = (title: string, items: Flat[]) => items.length === 0 ? null : (
    <div key={title}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#8c959f', textTransform: 'uppercase', padding: '8px 12px 2px' }}>{title}</div>
      {items.map((f) => { idx++; const i = idx; return (
        <div key={f.kind + f.id} onMouseEnter={() => setActive(i)} onClick={() => select(f)}
          style={{ padding: '8px 12px', cursor: 'pointer', background: i === active ? '#ddf4ff' : 'transparent', borderRadius: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{f.label}</div>
          {f.sub && <div style={{ fontSize: 12, color: '#57606a', textTransform: 'capitalize' }}>{f.sub}</div>}
        </div>
      ); })}
    </div>
  );

  const empty = results && flat.length === 0;
  return (
    <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh', zIndex: 1000, fontFamily: 'system-ui, sans-serif' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', background: 'white', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Search vendors and locations…"
          style={{ width: '100%', padding: '14px 16px', border: 'none', borderBottom: '1px solid #eaeef2', fontSize: 15, outline: 'none' }} />
        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: 6 }}>
          {results?.recent && flat.length > 0 && <div style={{ fontSize: 11, color: '#8c959f', padding: '6px 12px 0' }}>Recently viewed</div>}
          {results && group('Vendors', flat.filter((f) => f.kind === 'vendor'))}
          {results && group('Locations', flat.filter((f) => f.kind === 'location'))}
          {results && group('Users', flat.filter((f) => f.kind === 'user'))}
          {empty && (
            <div style={{ padding: '18px 12px', color: '#57606a', fontSize: 14 }}>
              {q ? `No vendors or locations match “${q}” in your scope.` : 'Type to search vendors and locations.'}
            </div>
          )}
        </div>
        <div style={{ borderTop: '1px solid #eaeef2', padding: '6px 12px', fontSize: 11, color: '#8c959f' }}>↑↓ to navigate · ↵ to open · esc to close</div>
      </div>
    </div>
  );
}
