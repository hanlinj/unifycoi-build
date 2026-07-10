// Slice 12/5b, Feature 1 — the tenant-Admin bulk-add-locations screen (inline-style skin).
// Proves: inline per-field validation blocks submit until clean, a deliberate bad row shows a
// red-asterisk-equivalent error, fixing it unblocks submit, duplicate-email rows get an inline
// confirm banner (not an error), and a file upload populates the table without creating anything.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportableLocationsSection } from '@/app/locations/ImportableLocationsSection';

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(handlers: { parse?: () => { status: number; body: unknown }; bulkImport?: () => { status: number; body: unknown } }) {
  const calls: FetchCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/locations/import/parse')) {
      const { status, body } = handlers.parse ? handlers.parse() : { status: 200, body: { data: [] } };
      return { ok: status < 400, status, json: async () => body } as Response;
    }
    if (url.endsWith('/api/locations/bulk-import')) {
      const { status, body } = handlers.bulkImport ? handlers.bulkImport() : { status: 200, body: { data: { locationIds: [], managersCreated: 0, managersReused: 0 } } };
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

describe('ImportableLocationsSection · inline validation', () => {
  test('submit is disabled until a typed bad row is fixed', async () => {
    mockFetch({});
    render(<ImportableLocationsSection />);

    await userEvent.type(screen.getByLabelText('Manager first name, row 1'), 'Bob');
    const submit = screen.getByRole('button', { name: /Create/ });
    expect(submit).toBeDisabled(); // manager name with no email + no store name yet

    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0); // at least one field error surfaced

    await userEvent.type(screen.getByLabelText('Store name, row 1'), 'Main St');
    await userEvent.type(screen.getByLabelText('Manager email, row 1'), 'bob@store.test');
    await waitFor(() => expect(submit).toBeEnabled());
  });

  test('a blank row does not block submit', async () => {
    mockFetch({});
    render(<ImportableLocationsSection />);
    await userEvent.type(screen.getByLabelText('Store name, row 1'), 'Main St');
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled());
  });
});

describe('ImportableLocationsSection · duplicate-email consolidation', () => {
  test('the same manager email on two rows shows an inline confirm banner, not an error', async () => {
    mockFetch({});
    render(<ImportableLocationsSection />);

    await userEvent.type(screen.getByLabelText('Store name, row 1'), 'Main St');
    await userEvent.type(screen.getByLabelText('Manager email, row 1'), 'dup@store.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await userEvent.type(screen.getByLabelText('Store name, row 2'), 'Oak Ave');
    await userEvent.type(screen.getByLabelText('Manager email, row 2'), 'dup@store.test');

    expect(await screen.findByText(/dup@store\.test appears on 2 rows/)).toBeInTheDocument();
    // Not an error — submit stays enabled once both rows have store names.
    expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled();
  });
});

describe('ImportableLocationsSection · file upload', () => {
  test('uploading a file populates the table but creates nothing until submit', async () => {
    const calls = mockFetch({
      parse: () => ({ status: 200, body: { data: [{ storeName: 'Uploaded St', address: '9 Up St', managerFirstName: '', managerLastName: '', managerEmail: '' }] } }),
    });
    render(<ImportableLocationsSection />);

    const file = new File(['Store Name,Address\nUploaded St,9 Up St'], 'stores.csv', { type: 'text/csv' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(fileInput, file);

    await waitFor(() => expect(screen.getByDisplayValue('Uploaded St')).toBeInTheDocument());
    expect(calls.some((c) => c.url.endsWith('/api/locations/bulk-import'))).toBe(false); // nothing created by upload alone
  });

  test('submitting creates locations and shows the dormant-manager result', async () => {
    mockFetch({ bulkImport: () => ({ status: 200, body: { data: { locationIds: ['l1'], managersCreated: 1, managersReused: 0 } } }) });
    render(<ImportableLocationsSection />);

    await userEvent.type(screen.getByLabelText('Store name, row 1'), 'Main St');
    await userEvent.click(screen.getByRole('button', { name: /Create/ }));

    expect(await screen.findByText(/Created 1 location/)).toBeInTheDocument();
    expect(screen.getByText(/1 new manager/)).toBeInTheDocument();
  });
});
