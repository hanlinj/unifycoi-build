// Minimal read-only tenant detail — the destination for the fleet row "View details". Shows
// only what GET /api/platform/tenants/[id] (getTenantById) provides. This is a STUB: Slice 6
// (tenant cockpit) expands it with locations, users, template, billing, and lifecycle controls.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getRawDb } from '@/lib/db/client';
import { getTenantById } from '@/lib/services/tenants';
import { Panel, Badge, type BadgeTone } from '@/components/ui';

export const dynamic = 'force-dynamic';

const LIFECYCLE: Record<string, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  provisioning: { tone: 'info', label: 'Provisioning' },
  suspended: { tone: 'attention', label: 'Suspended' },
  offboarded: { tone: 'neutral', label: 'Offboarded' },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-0">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="text-sm font-semibold text-fg">{children}</span>
    </div>
  );
}

export default function TenantDetailPage({ params }: { params: { tenantId: string } }) {
  const tenant = getTenantById(getRawDb(), params.tenantId);
  if (!tenant) notFound();

  const lc = LIFECYCLE[tenant.lifecycle_state] ?? { tone: 'neutral' as BadgeTone, label: tenant.lifecycle_state };

  return (
    <div className="mx-auto max-w-[720px] px-6 py-8">
      <Link href="/platform" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-fg-muted hover:text-fg">
        <ArrowLeft size={15} strokeWidth={2.5} /> Fleet
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">{tenant.name}</h1>
        <Badge tone={lc.tone}>{lc.label}</Badge>
      </header>

      <Panel>
        <Row label="Tenant ID"><span className="font-mono text-xs">{tenant.id}</span></Row>
        <Row label="Lifecycle">{lc.label}</Row>
        <Row label="Monthly rate">${(tenant.monthly_rate_cents / 100).toLocaleString('en-US')}/mo per location</Row>
        <Row label="Created">{new Date(tenant.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</Row>
      </Panel>

      <p className="mt-4 text-xs text-fg-muted">
        Locations, users, requirements template, billing, and lifecycle controls arrive with the tenant cockpit.
      </p>
    </div>
  );
}
