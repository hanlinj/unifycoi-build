// /billing/setup — the card-entry page (Slice 5a.1, the go-live blocker). The operator sends
// this link right after provisioning (BEFORE the credential/invite link — that one only exists
// once the tenant activates). Async server component: resolves the billing-setup token,
// branches on the tenant's lifecycle_state (status-is-authoritative, same principle as the
// /reset-password page), and re-fetches a live SetupIntent client secret from Stripe — the one
// from the original provisioning response was never persisted and only ever existed once.

import { getDb } from '@/lib/db/client';
import { getTenantById } from '@/lib/services/tenants';
import { resolveBillingSetupToken } from '@/lib/services/password-reset';
import { defaultBillingProvider } from '@/lib/billing/stripe';
import { env } from '@/lib/env';
import { CardEntryForm } from './CardEntryForm';
import * as s from './styles';

export const dynamic = 'force-dynamic';

export default async function BillingSetupPage({ searchParams }: { searchParams: { token?: string } }) {
  const token = searchParams.token;
  const db = getDb();
  const peek = token ? await resolveBillingSetupToken(db, token) : { status: 'invalid' as const };

  if (peek.status === 'invalid') {
    return (
      <DeadEnd icon="⚠️" title="This link isn&rsquo;t valid">
        Double-check the link, or ask the operator who sent it for a fresh one.
      </DeadEnd>
    );
  }
  if (peek.status === 'expired') {
    return (
      <DeadEnd icon="⏱️" title="This link has expired">
        Contact the operator who sent it and ask them to resend it.
      </DeadEnd>
    );
  }

  const tenant = await getTenantById(db, peek.tenantId as string);
  if (!tenant) {
    return (
      <DeadEnd icon="⚠️" title="This link isn&rsquo;t valid">
        Double-check the link, or ask the operator who sent it for a fresh one.
      </DeadEnd>
    );
  }
  if (tenant.lifecycle_state === 'active') {
    return (
      <DeadEnd icon="✓" title="Billing is already set up">
        <strong>{tenant.name}</strong> is active — no further action is needed here.
      </DeadEnd>
    );
  }
  if (!tenant.stripe_customer_id || !tenant.stripe_setup_intent_id) {
    return (
      <DeadEnd icon="⚠️" title="Billing isn&rsquo;t ready yet">
        Ask the operator to complete (or retry) billing setup for this tenant before sending this link.
      </DeadEnd>
    );
  }

  const setupIntent = await defaultBillingProvider.retrieveSetupIntent({ setupIntentId: tenant.stripe_setup_intent_id });

  return (
    <CardEntryForm
      token={token as string}
      tenantName={tenant.name}
      clientSecret={setupIntent.clientSecret}
      publishableKey={env.billing.stripePublishableKey}
    />
  );
}

function DeadEnd({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <main style={s.centeredPage}>
      <div style={s.centeredCard}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{icon}</div>
        <h1 style={s.heading}>{title}</h1>
        <p style={s.body}>{children}</p>
      </div>
    </main>
  );
}
