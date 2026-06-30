'use client';

// The single tenant app shell: role-conditional sidebar + header chrome, wrapping every
// authenticated tenant surface. Hidden on /login, the public /v/* vendor flow, the root
// redirect, and /platform (per shouldShowChrome) — and for platform users (no tenant chrome).
// Mounts the CommandPalette so Cmd-K works everywhere in the shell.

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { navForRole, shouldShowChrome, isActive } from '@/lib/nav';
import { CommandPalette } from './CommandPalette';
import { InviteVendorModal } from './InviteVendorModal';

interface Me { type: 'tenant' | 'platform'; role: string; name: string; tenant_name?: string | null }
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', district_manager: 'District Manager', store_manager: 'Store Manager' };

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const chromePath = shouldShowChrome(pathname);
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!chromePath) { setLoaded(true); return; }
    let live = true;
    fetch('/api/auth/me').then(async (r) => {
      if (live) setMe(r.ok ? ((await r.json()).data as Me) : null);
    }).catch(() => {}).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [chromePath, pathname]);

  // No chrome: login, vendor token flow, root redirect, platform, or a non-tenant session.
  if (!chromePath || (loaded && (!me || me.type !== 'tenant'))) return <>{children}</>;

  const sections = me ? navForRole(me.role) : [];

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.assign('/login');
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', color: '#24292f' }}>
      <nav aria-label="Primary" style={{ width: 220, flexShrink: 0, background: '#f6f8fa', borderRight: '1px solid #e1e4e8', padding: '18px 12px', boxSizing: 'border-box' }}>
        <div style={{ fontWeight: 800, fontSize: 16, padding: '0 8px 16px' }}>UnifyCOI</div>
        {sections.map((s, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            {s.title && <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#8c959f', fontWeight: 600, padding: '0 8px 4px' }}>{s.title}</div>}
            {s.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <a key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                  style={{ display: 'block', padding: '7px 8px', borderRadius: 6, fontSize: 14, textDecoration: 'none', marginBottom: 2,
                    color: active ? '#0969da' : '#24292f', background: active ? '#ddf4ff' : 'transparent', fontWeight: active ? 600 : 400 }}>
                  {item.label}
                </a>
              );
            })}
          </div>
        ))}
      </nav>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ height: 52, flexShrink: 0, borderBottom: '1px solid #e1e4e8', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{me?.tenant_name ?? 'UnifyCOI'}</div>
          <div style={{ flex: 1 }} />
          <button onClick={() => window.dispatchEvent(new CustomEvent('uc:open-invite'))}
            style={{ border: 'none', background: '#1f883d', color: 'white', borderRadius: 6, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            + Invite vendor
          </button>
          <button aria-label="Search" title="Search (⌘K)" onClick={() => window.dispatchEvent(new CustomEvent('uc:open-search'))}
            style={{ border: '1px solid #d0d7de', background: 'white', borderRadius: 6, padding: '5px 10px', fontSize: 13, cursor: 'pointer', color: '#57606a' }}>
            🔍 Search <span style={{ color: '#8c959f' }}>⌘K</span>
          </button>
          <div style={{ fontSize: 13, textAlign: 'right' }}>
            <div style={{ fontWeight: 600 }}>{me?.name}</div>
            <div style={{ fontSize: 11, color: '#57606a' }}>{ROLE_LABEL[me?.role ?? ''] ?? me?.role}</div>
          </div>
          <button onClick={logout} style={{ border: '1px solid #d0d7de', background: 'white', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }}>Log out</button>
        </header>
        <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
      </div>

      <CommandPalette />
      <InviteVendorModal />
    </div>
  );
}
