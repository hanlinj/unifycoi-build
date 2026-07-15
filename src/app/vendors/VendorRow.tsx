'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge, TR, TD } from '@/components/ui';
import type { VendorListRow } from '@/app/api/vendors/route';

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function VendorRow({ vendor }: { vendor: VendorListRow }) {
  const router = useRouter();
  const href = `/vendors/${vendor.id}`;

  return (
    <TR className="cursor-pointer" onClick={() => router.push(href)}>
      <TD className="pl-5 font-semibold text-fg">
        <Link href={href} className="hover:text-accent">
          {vendor.businessName}
        </Link>
      </TD>
      <TD className="capitalize text-fg-muted">{vendor.trade.replace(/_/g, ' ')}</TD>
      <TD className="text-fg-muted">{vendor.primaryFacility}</TD>
      <TD className="text-fg-muted">{vendor.invitedBy}</TD>
      <TD className="text-fg-muted">{shortDate(vendor.invitedAt)}</TD>
      <TD className="pr-5">
        <Badge tone={vendor.status.tone}>{vendor.status.label}</Badge>
      </TD>
    </TR>
  );
}
