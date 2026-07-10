'use client';

// The card-entry step (Slice 5a.1 — the go-live blocker). Card fields are rendered by Stripe's
// own PaymentElement — the card number is never entered into our own input, never touches our
// server. That's the PCI line, unchanged.
//
// Flow: confirmSetup (client-side, against the persisted SetupIntent) attaches the card. On
// success we POST just the (opaque, unguessable) billing-setup token to /api/billing/setup/confirm,
// which finalizes server-side: sets the default payment method and pays the tenant's open
// invoice. THAT route does not activate the tenant — activation stays exclusively the
// invoice.paid webhook's job (see stripe-webhook.ts), so there's only ever one activation path.
//
// Two distinct decline points exist and both are handled: a card can be rejected immediately at
// confirmSetup (e.g. Stripe's generic decline test card), or accepted by confirmSetup but fail
// when we actually try to charge the invoice a moment later (e.g. Stripe's "attaches fine,
// charge fails" test card) — see the checkpoint summary for which test card exercises which.

import React from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import * as s from './styles';

export function CardEntryForm({
  token,
  tenantName,
  clientSecret,
  publishableKey,
}: {
  token: string;
  tenantName: string;
  clientSecret: string;
  publishableKey: string;
}) {
  // Hooks must run unconditionally (Rules of Hooks) — compute this before any early return.
  const stripePromise = React.useMemo(() => (publishableKey ? loadStripe(publishableKey) : null), [publishableKey]);

  if (!publishableKey) {
    return (
      <main style={s.centeredPage}>
        <div style={s.centeredCard}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h1 style={s.heading}>Billing isn&rsquo;t configured</h1>
          <p style={s.body}>Stripe isn&rsquo;t set up in this environment yet. Contact support.</p>
        </div>
      </main>
    );
  }

  return (
    <main style={s.centeredPage}>
      <div style={s.card}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: '#111827' }}>Set up billing for {tenantName}</h1>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#57606a' }}>
          Enter a card below. It&rsquo;s handled entirely by Stripe — we never see or store the card number.
        </p>
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <InnerForm token={token} tenantName={tenantName} />
        </Elements>
      </div>
    </main>
  );
}

type Status = 'idle' | 'submitting' | 'succeeded' | 'declined';

function InnerForm({ token, tenantName }: { token: string; tenantName: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = React.useState<Status>('idle');
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setStatus('submitting');
    setError(null);

    const { error: confirmError } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required', // a card never needs the redirect leg
    });

    if (confirmError) {
      // Declined at the SetupIntent itself — the card was rejected outright, never attached.
      setStatus('declined');
      setError(confirmError.message ?? 'Your card was declined.');
      return;
    }

    // The card IS attached now. Ask the server to set it as default and pay the open invoice —
    // a SEPARATE decline point (card can attach fine but still fail to charge).
    try {
      const res = await fetch('/api/billing/setup/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      const data = (body as { data?: { paid?: boolean; error?: string } }).data;
      if (res.ok && data?.paid) {
        setStatus('succeeded');
      } else {
        setStatus('declined');
        setError(data?.error ?? (body as { error?: string }).error ?? 'Payment could not be completed.');
      }
    } catch {
      setStatus('declined');
      setError('Network error while finalizing — your card was saved; try submitting again.');
    }
  }

  if (status === 'succeeded') {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
        <p style={s.body}>
          Payment received. <strong>{tenantName}</strong> will activate automatically in a moment, and the Admin&rsquo;s
          invite will go out.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && <p role="alert" style={s.errorText}>{error}</p>}
      <button type="submit" disabled={!stripe || status === 'submitting'} style={s.button(status === 'submitting')}>
        {status === 'submitting' ? 'Processing…' : 'Save card & activate'}
      </button>
    </form>
  );
}
