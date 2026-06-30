// Phase 10, Slice D, item 3 — the vendor token surface must not leak tenant chrome.
//
// AppShell wraps every route (it's in the root layout). For /v/* it must render children only.
// We render AppShell to static HTML (react-dom/server, no JSX — React.createElement) with a
// mocked pathname and string-match the output for known chrome markers (the Phase 7/9
// Sensitive-scan pattern, applied to chrome). A positive control proves the scan is non-vacuous.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let mockPath = '/';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));

// eslint-disable-next-line @typescript-eslint/no-var-requires -- import after the mock is set
import { AppShell } from '@/components/AppShell';

function render(pathname: string): string {
  mockPath = pathname;
  return renderToStaticMarkup(
    React.createElement(AppShell, null, React.createElement('div', null, 'VENDOR_CONTENT_MARKER'))
  );
}

const CHROME_MARKERS = ['aria-label="Primary"', 'Log out', '+ Invite vendor', '🔍'];

describe('vendor token surface — no chrome leak', () => {
  test('/v/[token] renders children only, none of the tenant chrome markers', () => {
    const html = render('/v/sometoken123');
    expect(html).toContain('VENDOR_CONTENT_MARKER');
    for (const m of CHROME_MARKERS) expect(html).not.toContain(m);
  });

  test('positive control: a tenant route DOES render chrome (non-vacuous scan)', () => {
    const html = render('/dashboard');
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('Log out');
    expect(html).toContain('+ Invite vendor');
  });
});
