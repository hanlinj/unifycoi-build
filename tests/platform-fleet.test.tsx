// Phase 12 · Slice 2 — platform shell + fleet roster. RTL/jsdom.
// Proves the fleet renders + paginates + row menu, the new primitives, the platform nav,
// and (load-bearing) that the tenant AppShell chrome does NOT leak onto /platform.

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu, MenuItem, Pagination } from '@/components/ui';
import { FleetRoster } from '@/components/platform/FleetRoster';
import { PLATFORM_NAV, isPlatformItemActive } from '@/lib/platform-nav';
import type { Tenant } from '@/lib/services/tenants';

const mk = (i: number, over: Partial<Tenant> = {}): Tenant => ({
  id: `t${i}`, name: `Tenant ${i}`, slug: `tenant-${i}`, lifecycle_state: 'active', monthly_rate_cents: 9000,
  created_at: '2026-06-01T00:00:00.000Z', ...over,
});

// ── platform nav (pure) ──────────────────────────────────────────────────────

describe('platform nav', () => {
  test('Tenants and Provisioning are built; Billing/Health/Settings are planned (soon)', () => {
    const byLabel = Object.fromEntries(PLATFORM_NAV.map((i) => [i.label, i]));
    expect(byLabel['Tenants'].soon).toBeUndefined();
    expect(byLabel['Provisioning'].soon).toBeUndefined();
    for (const l of ['Billing', 'Health', 'Settings']) expect(byLabel[l].soon).toBe(true);
  });
  test('Tenants owns the fleet + tenant-detail routes', () => {
    expect(isPlatformItemActive('/platform', '/platform')).toBe(true);
    expect(isPlatformItemActive('/platform/tenants/t1', '/platform')).toBe(true);
    expect(isPlatformItemActive('/platform/billing', '/platform')).toBe(false);
    expect(isPlatformItemActive('/platform/provisioning', '/platform/provisioning')).toBe(true);
  });
});

// ── primitives ───────────────────────────────────────────────────────────────

describe('Menu', () => {
  test('opens on trigger, exposes items, closes on item click', async () => {
    render(
      <Menu trigger={<button aria-label="Actions">⋯</button>}>
        <MenuItem href="/x">View details</MenuItem>
      </Menu>
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const item = screen.getByRole('menuitem', { name: 'View details' });
    expect(item).toHaveAttribute('href', '/x');
    await userEvent.click(item);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(); // closed after selection
  });
});

describe('Pagination', () => {
  test('prev disabled on page 1, page click fires onPageChange, single page hides controls', async () => {
    const onChange = jest.fn();
    const { rerender } = render(<Pagination page={1} pageCount={3} onPageChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(onChange).toHaveBeenCalledWith(2);
    rerender(<Pagination page={1} pageCount={1} onPageChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });
});

// ── fleet roster ─────────────────────────────────────────────────────────────

describe('FleetRoster', () => {
  test('renders tenant rows with status badge + monthly rate', () => {
    render(<FleetRoster tenants={[mk(1, { name: 'Storage Star', lifecycle_state: 'active' }), mk(2, { name: 'Cascade', lifecycle_state: 'provisioning' })]} />);
    expect(screen.getByText('Storage Star')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Provisioning')).toBeInTheDocument();
    expect(screen.getAllByText('$90/mo')).toHaveLength(2);
    expect(screen.getByText('2 tenants across the platform.')).toBeInTheDocument();
  });

  test('paginates at 20/page and page 2 shows the remainder', async () => {
    render(<FleetRoster tenants={Array.from({ length: 22 }, (_, i) => mk(i + 1))} />);
    expect(screen.getByText('Tenant 1')).toBeInTheDocument();
    expect(screen.queryByText('Tenant 21')).not.toBeInTheDocument(); // on page 2
    await userEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(screen.getByText('Tenant 21')).toBeInTheDocument();
    expect(screen.getByText('Tenant 22')).toBeInTheDocument();
    expect(screen.queryByText('Tenant 1')).not.toBeInTheDocument();
  });

  test('row menu links to the tenant detail page', async () => {
    render(<FleetRoster tenants={[mk(1, { id: 'abc', name: 'Storage Star' })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Storage Star' }));
    expect(screen.getByRole('menuitem', { name: 'View details' })).toHaveAttribute('href', '/platform/tenants/abc');
  });

  test('empty fleet shows an onboarding hint, no table', () => {
    render(<FleetRoster tenants={[]} />);
    expect(screen.getByText(/Provision your first customer/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ── chrome-leak: tenant AppShell must NOT render on /platform ─────────────────

describe('tenant chrome does not leak onto /platform', () => {
  const nav = { pathname: '/' };
  jest.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));

  afterEach(() => { (global.fetch as unknown) = undefined; });

  test('on /platform the tenant sidebar is absent; children render bare', async () => {
    nav.pathname = '/platform';
    const { AppShell } = await import('@/components/AppShell');
    render(<AppShell><div>platform child</div></AppShell>);
    expect(screen.getByText('platform child')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  test('positive control: on a tenant route the sidebar DOES render (proof is non-vacuous)', async () => {
    nav.pathname = '/command-center';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { type: 'tenant', role: 'admin', name: 'Ada' } }) }) as unknown as typeof fetch;
    const { AppShell } = await import('@/components/AppShell');
    render(<AppShell><div>tenant child</div></AppShell>);
    // The admin sidebar item appears once /api/auth/me resolves — proves the chrome mechanism
    // works, so the /platform "no chrome" assertion above is non-vacuous.
    const home = await screen.findByText('Home');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toContainElement(home);
  });
});
