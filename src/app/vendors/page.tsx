// /vendors — Vendor list (Admin/District audience, matching Command Center's). Store Managers
// keep /dashboard; a direct hit here 403s at the API and bounces to '/' (their own landing).
// Rows link to /vendors/[vendorId], the existing profile page this list sits above.
//
// Scope-clamped and declined-only-excluded identically to Command Center's "Total vendors"
// stat card (both go through resolveScope() + isDeclinedOnly()) — the header count here and
// that card must always agree.
//
// No filters, no pagination — out of scope for this slice (filters are a named follow-up).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { Card, Table, THead, TBody, TR, TH } from '@/components/ui';
import type { VendorListRow } from '@/app/api/vendors/route';
import { VendorRow } from './VendorRow';

export const dynamic = 'force-dynamic';

interface VendorsData {
  vendors: VendorListRow[];
  total: number;
}

export default async function VendorsPage() {
  const h = headers();
  const base = requestBaseUrl(h);
  const res = await fetch(`${base}/api/vendors`, {
    headers: { Authorization: h.get('Authorization') ?? '', Cookie: cookies().toString() },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 403) redirect('/'); // Store Manager or unauthorized — back to their own landing
  if (!res.ok) return <p className="p-8 font-sans text-sm">Failed to load vendors.</p>;

  const { data } = (await res.json()) as { data: VendorsData };
  const { vendors, total } = data;

  return (
    <main className="mx-auto max-w-[1040px] px-6 py-8 font-sans">
      <header className="mb-6">
        <h1 className="text-[22px] font-extrabold tracking-[-0.02em] text-fg">Vendors</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {total} {total === 1 ? 'vendor' : 'vendors'} in your scope.
        </p>
      </header>

      <Card>
        {vendors.length === 0 ? (
          <div className="p-8 text-center text-sm text-fg-muted">No vendors in scope.</div>
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
