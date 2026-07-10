// Phase 12 · Slice 4a — credential-set landing page client forms. RTL/jsdom.
// Proves both copy branches (invited/active), password-policy inline rejection + mismatch
// gating, the post-success redirect-with-notice, and the expired+active request-new-link form.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialSetForm } from '@/app/reset-password/CredentialSetForm';
import { RequestNewLinkForm } from '@/app/reset-password/RequestNewLinkForm';

function mockAssign() {
  const assign = jest.fn();
  // jsdom doesn't implement real navigation; stub just the one method we call.
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
  return assign;
}

afterEach(() => {
  (global.fetch as unknown) = undefined;
  jest.restoreAllMocks();
});

describe('CredentialSetForm · invited (activation) copy', () => {
  test('renders welcome/activate copy with the tenant name, no "Set a new password" reset framing', () => {
    render(<CredentialSetForm token="tok1" userStatus="invited" tenantName="Acme Storage" />);
    expect(screen.getByText('Welcome to Acme Storage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate account' })).toBeInTheDocument();
    expect(screen.queryByText('Set a new password')).not.toBeInTheDocument();
  });

  test('a too-short password is rejected inline; mismatched passwords are rejected inline', async () => {
    render(<CredentialSetForm token="tok1" userStatus="invited" tenantName="Acme Storage" />);
    await userEvent.type(screen.getByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(screen.getByText(/at least 8 characters/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('New password'));
    await userEvent.clear(screen.getByLabelText('Confirm password'));
    await userEvent.type(screen.getByLabelText('New password'), 'a-good-password');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-different-one');
    await userEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(screen.getByText(/don.t match/)).toBeInTheDocument();
  });

  test('on success, POSTs {token, password} and redirects to /login?notice=activated', async () => {
    const assign = mockAssign();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { message: 'ok' } }) }) as unknown as typeof fetch;
    render(<CredentialSetForm token="the-raw-token" userStatus="invited" tenantName="Acme Storage" />);

    await userEvent.type(screen.getByLabelText('New password'), 'a-good-password-1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Activate account' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?notice=activated'));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/password-reset/confirm',
      expect.objectContaining({ body: JSON.stringify({ token: 'the-raw-token', password: 'a-good-password-1' }) })
    );
  });
});

describe('CredentialSetForm · active (reset) copy', () => {
  test('renders reset framing, not welcome/activation copy', () => {
    render(<CredentialSetForm token="tok2" userStatus="active" tenantName="Acme Storage" />);
    expect(screen.getByText('Set a new password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set password' })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome/)).not.toBeInTheDocument();
  });

  test('on success redirects to /login?notice=reset (not activated)', async () => {
    const assign = mockAssign();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }) as unknown as typeof fetch;
    render(<CredentialSetForm token="tok2" userStatus="active" tenantName="Acme Storage" />);

    await userEvent.type(screen.getByLabelText('New password'), 'a-good-password-1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?notice=reset'));
  });

  test('a submit-time failure (e.g. the token expired mid-visit) shows an inline error and does NOT redirect', async () => {
    const assign = mockAssign();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'This reset link is invalid or has expired.' }) }) as unknown as typeof fetch;
    render(<CredentialSetForm token="tok2" userStatus="active" tenantName="Acme Storage" />);

    await userEvent.type(screen.getByLabelText('New password'), 'a-good-password-1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText('This reset link is invalid or has expired.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('RequestNewLinkForm (expired + active-user dead end)', () => {
  test('submits the email to the existing request-reset endpoint and shows an enumeration-safe confirmation', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { message: 'ok' } }) }) as unknown as typeof fetch;
    render(<RequestNewLinkForm />);

    await userEvent.type(screen.getByLabelText('Email'), 'someone@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a new link' }));

    expect(await screen.findByText(/new link has been sent/)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/password-reset/request',
      expect.objectContaining({ body: JSON.stringify({ email: 'someone@acme.test' }) })
    );
    // Enumeration-safe: same confirmation shown even though we can't know if the email resolved.
    expect(screen.queryByRole('button', { name: 'Email me a new link' })).not.toBeInTheDocument();
  });

  test('shows the same confirmation even on a network error (never reveals whether the email exists)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    render(<RequestNewLinkForm />);

    await userEvent.type(screen.getByLabelText('Email'), 'someone@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a new link' }));

    expect(await screen.findByText(/new link has been sent/)).toBeInTheDocument();
  });
});
