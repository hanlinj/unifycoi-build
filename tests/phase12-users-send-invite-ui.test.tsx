// Slice 12/5b, Feature 2 — Send/Resend invite button in the Users panel. RTL/jsdom.
// Proves: an invited/never-sent user shows "Send invite"; after sending, the link is displayed
// inline (copyable) and a second click is labeled "Resend invite" once invite_sent_at is set.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserRowActions } from '@/app/users/UsersClient';

function mockFetch(inviteUrl: string) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/send-invite')) {
      return { ok: true, status: 200, json: async () => ({ data: { inviteUrl, expiresAt: '2026-08-01T00:00:00.000Z' } }) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  (global.fetch as unknown) = undefined;
  jest.restoreAllMocks();
});

test('a never-sent invited user shows "Send invite"; clicking it displays the returned link', async () => {
  mockFetch('http://localhost:3000/reset-password?token=abc123');
  render(<UserRowActions user={{ id: 'u1', role: 'store_manager', status: 'invited', inviteSentAt: null, regionIds: [], locationIds: [] }} regions={[]} locations={[]} />);

  const button = screen.getByRole('button', { name: 'Send invite' });
  await userEvent.click(button);

  await waitFor(() => expect(screen.getByDisplayValue('http://localhost:3000/reset-password?token=abc123')).toBeInTheDocument());
});

test('a previously-sent invited user shows "Resend invite" instead', () => {
  render(<UserRowActions user={{ id: 'u2', role: 'store_manager', status: 'invited', inviteSentAt: '2026-07-01T00:00:00.000Z', regionIds: [], locationIds: [] }} regions={[]} locations={[]} />);
  expect(screen.getByRole('button', { name: 'Resend invite' })).toBeInTheDocument();
});

test('an active user shows neither Send nor Resend invite', () => {
  render(<UserRowActions user={{ id: 'u3', role: 'store_manager', status: 'active', inviteSentAt: '2026-07-01T00:00:00.000Z', regionIds: [], locationIds: [] }} regions={[]} locations={[]} />);
  expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
});
