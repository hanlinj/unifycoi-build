// /users — User Management (User_Management.md). Admin (org-wide) + District (their region).
// Store Managers cannot manage users. Lists users with role/status/scope; invite + edit via the
// existing Phase 2/8 endpoints. District sees only manageable users + Admins marked unmanageable.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { InviteUserForm, UserRowActions } from './UsersClient';

export const dynamic = 'force-dynamic';

interface ManagedUser { id: string; email: string; name: string; role: string; status: string; invite_sent_at: string | null; regionIds: string[]; locationIds: string[]; manageable: boolean }
interface Loc { id: string; name: string; region_id: string | null; region_name: string | null }

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', district_manager: 'District Manager', store_manager: 'Store Manager' };
const ROLES = ['admin', 'district_manager', 'store_manager'];
const STATUSES = ['invited', 'active', 'disabled'];

async function fetchJson(base: string, p: string, h: Headers): Promise<{ status: number; data?: unknown }> {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() }, cache: 'no-store' });
  if (!res.ok) return { status: res.status };
  return { status: res.status, data: (await res.json()).data };
}

export default async function UsersPage({ searchParams }: { searchParams: { role?: string; status?: string } }) {
  const h = headers();
  const base = requestBaseUrl(h);

  const usersRes = await fetchJson(base, '/api/users', h);
  if (usersRes.status === 401) redirect('/login');
  if (usersRes.status === 403) redirect('/'); // store managers / unauthorized
  if (!usersRes.data) return <main style={wrap}><p>Failed to load users.</p></main>;
  let users = usersRes.data as ManagedUser[];

  const locsRes = await fetchJson(base, '/api/locations', h);
  const locations = (Array.isArray(locsRes.data) ? locsRes.data : []) as Loc[];
  const meRes = await fetchJson(base, '/api/auth/me', h);
  const callerRole = (meRes.data as { role?: string })?.role ?? 'admin';

  const locName = (id: string) => locations.find((l) => l.id === id)?.name ?? id;
  const regionMap = new Map<string, string>();
  for (const l of locations) if (l.region_id && l.region_name) regionMap.set(l.region_id, l.region_name);
  const regions = [...regionMap.entries()].map(([id, name]) => ({ id, name }));
  const regionName = (id: string) => regionMap.get(id) ?? id;

  const roleFilter = searchParams.role && ROLES.includes(searchParams.role) ? searchParams.role : null;
  const statusFilter = searchParams.status && STATUSES.includes(searchParams.status) ? searchParams.status : null;
  if (roleFilter) users = users.filter((u) => u.role === roleFilter);
  if (statusFilter) users = users.filter((u) => u.status === statusFilter);

  const chipHref = (next: { role?: string | null; status?: string | null }) => {
    const p = new URLSearchParams();
    const r = next.role === undefined ? roleFilter : next.role; const s = next.status === undefined ? statusFilter : next.status;
    if (r) p.set('role', r); if (s) p.set('status', s);
    const q = p.toString(); return `/users${q ? `?${q}` : ''}`;
  };
  const chip = (active: boolean): React.CSSProperties => ({ padding: '3px 10px', borderRadius: 999, fontSize: 12, textDecoration: 'none', border: '1px solid #d0d7de', background: active ? '#0969da' : 'white', color: active ? 'white' : '#24292f', fontWeight: active ? 600 : 400 });

  return (
    <main style={wrap}>
      <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>Users</h1>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#57606a' }}>
        {callerRole === 'admin' ? 'Manage internal users org-wide.' : 'Manage users in your region. Admins are shown but managed only by an Admin.'}
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#57606a' }}>Role</span>
          <a href={chipHref({ role: null })} style={chip(!roleFilter)}>All</a>
          {ROLES.map((r) => <a key={r} href={chipHref({ role: r })} style={chip(roleFilter === r)}>{ROLE_LABEL[r]}</a>)}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#57606a' }}>Status</span>
          <a href={chipHref({ status: null })} style={chip(!statusFilter)}>All</a>
          {STATUSES.map((s) => <a key={s} href={chipHref({ status: s })} style={chip(statusFilter === s)}>{s}</a>)}
        </div>
      </div>

      {users.length === 0 ? <p style={{ fontSize: 13, color: '#57606a' }}>No users match the filters.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: '#f6f8fa', textAlign: 'left' }}>
            <th style={th}>Name</th><th style={th}>Email</th><th style={th}>Role</th><th style={th}>Status</th><th style={th}>Scope</th><th style={th}>Actions</th>
          </tr></thead>
          <tbody>
            {users.map((u) => {
              const scopeText = u.role === 'admin' ? 'org-wide'
                : u.role === 'district_manager' ? (u.regionIds.map(regionName).join(', ') || '—')
                : (u.locationIds.map(locName).join(', ') || '—');
              return (
                <tr key={u.id} style={{ borderTop: '1px solid #f0f3f6' }}>
                  <td style={td}>{u.name}</td>
                  <td style={{ ...td, color: '#57606a' }}>{u.email}</td>
                  <td style={td}>{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td style={{ ...td, color: u.status === 'disabled' ? '#cf222e' : u.status === 'invited' ? '#9a6700' : '#1a7f37', fontWeight: 600 }}>
                    {u.status}
                    {u.status === 'invited' && (
                      <span style={{ display: 'block', fontSize: 11, color: '#8c959f', fontWeight: 400 }}>
                        {u.invite_sent_at ? 'link sent' : 'no link sent'}
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, color: '#57606a' }}>{scopeText}</td>
                  <td style={td}>
                    {u.manageable
                      ? <UserRowActions user={{ id: u.id, role: u.role, status: u.status, inviteSentAt: u.invite_sent_at, regionIds: u.regionIds, locationIds: u.locationIds }} regions={regions} locations={locations.map((l) => ({ id: l.id, name: l.name }))} />
                      : <span style={{ fontSize: 12, color: '#8c959f' }}>Admin — not manageable by you</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <InviteUserForm callerRole={callerRole} regions={regions} locations={locations.map((l) => ({ id: l.id, name: l.name }))} />
    </main>
  );
}

const wrap: React.CSSProperties = { maxWidth: 980, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif', color: '#24292f' };
const th: React.CSSProperties = { padding: '7px 10px', fontSize: 12, color: '#57606a', fontWeight: 600 };
const td: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'top' };
