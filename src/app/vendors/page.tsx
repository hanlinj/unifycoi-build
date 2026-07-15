// /vendors — Vendor list (Admin/District audience, matching Command Center's). Store Managers
// keep /dashboard; a direct hit here 403s at the API and bounces to '/' (their own landing).
// Rows link to /vendors/[vendorId], the existing profile page this list sits above.
//
// Scope-clamped and declined-only-excluded identically to Command Center's "Total vendors"
// stat card (both go through resolveScope() + isDeclinedOnly()) — the header count here, with
// no filters applied, must always agree with that card. Filters (src/lib/vendors/filters.ts)
// only ever narrow within that same scoped set — they can't widen it.
//
// Filter state lives in the URL (searchParams), read here on the server so the fetch to
// /api/vendors carries it straight through — a filtered view is a real URL, shareable and
// reloadable, and the same query shape a future stat-card deep link (e.g. Expired vendors ->
// /vendors?status=expired) can just append to.
//
// No pagination yet — see the handoff note (Search/Date attribute are Stage 3, also not built
// here; the attribute registry is already shaped to accept a 'date' type without touching how
// enum attributes work).

import { Suspense } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { Card, Table, THead, TBody, TR, TH } from '@/components/ui';
import type { VendorsApiData } from '@/app/api/vendors/route';
import { filtersFromSearchParams } from '@/lib/vendors/filters';
import { VendorRow } from './VendorRow';
import { FilterBar } from './FilterBar';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

function toQueryString(searchParams: PageProps['searchParams']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export default async function VendorsPage({ searchParams }: PageProps) {
  const h = headers();
  const base = requestBaseUrl(h);
  const qs = toQueryString(searchParams);
  const res = await fetch(`${base}/api/vendors${qs}`, {
    headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 403) redirect('/'); // Store Manager or unauthorized — back to their own landing
  if (!res.ok) return <p className="p-8 font-sans text-sm">Failed to load vendors.</p>;

  const { data } = (await res.json()) as { data: VendorsApiData };
  const { vendors, total, unfilteredTotal, filterOptions } = data;

  // Same parser the server route uses on the query string it received — one definition of "what
  // a filter param looks like," not a second one reimplemented client-side. Used here only for
  // the header copy; FilterBar reads the URL itself client-side (useSearchParams()) so it never
  // drifts from browser back/forward or a deep link.
  const activeFilters = filtersFromSearchParams(new URLSearchParams(qs.replace(/^\?/, '')));

  return (
    <main className="mx-auto max-w-[1040px] px-6 py-8 font-sans">
      <header className="mb-6">
        <h1 className="text-[22px] font-extrabold tracking-[-0.02em] text-fg">Vendors</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {activeFilters.length > 0 ? (
            <>{total} of {unfilteredTotal} vendors in your scope.</>
          ) : (
            <>{total} {total === 1 ? 'vendor' : 'vendors'} in your scope.</>
          )}
        </p>
      </header>

      <Suspense fallback={<div className="mb-4 h-8" />}>
        <FilterBar filterOptions={filterOptions} />
      </Suspense>

      <Card>
        {vendors.length === 0 ? (
          <div className="p-8 text-center text-sm text-fg-muted">
            {activeFilters.length > 0 ? 'No vendors match these filters.' : 'No vendors in scope.'}
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-5">Vendor</TH>
                <TH>Trade</TH>
                <TH>Primary facility</TH>
                <TH>Invited by</TH>
                <TH>Invited</TH>
                <TH className="pr-5">Status</TH>
              </TR>
            </THead>
            <TBody>
              {vendors.map((v) => (
                <VendorRow key={v.id} vendor={v} />
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </main>
  );
}
