'use client';

// The New Client Provisioning wizard (Phase 12 · Slice 4 — OPS-8 UI over the Slice 3 backend).
// Tenant(name/slug) → Admin(name/email, no password) → Locations → Requirements template →
// Timezone → Review → Provision → Billing attach.
//
// Credential model: the wizard never handles a password. The first Admin is created invited,
// and an invite token is minted immediately at provision time — the Result screen below shows
// the raw link for the operator to send out-of-band.
//
// Two-commit shape: Provision (the audited DB transaction) and Billing attach (customer +
// SetupIntent) are independent, separately retryable steps — POST /api/platform/provision
// returns billing.attached=false on a Stripe failure WITHOUT failing the whole request (the
// tenant is live, just unbilled). The Result panel shows that state explicitly and offers
// "Retry billing", which calls the exact same attachBilling() the initial attempt used (via
// /retry-billing) — never a dead end.

import React from 'react';
import { Panel, Card, CardBody, Button, Input, Select, FormField, Alert, Badge } from '@/components/ui';
import { isValidTimeZone } from '@/lib/time/zone';

export interface WizardTemplate {
  id: string;
  name: string;
}

interface LocationRow {
  name: string;
  address: string;
}

interface ProvisionResponse {
  tenant: { id: string; name: string; slug: string | null };
  adminUserId: string;
  locationIds: string[];
  billing: BillingAttachResponse;
  invite: { rawToken: string; inviteUrl: string; expiresAt: string };
}

interface BillingAttachResponse {
  attached: boolean;
  customerId: string | null;
  setupIntentClientSecret: string | null;
  error?: string;
}

const STEPS = ['tenant', 'admin', 'locations', 'template', 'timezone', 'review'] as const;
type Step = (typeof STEPS)[number];
const STEP_LABEL: Record<Step, string> = {
  tenant: 'Tenant', admin: 'Admin', locations: 'Locations', template: 'Template', timezone: 'Timezone', review: 'Review',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function timezoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

type SlugStatus = 'idle' | 'checking' | 'available' | 'taken' | 'error';

export function ProvisioningWizard({ templates }: { templates: WizardTemplate[] }) {
  const [stepIdx, setStepIdx] = React.useState(0);
  const step = STEPS[stepIdx];

  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [slugStatus, setSlugStatus] = React.useState<SlugStatus>('idle');

  const [adminName, setAdminName] = React.useState('');
  const [adminEmail, setAdminEmail] = React.useState('');

  const [locations, setLocations] = React.useState<LocationRow[]>([{ name: '', address: '' }]);

  const [templateId, setTemplateId] = React.useState(templates[0]?.id ?? '');

  const [timezone, setTimezone] = React.useState('');
  const [tzTouched, setTzTouched] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ProvisionResponse | null>(null);
  const [retrying, setRetrying] = React.useState(false);

  const tzList = React.useMemo(timezoneOptions, []);

  // Auto-derive the slug from name until the operator edits it directly.
  React.useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  // Live uniqueness pre-check (debounced) — so a collision is caught at the Tenant step, not
  // discovered as a 409 on final submit.
  React.useEffect(() => {
    if (!slug) { setSlugStatus('idle'); return; }
    if (!SLUG_RE.test(slug)) { setSlugStatus('error'); return; }
    setSlugStatus('checking');
    const handle = setTimeout(() => {
      fetch(`/api/platform/tenants/check-slug?slug=${encodeURIComponent(slug)}`)
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((body: { data: { available: boolean } }) => setSlugStatus(body.data.available ? 'available' : 'taken'))
        .catch(() => setSlugStatus('error'));
    }, 300);
    return () => clearTimeout(handle);
  }, [slug]);

  const tzValid = isValidTimeZone(timezone);
  const tzError = tzTouched && !tzValid ? 'Enter a valid IANA timezone, e.g. America/Chicago.' : null;

  const canAdvance: Record<Step, boolean> = {
    tenant: !!name.trim() && slugStatus === 'available',
    admin: !!adminName.trim() && EMAIL_RE.test(adminEmail),
    locations: true, // manual entry is optional at this step
    template: !!templateId,
    timezone: tzValid,
    review: true,
  };

  function goNext() {
    if (step === 'timezone') setTzTouched(true);
    if (!canAdvance[step]) return;
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  }
  function goBack() {
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  function updateLocation(i: number, patch: Partial<LocationRow>) {
    setLocations((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addLocation() {
    setLocations((rows) => [...rows, { name: '', address: '' }]);
  }
  function removeLocation(i: number) {
    setLocations((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function handleProvision() {
    // Final guard — timezone + slug must pass before submit, not surface as a failing DB
    // write. Both are already gated per-step; this catches a slug taken by someone else in
    // the interim between the Tenant step and Review.
    if (!isValidTimeZone(timezone)) { setSubmitError('Timezone is invalid — go back and fix it.'); setStepIdx(STEPS.indexOf('timezone')); return; }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/platform/tenants/check-slug?slug=' + encodeURIComponent(slug));
      const check = res.ok ? ((await res.json()) as { data: { available: boolean } }) : null;
      if (!check?.data.available) {
        setSubmitError(`Slug "${slug}" is no longer available — go back and choose another.`);
        setStepIdx(STEPS.indexOf('tenant'));
        setSubmitting(false);
        return;
      }

      const body = {
        name: name.trim(),
        slug,
        timezone,
        firstAdmin: { name: adminName.trim(), email: adminEmail.trim() },
        locations: locations.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), address: l.address.trim() || undefined })),
        templateId,
      };
      const provisionRes = await fetch('/api/platform/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const provisionBody = await provisionRes.json().catch(() => ({}));
      if (!provisionRes.ok) {
        setSubmitError((provisionBody as { error?: string }).error ?? `Provisioning failed (${provisionRes.status})`);
        setSubmitting(false);
        return;
      }
      setResult((provisionBody as { data: ProvisionResponse }).data);
    } catch {
      setSubmitError('Network error — the tenant was not provisioned. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRetryBilling() {
    if (!result) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/platform/tenants/${result.tenant.id}/retry-billing`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult({ ...result, billing: (body as { data: BillingAttachResponse }).data });
      }
    } catch {
      // Network error — the alert stays in its current (failed) state; the button remains
      // available to retry again.
    } finally {
      setRetrying(false);
    }
  }

  // ── Result screen (post-provision) ────────────────────────────────────────────

  if (result) {
    return (
      <div className="mx-auto max-w-[720px] px-6 py-8">
        <Panel>
          <div className="mb-5 flex items-center gap-2.5">
            <Badge tone="success">Provisioned</Badge>
            <h1 className="text-[19px] font-extrabold tracking-[-0.02em]">{result.tenant.name}</h1>
          </div>

          <FormField
            label="Admin invite link"
            help="Send this to the first Admin so they can set their own password."
          >
            <Input readOnly value={result.invite.inviteUrl} onFocus={(e) => e.currentTarget.select()} />
          </FormField>

          <div className="mt-5">
            {result.billing.attached ? (
              <Alert tone="success" title="Billing attached">
                Stripe customer {result.billing.customerId} — card on file.
              </Alert>
            ) : (
              <>
                <Alert tone="attention" title="Tenant provisioned · billing attach failed">
                  {result.billing.error ?? 'Stripe was unreachable.'} The tenant is live and unaffected — billing can be retried any time.
                </Alert>
                <div className="mt-3">
                  <Button variant="primary" size="sm" onClick={handleRetryBilling} disabled={retrying}>
                    {retrying ? 'Retrying…' : 'Retry billing'}
                  </Button>
                </div>
              </>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <a href={`/platform/tenants/${result.tenant.id}`}>
              <Button variant="outline">View tenant</Button>
            </a>
            <a href="/platform/provisioning">
              <Button variant="primary">Provision another</Button>
            </a>
          </div>
        </Panel>
      </div>
    );
  }

  // ── Step flow ──────────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-[720px] px-6 py-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">Provision a new client</h1>
        <p className="mt-1 text-sm text-fg-muted">White-glove onboarding — the client receives a ready-to-use tenant.</p>
      </header>

      <nav aria-label="Provisioning steps" className="mb-5 flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <Badge key={s} tone={i === stepIdx ? 'info' : i < stepIdx ? 'success' : 'neutral'}>
            {i + 1}. {STEP_LABEL[s]}
          </Badge>
        ))}
      </nav>

      {submitError && (
        <div className="mb-4">
          <Alert tone="danger" title="Could not provision">{submitError}</Alert>
        </div>
      )}

      <Card>
        <CardBody>
          {step === 'tenant' && (
            <div className="flex flex-col gap-4">
              <FormField label="Organization name" required htmlFor="w-name">
                <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Storage" />
              </FormField>
              <FormField
                label="Slug"
                required
                htmlFor="w-slug"
                error={slugStatus === 'taken' ? `"${slug}" is already in use.` : slugStatus === 'error' && slug ? 'Lowercase letters, numbers, and hyphens only.' : null}
                help={slugStatus === 'checking' ? 'Checking availability…' : slugStatus === 'available' ? 'Available.' : 'Unique identifier for this tenant.'}
              >
                <Input id="w-slug" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} aria-invalid={slugStatus === 'taken' || slugStatus === 'error'} />
              </FormField>
            </div>
          )}

          {step === 'admin' && (
            <div className="flex flex-col gap-4">
              <Alert tone="info">The admin sets their own password from an invite link after provisioning — no password is collected here.</Alert>
              <FormField label="Admin name" required htmlFor="w-admin-name">
                <Input id="w-admin-name" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Avery Admin" />
              </FormField>
              <FormField label="Admin email" required htmlFor="w-admin-email" error={adminEmail && !EMAIL_RE.test(adminEmail) ? 'Enter a valid email address.' : null}>
                <Input id="w-admin-email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@acme.test" />
              </FormField>
            </div>
          )}

          {step === 'locations' && (
            <div className="flex flex-col gap-3">
              {locations.map((loc, i) => (
                <div key={i} className="flex items-end gap-2">
                  <FormField label={`Location ${i + 1} name`} htmlFor={`w-loc-name-${i}`} className="flex-1">
                    <Input id={`w-loc-name-${i}`} value={loc.name} onChange={(e) => updateLocation(i, { name: e.target.value })} placeholder="Main St" />
                  </FormField>
                  <FormField label="Address" htmlFor={`w-loc-addr-${i}`} className="flex-1">
                    <Input id={`w-loc-addr-${i}`} value={loc.address} onChange={(e) => updateLocation(i, { address: e.target.value })} placeholder="Optional" />
                  </FormField>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeLocation(i)} aria-label={`Remove location ${i + 1}`}>Remove</Button>
                </div>
              ))}
              <div>
                <Button type="button" variant="outline" size="sm" onClick={addLocation}>Add location</Button>
              </div>
            </div>
          )}

          {step === 'template' && (
            <FormField label="Requirements template" required htmlFor="w-template">
              {templates.length === 0 ? (
                <Alert tone="attention">No requirement templates are available. Add one before provisioning.</Alert>
              ) : (
                <Select id="w-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              )}
            </FormField>
          )}

          {step === 'timezone' && (
            <FormField label="Tenant timezone" required htmlFor="w-timezone" error={tzError} help="Anchors expiry-gate and digest timing for this tenant.">
              <Input
                id="w-timezone"
                list="w-timezone-options"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                onBlur={() => setTzTouched(true)}
                placeholder="America/Chicago"
                aria-invalid={!!tzError}
              />
              <datalist id="w-timezone-options">
                {tzList.map((tz) => <option key={tz} value={tz} />)}
              </datalist>
            </FormField>
          )}

          {step === 'review' && (
            <div className="flex flex-col gap-4">
              <h2 className="text-[15px] font-bold text-fg">Review before provisioning</h2>
              <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
                <dt className="text-fg-muted">Organization</dt><dd className="font-semibold">{name} <span className="text-fg-muted">({slug})</span></dd>
                <dt className="text-fg-muted">Admin</dt><dd>{adminName} — {adminEmail}</dd>
                <dt className="text-fg-muted">Locations</dt>
                <dd>{locations.filter((l) => l.name.trim()).length === 0 ? 'None yet' : locations.filter((l) => l.name.trim()).map((l) => l.name).join(', ')}</dd>
                <dt className="text-fg-muted">Template</dt><dd>{templates.find((t) => t.id === templateId)?.name ?? '—'}</dd>
                <dt className="text-fg-muted">Timezone</dt><dd>{timezone}</dd>
              </dl>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="mt-5 flex justify-between">
        <Button variant="outline" onClick={goBack} disabled={stepIdx === 0}>Back</Button>
        {step === 'review' ? (
          <Button variant="accent" onClick={handleProvision} disabled={submitting}>
            {submitting ? 'Provisioning…' : 'Provision this tenant'}
          </Button>
        ) : (
          <Button variant="primary" onClick={goNext} disabled={!canAdvance[step]}>Next</Button>
        )}
      </div>
    </div>
  );
}
