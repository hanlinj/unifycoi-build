'use client';

// Fleet roster (Platform_Super_Admin_Console Zone 2) over GET /api/platform/tenants
// (listTenants). Shows what the API provides — name, lifecycle status, monthly rate, created.
// NOTE: per-tenant location count + computed monthly VALUE (rate × billable locations) need a
// listTenants extension; deferred to the billing/detail slices (not invented here).

import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { Tenant } from '@/lib/services/tenants';
import { Panel, Table, THead, TBody, TR, TH, TD, Badge, Menu, MenuItem, Pagination, type BadgeTone } from '@/components/ui';

const PAGE_SIZE = 20;

const LIFECYCLE: Record<string, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  provisioning: { tone: 'info', label: 'Provisioning' },
  suspended: { tone: 'attention', label: 'Suspended' },
  offboarded: { tone: 'neutral', label: 'Offboarded' },
};

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}/mo`;
}
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function FleetRoster({ tenants }: { tenants: Tenant[] }) {
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(tenants.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const shown = tenants.slice(start, start + PAGE_SIZE);
  const summary = tenants.length === 0 ? '' : `${start + 1}–${start + shown.length} of ${tenants.length}`;

  return (
    <div className="mx-auto max-w-[1120px] px-6 py-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">Tenant fleet</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {tenants.length} {tenants.length === 1 ? 'tenant' : 'tenants'} across the platform.
        </p>
      </header>

      <Panel className="p-0">
        {tenants.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-fg-muted">No tenants yet. Provision your first customer to get started.</div>
        ) : (
          <>
            <div className="px-4 pt-4">
              <Table>
                <THead>
                  <TR>
                    <TH>Tenant</TH>
                    <TH>Status</TH>
                    <TH>Monthly rate</TH>
                    <TH>Created</TH>
                    <TH><span className="sr-only">Actions</span></TH>
                  </TR>
                </THead>
                <TBody>
                  {shown.map((t) => {
                    const lc = LIFECYCLE[t.lifecycle_state] ?? { tone: 'neutral' as BadgeTone, label: t.lifecycle_state };
                    return (
                      <TR key={t.id}>
                        <TD className="font-semibold">{t.name}</TD>
                        <TD><Badge tone={lc.tone}>{lc.label}</Badge></TD>
                        <TD className="tabular-nums text-fg-muted">{money(t.monthly_rate_cents)}</TD>
                        <TD className="tabular-nums text-fg-muted">{shortDate(t.created_at)}</TD>
                        <TD className="text-right">
                          <Menu
                            trigger={
                              <button aria-label={`Actions for ${t.name}`} className="grid h-8 w-8 place-items-center rounded-ctl text-fg-muted hover:bg-surface-2">
                                <MoreHorizontal size={18} />
                              </button>
                            }
                          >
                            <MenuItem href={`/platform/tenants/${t.id}`}>View details</MenuItem>
                          </Menu>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            <div className="border-t border-border px-4 py-3">
              <Pagination page={page} pageCount={pageCount} onPageChange={setPage} summary={summary} />
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
