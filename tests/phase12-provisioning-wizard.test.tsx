// Phase 12 · Slice 4 — Provisioning wizard UI. RTL/jsdom.
// Proves the step flow + the submit-blocking validation gates (timezone reject, slug
// collision) and the invite/no-password credential model.

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
