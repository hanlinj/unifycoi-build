'use client';

// Design-system gallery (Phase 12 Slice 1) — eyeball every primitive in every variant.
// Dev/reference surface, not linked in nav. Renders bare (no tenant chrome) with no session.

import React from 'react';
import {
  Button, Input, Textarea, Select, FormField,
  Card, CardHeader, CardTitle, CardBody, StatCard,
  Badge, Table, THead, TBody, TR, TH, TD,
  Alert, Modal, Tabs, ActionRow,
} from '@/components/ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}

const SWATCHES = ['canvas', 'surface', 'border', 'fg', 'fg-muted', 'accent', 'success', 'attention', 'danger'];

export default function GalleryPage() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState('review');

  return (
    <div className="mx-auto max-w-5xl bg-canvas p-8 text-fg">
      <h1 className="text-2xl font-semibold">Design system</h1>
      <p className="mt-1 text-sm text-fg-muted">Phase 12 · Slice 1 — token layer + primitives. Clean, light B2B ops direction.</p>

      <div className="mt-8 flex flex-col gap-10">
        <Section title="Tokens">
          <div className="flex flex-wrap gap-3">
            {SWATCHES.map((c) => (
              <div key={c} className="flex flex-col items-center gap-1">
                <div className={`h-12 w-12 rounded-md border border-border bg-${c}`} />
                <span className="text-xs text-fg-muted">{c}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Provision tenant</Button>
            <Button variant="success">Approve</Button>
            <Button variant="danger">Reject</Button>
            <Button variant="default">Cancel</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="primary" disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="Form controls">
          <div className="grid max-w-md gap-3">
            <FormField label="Tenant name" htmlFor="tn" required help="Legal operator name.">
              <Input id="tn" placeholder="Storage Star" />
            </FormField>
            <FormField label="Timezone" htmlFor="tz" required>
              <Select id="tz"><option>America/Los_Angeles</option><option>America/Chicago</option></Select>
            </FormField>
            <FormField label="Notes" htmlFor="nt"><Textarea id="nt" placeholder="Optional" /></FormField>
            <FormField label="Per-location price" htmlFor="pr" error="Must be at least $1.00.">
              <Input id="pr" defaultValue="0" />
            </FormField>
          </div>
        </Section>

        <Section title="Stat cards">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Compliant vendors" value="94%" delta="▲ 3 this month" selected />
            <StatCard label="Expiring ≤30d" value="7" />
            <StatCard label="Awaiting review" value="12" />
            <StatCard label="Expired" value="2" />
          </div>
        </Section>

        <Section title="Action areas (Command Center pattern)">
          <Card>
            <CardHeader><CardTitle>Needs your attention</CardTitle></CardHeader>
            <div className="divide-y divide-border-muted">
              <ActionRow icon="⚠" title="2 vendors expired" description="pulled from hireable" />
              <ActionRow icon="⏳" title="7 policies expiring" description="within 30 days" />
              <ActionRow icon="📄" title="12 submissions" description="awaiting your review" />
            </div>
          </Card>
        </Section>

        <Section title="Badges / status pills">
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">Approved</Badge>
            <Badge tone="attention">Expiring 7d</Badge>
            <Badge tone="danger">Expired</Badge>
            <Badge tone="accent">Under review</Badge>
            <Badge tone="neutral">Onboarding</Badge>
          </div>
        </Section>

        <Section title="Tabs">
          <Tabs
            tabs={[{ id: 'review', label: 'To review', count: 12 }, { id: 'all', label: 'All vendors', count: 148 }]}
            value={tab}
            onChange={setTab}
          />
          <p className="text-sm text-fg-muted">Active tab: {tab}</p>
        </Section>

        <Section title="Table">
          <Card>
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
                <TR><TD>Acme Plumbing</TD><TD>Plumbing</TD><TD><Badge tone="success">Approved</Badge></TD><TD>Aug 15, 2026</TD><TD className="text-right">⋯</TD></TR>
                <TR><TD>Bright Electric</TD><TD>Electrical</TD><TD><Badge tone="attention">Expiring 7d</Badge></TD><TD>Jul 10, 2026</TD><TD className="text-right">⋯</TD></TR>
                <TR><TD>Cool HVAC</TD><TD>HVAC</TD><TD><Badge tone="danger">Expired</Badge></TD><TD>Jun 1, 2026</TD><TD className="text-right">⋯</TD></TR>
              </TBody>
            </Table>
          </Card>
        </Section>

        <Section title="Alerts">
          <div className="flex flex-col gap-2">
            <Alert tone="info" title="Heads up">A renewal is due soon.</Alert>
            <Alert tone="success" title="Provisioned">Storage Star is active.</Alert>
            <Alert tone="attention" title="Unreconciled billing">Location count changed.</Alert>
            <Alert tone="danger" title="Decrypt failure">A Sensitive value was unreadable.</Alert>
          </div>
        </Section>

        <Section title="Modal">
          <Button variant="primary" onClick={() => setOpen(true)}>Open modal</Button>
          <Modal
            open={open}
            onClose={() => setOpen(false)}
            title="Confirm provisioning"
            footer={<><Button variant="default" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => setOpen(false)}>Provision</Button></>}
          >
            <p className="text-sm text-fg-muted">This creates the tenant, first Admin, and Stripe customer.</p>
          </Modal>
        </Section>
      </div>
    </div>
  );
}
