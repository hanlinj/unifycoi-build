'use client';

// Design-system gallery (Phase 12 Slice 1, restored blue palette — ADR-012-11) — eyeball every
// primitive (refdoc/unifycoi-design-system.html). Dev/reference surface, not linked in nav.

import React from 'react';
import { AlertTriangle, Clock, FileText, Hexagon } from 'lucide-react';
import {
  Button, Input, Select, FormField,
  Panel, StatCard, Badge,
  Table, THead, TBody, TR, TH, TD,
  Alert, Modal, Tabs, ActionRow,
} from '@/components/ui';

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-[18px] flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted after:h-px after:flex-1 after:bg-border after:content-['']">
      {children}
    </p>
  );
}

export default function GalleryPage() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState('review');

  return (
    <div className="ds-canvas min-h-screen font-sans text-fg">
      <div className="mx-auto max-w-[1120px] px-6 py-10">
        <header className="mb-7 flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-ctl bg-action">
              <Hexagon size={20} strokeWidth={2} className="text-white" />
            </span>
            <div>
              <h1 className="text-[22px] font-extrabold leading-none tracking-[-0.02em]">UnifyCOI · Design system</h1>
              <div className="mt-1 text-[13px] font-medium text-fg-muted">Phase 12 · Slice 1 — tokens + primitives.</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-3 py-[7px] text-xs font-bold text-accent-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-ink" /> Blue ops theme
          </span>
        </header>

        <div className="flex flex-col gap-[22px]">
          <Panel>
            <Eyebrow>Buttons</Eyebrow>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary">Provision tenant</Button>
              <Button variant="accent">Approve</Button>
              <Button variant="danger">Reject</Button>
              <Button variant="outline">Cancel</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="primary" size="sm">Small</Button>
              <Button variant="primary" disabled>Disabled</Button>
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Form controls</Eyebrow>
            <div className="flex max-w-[440px] flex-col gap-5">
              <FormField label="Tenant name" htmlFor="tn" required help="Legal operator name.">
                <Input id="tn" defaultValue="Storage Star" />
              </FormField>
              <FormField label="Timezone" htmlFor="tz" required>
                <Select id="tz"><option>America/Los_Angeles</option><option>America/Chicago</option><option>America/New_York</option></Select>
              </FormField>
              <FormField label="Per-location price" htmlFor="pr" error="Must be at least $1.00.">
                <Input id="pr" defaultValue="0" aria-invalid />
              </FormField>
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Stat cards</Eyebrow>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatCard feature label="Compliant vendors" value="94%" delta="▲ 3 this month" />
              <StatCard label="Expiring ≤30d" value="7" delta="policies" />
              <StatCard label="Awaiting review" value="12" delta="submissions" />
              <StatCard label="Expired" value="2" delta="needs action" deltaTone="danger" />
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Action areas · command center</Eyebrow>
            <h3 className="mb-3.5 text-[15px] font-bold">Needs your attention</h3>
            <div className="divide-y divide-border">
              <ActionRow tone="danger" icon={<AlertTriangle size={18} strokeWidth={2} />} title="2 vendors expired" description="pulled from hireable" />
              <ActionRow tone="attention" icon={<Clock size={18} strokeWidth={2} />} title="7 policies expiring" description="within 30 days" />
              <ActionRow tone="info" icon={<FileText size={18} strokeWidth={2} />} title="12 submissions" description="awaiting your review" />
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Status pills</Eyebrow>
            <div className="flex flex-wrap gap-2.5">
              <Badge tone="success">Approved</Badge>
              <Badge tone="attention">Expiring 7d</Badge>
              <Badge tone="danger">Expired</Badge>
              <Badge tone="info">Under review</Badge>
              <Badge tone="neutral">Onboarding</Badge>
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Tabs &amp; table</Eyebrow>
            <div className="mb-[22px]">
              <Tabs value={tab} onChange={setTab} tabs={[{ id: 'review', label: 'To review', count: 12 }, { id: 'all', label: 'All vendors', count: 148 }]} />
            </div>
            <Table>
              <THead>
                <TR>
                  <TH sort="asc">Vendor</TH>
                  <TH>Trade</TH>
                  <TH sort={null}>Status</TH>
                  <TH>Expires</TH>
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                <TR><TD className="font-semibold">Acme Plumbing</TD><TD className="text-fg-muted">Plumbing</TD><TD><Badge tone="success">Approved</Badge></TD><TD className="tabular-nums">Aug 15, 2026</TD><TD className="text-right text-[#C3C4CA]">···</TD></TR>
                <TR><TD className="font-semibold">Bright Electric</TD><TD className="text-fg-muted">Electrical</TD><TD><Badge tone="attention">Expiring 7d</Badge></TD><TD className="tabular-nums">Jul 10, 2026</TD><TD className="text-right text-[#C3C4CA]">···</TD></TR>
                <TR><TD className="font-semibold">Cool HVAC</TD><TD className="text-fg-muted">HVAC</TD><TD><Badge tone="danger">Expired</Badge></TD><TD className="tabular-nums">Jun 1, 2026</TD><TD className="text-right text-[#C3C4CA]">···</TD></TR>
              </TBody>
            </Table>
          </Panel>

          <Panel>
            <Eyebrow>Alerts</Eyebrow>
            <div className="flex flex-col gap-3">
              <Alert tone="info" title="Heads up">A renewal is due soon.</Alert>
              <Alert tone="success" title="Provisioned">Storage Star is active.</Alert>
              <Alert tone="attention" title="Unreconciled billing">Location count changed.</Alert>
              <Alert tone="danger" title="Decrypt failure">A Sensitive value was unreadable.</Alert>
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Modal</Eyebrow>
            <Button variant="primary" onClick={() => setOpen(true)}>Open modal</Button>
            <Modal
              open={open}
              onClose={() => setOpen(false)}
              title="Confirm provisioning"
              footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => setOpen(false)}>Provision</Button></>}
            >
              This creates the tenant, first Admin, and Stripe customer.
            </Modal>
          </Panel>
        </div>
      </div>
    </div>
  );
}
