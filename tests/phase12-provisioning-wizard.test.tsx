// Phase 12 · Slice 4/5a — Provisioning wizard UI. RTL/jsdom.
// Proves the step flow + the submit-blocking validation gates (timezone reject, slug
// collision), the invite/no-password credential model, and the automatic-billing two-commit
// UX (partial failure surfaces "Retry billing", never a dead-end toast).

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvisioningWizard } from '@/components/platform/ProvisioningWizard';

const TEMPLATES = [{ id: 'tpl-1', name: 'Standard Self-Storage' }];

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(handlers: {
  checkSlug?: (slug: string) => { available: boolean };
  provision?: () => { status: number; body: unknown };
  retryBilling?: () => { status: number; body: unknown };
}) {
  const calls: FetchCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.includes('/check-slug')) {
      const slug = new URL(url, 'http://t').searchParams.get('slug') ?? '';
      const available = handlers.checkSlug ? handlers.checkSlug(slug).available : true;
      return { ok: true, json: async () => ({ data: { slug, available } }) } as Response;
    }
    if (url.endsWith('/api/platform/provision')) {
      const { status, body } = handlers.provision ? handlers.provision() : { status: 201, body: {} };
      return { ok: status < 400, status, json: async () => body } as Response;
    }
    if (url.includes('/retry-billing')) {
      const { status, body } = handlers.retryBilling ? handlers.retryBilling() : { status: 200, body: {} };
      return { ok: status < 400, status, json: async () => body } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  (global.fetch as unknown) = undefined;
  jest.restoreAllMocks();
});

async function fillTenantStep(available = true) {
  mockFetch({ checkSlug: () => ({ available }) });
  render(<ProvisioningWizard templates={TEMPLATES} />);
  await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme Storage');
  return screen.getByRole('button', { name: 'Next' });
}

describe('ProvisioningWizard · Tenant step + slug gate', () => {
  test('slug auto-derives from name and Next is disabled until availability resolves', async () => {
    mockFetch({ checkSlug: () => ({ available: true }) });
    render(<ProvisioningWizard templates={TEMPLATES} />);
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme Storage');
    expect(screen.getByLabelText(/^Slug/)).toHaveValue('acme-storage');
    await waitFor(() => expect(next).toBeEnabled());
  });

  test('a taken slug blocks Next with an inline error; editing to a free one unblocks', async () => {
    mockFetch({ checkSlug: (slug) => ({ available: slug !== 'acme-storage' }) });
    render(<ProvisioningWizard templates={TEMPLATES} />);
    const next = screen.getByRole('button', { name: 'Next' });

    await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme Storage');
    await waitFor(() => expect(screen.getByText(/already in use/)).toBeInTheDocument());
    expect(next).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(/^Slug/));
    await userEvent.type(screen.getByLabelText(/^Slug/), 'acme-storage-2');
    await waitFor(() => expect(next).toBeEnabled());
  });

  test('a malformed hand-edited slug is rejected without a network round-trip', async () => {
    mockFetch({});
    render(<ProvisioningWizard templates={TEMPLATES} />);
    await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme');
    await userEvent.clear(screen.getByLabelText(/^Slug/));
    await userEvent.type(screen.getByLabelText(/^Slug/), 'Not Valid!');
    expect(screen.getByText(/Lowercase letters, numbers, and hyphens only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('ProvisioningWizard · Billing fields (rate + setup fee, Slice 5a)', () => {
  test('rate is prefilled ($90) so Next is not blocked by it; an invalid rate blocks Next', async () => {
    mockFetch({ checkSlug: () => ({ available: true }) });
    render(<ProvisioningWizard templates={TEMPLATES} />);
    const next = screen.getByRole('button', { name: 'Next' });

    await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme Storage');
    await waitFor(() => expect(next).toBeEnabled());

    await userEvent.clear(screen.getByLabelText(/^Per-location rate/));
    await userEvent.type(screen.getByLabelText(/^Per-location rate/), 'not-a-number');
    expect(screen.getByText(/non-negative amount/)).toBeInTheDocument();
    expect(next).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(/^Per-location rate/));
    await userEvent.type(screen.getByLabelText(/^Per-location rate/), '75');
    expect(next).toBeEnabled();
  });

  test('setup fee is optional (blank is fine); an invalid value blocks Next', async () => {
    mockFetch({ checkSlug: () => ({ available: true }) });
    render(<ProvisioningWizard templates={TEMPLATES} />);
    const next = screen.getByRole('button', { name: 'Next' });

    await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme Storage');
    await waitFor(() => expect(next).toBeEnabled()); // blank setup fee never blocked it

    await userEvent.type(screen.getByLabelText(/^One-time setup fee/), 'garbage');
    expect(screen.getByText(/leave blank for none/)).toBeInTheDocument();
    expect(next).toBeDisabled();
  });

  test('the Review step computes rate × location count, and the submit body carries cents', async () => {
    const calls = mockFetch({ checkSlug: () => ({ available: true }), provision: () => ({ status: 201, body: { data: { tenant: { id: 't3', name: 'Acme Storage', slug: 'acme-storage' }, adminUserId: 'u3', locationIds: [], billing: { attached: true, customerId: 'c', setupIntentClientSecret: 's', subscriptionId: 'sub_t3' } } } }) });
    render(<ProvisioningWizard templates={TEMPLATES} />);
    const next = screen.getByRole('button', { name: 'Next' });

    await userEvent.type(screen.getByLabelText(/^Organization\ name/), 'Acme Storage');
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.clear(screen.getByLabelText(/^Per-location rate/));
    await userEvent.type(screen.getByLabelText(/^Per-location rate/), '75');
    await userEvent.type(screen.getByLabelText(/^One-time setup fee/), '250');
    await userEvent.click(next); // -> admin
    await userEvent.type(screen.getByLabelText(/^Admin\ name/), 'Avery Admin');
    await userEvent.type(screen.getByLabelText(/^Admin\ email/), 'admin@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> locations
    await userEvent.type(screen.getByLabelText('Location 1 name'), 'Main St');
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> template
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> timezone
    await userEvent.type(screen.getByLabelText(/^Tenant\ timezone/), 'America/Chicago');
    await userEvent.tab();
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> review

    // The line is split across several inline JSX text nodes — match on the containing <dd>'s
    // full text rather than a single node.
    const billingDd = screen.getByText('Billing').nextElementSibling;
    expect(billingDd?.textContent).toMatch(/\$75\/location × 1 = \$75\/mo/);
    expect(billingDd?.textContent).toMatch(/\+\$250 one-time setup fee/);

    await userEvent.click(screen.getByRole('button', { name: 'Provision this tenant' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/platform/provision'))).toBe(true));
    const provisionCall = calls.find((c) => c.url.endsWith('/api/platform/provision'))!;
    const body = JSON.parse(provisionCall.init!.body as string);
    expect(body.monthlyRateCents).toBe(7500);
    expect(body.setupFeeCents).toBe(25000);
  });
});

describe('ProvisioningWizard · Admin step (invite, not password)', () => {
  test('renders name + email only — no password field anywhere', async () => {
    const next = await fillTenantStep();
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);

    expect(screen.getByText(/no password is collected here/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Admin\ name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Admin\ email/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('ProvisioningWizard · Timezone gate', () => {
  async function toTimezoneStep() {
    const next = await fillTenantStep();
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next); // -> admin
    await userEvent.type(screen.getByLabelText(/^Admin\ name/), 'Avery Admin');
    await userEvent.type(screen.getByLabelText(/^Admin\ email/), 'admin@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> locations
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> template
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> timezone
  }

  test('an unresolvable timezone shows an error and blocks Next; never defaults silently', async () => {
    await toTimezoneStep();
    const tzInput = screen.getByLabelText(/^Tenant\ timezone/);
    await userEvent.type(tzInput, 'Not/AZone');
    await userEvent.tab(); // blur → validation runs
    expect(screen.getByText(/valid IANA timezone/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('a valid IANA timezone unblocks Next', async () => {
    await toTimezoneStep();
    await userEvent.type(screen.getByLabelText(/^Tenant\ timezone/), 'America/Chicago');
    await userEvent.tab();
    expect(screen.queryByText(/valid IANA timezone/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
});

describe('ProvisioningWizard · Review, Provision, and the two-commit billing UX', () => {
  async function toReviewStep() {
    const next = await fillTenantStep();
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await userEvent.type(screen.getByLabelText(/^Admin\ name/), 'Avery Admin');
    await userEvent.type(screen.getByLabelText(/^Admin\ email/), 'admin@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // locations -> template
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // template -> timezone
    await userEvent.type(screen.getByLabelText(/^Tenant\ timezone/), 'America/Chicago');
    await userEvent.tab();
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> review
  }

  test('billing attach failure shows "Tenant provisioned · billing attach failed" with a Retry billing action; success flips the alert', async () => {
    await toReviewStep();
    mockFetch({
      checkSlug: () => ({ available: true }),
      provision: () => ({
        status: 201,
        body: {
          data: {
            tenant: { id: 't1', name: 'Acme Storage', slug: 'acme-storage' },
            adminUserId: 'u1',
            locationIds: [],
            billing: { attached: false, customerId: null, setupIntentClientSecret: null, subscriptionId: null, error: 'stripe unavailable' },
          },
        },
      }),
      retryBilling: () => ({ status: 200, body: { data: { attached: true, customerId: 'cus_t1', setupIntentClientSecret: 'seti_t1_secret', subscriptionId: 'sub_t1' } } }),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Provision this tenant' }));

    expect(await screen.findByText('Tenant provisioned · billing attach failed')).toBeInTheDocument();
    expect(screen.getByText(/stripe unavailable/)).toBeInTheDocument();
    // The tenant IS live — never a dead-end error toast. No invite link renders here anymore
    // (Slice 5a: activation + invite issuance moved to the invoice.paid webhook).
    expect(screen.getByText(/Awaiting first payment/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry billing' }));
    expect(await screen.findByText('Subscription created')).toBeInTheDocument();
    expect(screen.queryByText('Tenant provisioned · billing attach failed')).not.toBeInTheDocument();
  });

  test('billing attach success on the first try shows the success alert directly', async () => {
    await toReviewStep();
    mockFetch({
      checkSlug: () => ({ available: true }),
      provision: () => ({
        status: 201,
        body: {
          data: {
            tenant: { id: 't2', name: 'Acme Storage', slug: 'acme-storage' },
            adminUserId: 'u2',
            locationIds: [],
            billing: { attached: true, customerId: 'cus_t2', setupIntentClientSecret: 'seti_t2_secret', subscriptionId: 'sub_t2' },
          },
        },
      }),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Provision this tenant' }));
    expect(await screen.findByText('Subscription created')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry billing' })).not.toBeInTheDocument();
  });

  test('a 409 from provision (slug taken between Tenant step and submit) surfaces inline, not a crash', async () => {
    await toReviewStep();
    mockFetch({
      checkSlug: () => ({ available: false }), // final-guard re-check fails
    });

    await userEvent.click(screen.getByRole('button', { name: 'Provision this tenant' }));
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    // Bounced back to the Tenant step for a fix, not stuck on Review.
    expect(screen.getByLabelText(/^Organization\ name/)).toBeInTheDocument();
  });
});
