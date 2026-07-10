'use client';

// Tenant cockpit resend controls (Slice 6). Both call existing token issuers
// (resendFirstAdminInvite / resendBillingSetupLink) — this component is just the UI: fire the
// request, show the returned link inline with a copy button. Same shape as the wizard's
// billing-setup-link display and the Users panel's Send/Resend invite.

import React from 'react';
import { Button, Input, Alert, FormField } from '@/components/ui';

function ResendLinkButton({
  label,
  endpoint,
}: {
  label: string;
  endpoint: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ inviteUrl: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      setResult((body as { data: { inviteUrl: string; expiresAt: string } }).data);
    } catch {
      setError('Network error — nothing was sent.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the link is still visible/selectable below.
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Button type="button" variant="outline" size="sm" onClick={send} disabled={busy}>
        {busy ? 'Sending…' : label}
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
      {result && (
        <FormField label="Link">
          <div className="flex gap-2">
            <Input readOnly value={result.inviteUrl} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </FormField>
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
