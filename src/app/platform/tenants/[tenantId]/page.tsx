// Tenant cockpit (Slice 6) — the operator's working detail screen for a single tenant.
// Read-first: locations, users (with the invite-state display from Slice 5b), requirements
// template, and billing state + recent invoice history (pulled live from Stripe — Stripe is the
// source of truth for invoices/payments, never reconstructed locally; billing_snapshots is
// location-count history, a different thing). Subscription STATUS is also a live Stripe pull
// (Phase B) — a stale locally-derived "active" would hide a failed card (past_due) from the one
// screen whose whole job is showing the operator the real payment state. One extra Stripe call
// per page load is proportionate here: this is a low-traffic, platform-operator-only screen,
// not a customer-facing hot path — already making one live call (invoices.list) per load.
//
// Controls: resend the first Admin's credential invite / the billing-setup link (closes the
// OPS-14 remainder), and edit the per-location rate / one-time setup fee (Phase B — see
// updateTenantRate/updateTenantSetupFee in provisioning.ts for the Stripe-consistency rules).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { getRawDb } from '@/lib/db/client';
import { getTenantById } from '@/lib/services/tenants';
import { listLocations } from '@/lib/services/locations';
import { listUsers } from '@/lib/services/users';
import { getTemplate } from '@/lib/requirements/templates';
import { defaultBillingProvider } from '@/lib/billing/stripe';
import { env } from '@/lib/env';
import { Card, CardHeader, CardTitle, CardBody, Badge, Table, THead, TBody, TR, TH, TD, Alert, type BadgeTone } from '@/components/ui';
import {
  ResendAdminInviteButton,
  ResendBillingLinkButton,
  EditRateControl,
  EditSetupFeeControl,
} from '@/components/platform/TenantCockpitActions';

export const dynamic = 'force-dynamic';

const LIFECYCLE: Record<string, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  provisioning: { tone: 'info', label: 'Provisioning' },
  suspended: { tone: 'attention', label: 'Suspended' },
  offboarded: { tone: 'neutral', label: 'Offboarded' },
};

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', district_manager: 'District Manager', store_manager: 'Store Manager' };

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-0">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="text-sm font-semibold text-fg">{children}</span>
    </div>
  );
}

export default async function TenantDetailPage({ params }: { params: { tenantId: string } }) {
  const db = getRawDb();
  const tenant = getTenantById(db, params.tenantId);
  if (!tenant) notFound();

  const lc = LIFECYCLE[tenant.lifecycle_state] ?? { tone: 'neutral' as BadgeTone, label: tenant.lifecycle_state };
  const scope = { locationIds: null, regionIds: null };
  const locations = listLocations(db, tenant.id, scope);
  const users = listUsers(db, tenant.id, scope);
  const template = tenant.applied_template_id ? getTemplate(db, tenant.applied_template_id) : null;

  const isRealStripe = !!env.billing.stripeSecretKey;
  const invoices = tenant.stripe_customer_id
    ? await defaultBillingProvider.listRecentInvoices({ customerId: tenant.stripe_customer_id, limit: 5 })
    : [];
  const subscriptionStatus = tenant.stripe_subscription_id
    ? (await defaultBillingProvider.getSubscriptionStatus({ subscriptionId: tenant.stripe_subscription_id })).status
    : null;
  const dashboardBase = env.billing.stripeSecretKey.startsWith('sk_live_')
    ? 'https://dashboard.stripe.com/customers'
    : 'https://dashboard.stripe.com/test/customers';
  const SUBSCRIPTION_STATUS_TONE: Record<string, BadgeTone> = {
    active: 'success', trialing: 'success',
    past_due: 'attention', unpaid: 'attention', incomplete: 'attention',
    canceled: 'neutral', incomplete_expired: 'neutral', paused: 'neutral',
  };

  return (
    <div className="mx-auto max-w-[960px] px-6 py-8">
      <Link href="/platform" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-fg-muted hover:text-fg">
        <ArrowLeft size={15} strokeWidth={2.5} /> Fleet
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">{tenant.name}</h1>
        <Badge tone={lc.tone}>{lc.label}</Badge>
        {tenant.slug && <span className="text-sm text-fg-muted">({tenant.slug})</span>}
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Tenant</CardTitle></CardHeader>
          <CardBody>
            <Row label="Tenant ID"><span className="font-mono text-xs">{tenant.id}</span></Row>
            <Row label="Created">{shortDate(tenant.created_at)}</Row>
            <Row label="Locations">{locations.filter((l) => l.status === 'active').length} active{locations.some((l) => l.status !== 'active') ? ` (${locations.length} total)` : ''}</Row>
            <Row label="Requirements template">{template ? template.name : tenant.applied_template_id ? `Unknown (${tenant.applied_template_id})` : '—'}</Row>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Billing</CardTitle></CardHeader>
          <CardBody>
            <Row label="Per-location rate">{money(tenant.monthly_rate_cents)}/mo</Row>
            <Row label="Setup fee">{tenant.setup_fee_cents ? money(tenant.setup_fee_cents) : 'None'}</Row>
            <Row label="Stripe customer">{tenant.stripe_customer_id ? <span className="font-mono text-xs">{tenant.stripe_customer_id}</span> : 'Not attached'}</Row>
            <Row label="Subscription">
              {tenant.stripe_subscription_id ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="font-mono text-xs">{tenant.stripe_subscription_id}</span>
                  {subscriptionStatus && <Badge tone={SUBSCRIPTION_STATUS_TONE[subscriptionStatus] ?? 'neutral'}>{subscriptionStatus}</Badge>}
                </span>
              ) : 'None'}
            </Row>
            {tenant.stripe_customer_id && isRealStripe && (
              <a
                href={`${dashboardBase}/${tenant.stripe_customer_id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-info hover:underline"
              >
                View in Stripe Dashboard <ExternalLink size={13} strokeWidth={2.5} />
              </a>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Edit per-location rate</CardTitle></CardHeader>
          <CardBody>
            <EditRateControl tenantId={tenant.id} currentCents={tenant.monthly_rate_cents} hasLiveSubscription={!!tenant.stripe_subscription_id} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Edit setup fee</CardTitle></CardHeader>
          <CardBody>
            <EditSetupFeeControl tenantId={tenant.id} currentCents={tenant.setup_fee_cents} blocked={!!tenant.stripe_subscription_id} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Resend first-Admin invite</CardTitle></CardHeader>
          <CardBody>
            <p className="mb-3 text-sm text-fg-muted">
              For a first Admin who never accepted their credential-set link, or lost it.
            </p>
            <ResendAdminInviteButton tenantId={tenant.id} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Resend billing-setup link</CardTitle></CardHeader>
          <CardBody>
            <p className="mb-3 text-sm text-fg-muted">
              For an operator who lost the card-entry link before sending it to the customer.
            </p>
            <ResendBillingLinkButton tenantId={tenant.id} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-5">
        <Card>
          <CardHeader><CardTitle>Recent invoices</CardTitle></CardHeader>
          <CardBody>
            {!tenant.stripe_customer_id ? (
              <p className="text-sm text-fg-muted">No Stripe customer attached yet.</p>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-fg-muted">No invoices yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR><TH>Date</TH><TH>Status</TH><TH>Amount paid</TH><TH aria-hidden /></TR>
                </THead>
                <TBody>
                  {invoices.map((inv) => (
                    <TR key={inv.id}>
                      <TD>{shortDate(inv.createdAt)}</TD>
                      <TD className="capitalize">{inv.status ?? '—'}</TD>
                      <TD>{money(inv.amountPaidCents)}</TD>
                      <TD>
                        {inv.hostedInvoiceUrl && (
                          <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-info hover:underline">
                            View
                          </a>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5">
        <Card>
          <CardHeader><CardTitle>Locations ({locations.length})</CardTitle></CardHeader>
          <CardBody>
            {locations.length === 0 ? <p className="text-sm text-fg-muted">No locations yet.</p> : (
              <Table>
                <THead><TR><TH>Name</TH><TH>Region</TH><TH>Status</TH></TR></THead>
                <TBody>
                  {locations.map((l) => (
                    <TR key={l.id}>
                      <TD>{l.name}</TD>
                      <TD>{l.region_name ?? '—'}</TD>
                      <TD><Badge tone={l.status === 'active' ? 'success' : 'neutral'}>{l.status}</Badge></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5">
        <Card>
          <CardHeader><CardTitle>Users ({users.length})</CardTitle></CardHeader>
          <CardBody>
            {users.length === 0 ? <p className="text-sm text-fg-muted">No users yet.</p> : (
              <Table>
                <THead><TR><TH>Name</TH><TH>Email</TH><TH>Role</TH><TH>Status</TH></TR></THead>
                <TBody>
                  {users.map((u) => (
                    <TR key={u.id}>
                      <TD>{u.name}</TD>
                      <TD className="text-fg-muted">{u.email}</TD>
                      <TD>{ROLE_LABEL[u.role] ?? u.role}</TD>
                      <TD>
                        <Badge tone={u.status === 'disabled' ? 'danger' : u.status === 'invited' ? 'attention' : 'success'}>{u.status}</Badge>
                        {u.status === 'invited' && (
                          <span className="ml-1.5 text-xs text-fg-muted">{u.invite_sent_at ? 'link sent' : 'no link sent'}</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      {!isRealStripe && (
        <div className="mt-5">
          <Alert tone="info">Dev mode (no STRIPE_SECRET_KEY) — billing figures are from the NoOp provider; no real invoices or dashboard link.</Alert>
        </div>
      )}
    </div>
  );
}
