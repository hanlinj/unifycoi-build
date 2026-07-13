'use client';

// Tenant cockpit resend controls (Slice 6). Both call the real send endpoints
// (sendAdminInviteEmail / sendBillingSetupLinkEmail via their routes) — actually emails the
// link AND shows it inline with a copy button (the operator's alternate channel for
// Teams/text), the same "sent AND copyable" pattern as the provisioning wizard's completion
// step. The two endpoints return the link under different keys (inviteUrl vs
// billingSetupUrl) — this component reads whichever is present.

import React from 'react';
import { Button, Input, Alert, FormField } from '@/components/ui';

interface SendLinkResult {
  sent: boolean;
  recipientEmail: string;
  expiresAt: string;
  inviteUrl?: string;
  billingSetupUrl?: string;
  error?: string;
}

function ResendLinkButton({
  label,
  endpoint,
}: {
  label: string;
  endpoint: string;
}) {
  const [busy, setBusy] = React.useState(false);
  // Request-level failure (bad tenant state, network) — distinct from `result.error`, which is
  // a successful mint whose SEND then failed (still has a link to show/copy).
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SendLinkResult | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function send() {
    setBusy(true);
    setRequestError(null);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestError((body as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      setResult((body as { data: SendLinkResult }).data);
    } catch {
      setRequestError('Network error — nothing was sent.');
    } finally {
      setBusy(false);
    }
  }

  const link = result?.inviteUrl ?? result?.billingSetupUrl;

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the link is still visible/selectable below.
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* variant="primary": the default outline variant's border renders invisible (a Button.tsx
          CSS-ordering issue — border-transparent wins the cascade over border-border-strong
          regardless of class order) which reads as plain text, not a button. */}
      <Button type="button" variant="primary" size="sm" onClick={send} disabled={busy}>
        {busy ? 'Sending…' : label}
      </Button>
      {requestError && <Alert tone="danger">{requestError}</Alert>}
      {result && (
        <>
          {result.sent ? (
            <Alert tone="success">Sent to {result.recipientEmail}.</Alert>
          ) : (
            <Alert tone="danger">Could not send to {result.recipientEmail}. Error: {result.error}</Alert>
          )}
          {link && (
            <FormField label="Link">
              <div className="flex gap-2">
                <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
              </div>
            </FormField>
          )}
        </>
      )}
    </div>
  );
}

export function ResendAdminInviteButton({ tenantId }: { tenantId: string }) {
  return <ResendLinkButton label="Resend admin invite" endpoint={`/api/platform/tenants/${tenantId}/resend-admin-invite`} />;
}

export function ResendBillingLinkButton({ tenantId }: { tenantId: string }) {
  return <ResendLinkButton label="Resend billing-setup link" endpoint={`/api/platform/tenants/${tenantId}/resend-billing-link`} />;
}

/** "$90" / "90.5" → 9000 / 9050 cents. Returns null for blank/invalid input. */
function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function EditRateControl({ tenantId, currentCents, hasLiveSubscription }: { tenantId: string; currentCents: number; hasLiveSubscription: boolean }) {
  const [dollars, setDollars] = React.useState(String(currentCents / 100));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const cents = dollarsToCents(dollars);
  const valid = cents !== null;

  async function save() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/rate`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyRateCents: cents }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      const data = (body as { data: { pushedToStripe: boolean; error?: string } }).data;
      if (data.error) {
        // 200 but the Stripe push failed — the local rate was NOT changed either (see
        // updateTenantRate). Surface this as an error, not a silent success.
        setError(`Stripe did not accept the new rate — nothing changed: ${data.error}`);
        return;
      }
      setSuccess(data.pushedToStripe ? 'Rate updated — takes effect next billing cycle.' : 'Rate updated (no live subscription yet — will apply once billing attaches).');
    } catch {
      setError('Network error — the rate was not changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <Input inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} aria-invalid={!valid} aria-label="Per-location rate in dollars" />
        <Button type="button" onClick={save} disabled={busy || !valid}>{busy ? 'Saving…' : 'Save rate'}</Button>
      </div>
      {!valid && <Alert tone="attention">Enter a non-negative amount.</Alert>}
      {hasLiveSubscription && <p className="text-xs text-fg-muted">Takes effect next billing cycle — never a mid-month charge.</p>}
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
    </div>
  );
}

export function EditSetupFeeControl({ tenantId, currentCents, blocked }: { tenantId: string; currentCents: number | null; blocked: boolean }) {
  const [dollars, setDollars] = React.useState(currentCents ? String(currentCents / 100) : '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [blockedReason, setBlockedReason] = React.useState<string | null>(null);

  const blank = !dollars.trim();
  const cents = blank ? null : dollarsToCents(dollars);
  const valid = blank || cents !== null;

  async function save() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    setBlockedReason(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/setup-fee`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupFeeCents: cents }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      const data = (body as { data: { updated: boolean; blockedReason?: string } }).data;
      if (!data.updated) {
        setBlockedReason(data.blockedReason ?? 'Could not be changed.');
        return;
      }
      setSuccess('Setup fee updated.');
    } catch {
      setError('Network error — the setup fee was not changed.');
    } finally {
      setBusy(false);
    }
  }

  if (blocked) {
    return <Alert tone="attention">Already invoiced to Stripe at billing attach — cannot be changed after the fact.</Alert>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <Input inputMode="decimal" placeholder="None" value={dollars} onChange={(e) => setDollars(e.target.value)} aria-invalid={!valid} aria-label="One-time setup fee in dollars" />
        <Button type="button" onClick={save} disabled={busy || !valid}>{busy ? 'Saving…' : 'Save fee'}</Button>
      </div>
      {!valid && <Alert tone="attention">Enter a non-negative amount, or leave blank for none.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {blockedReason && <Alert tone="attention">{blockedReason}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
    </div>
  );
}
