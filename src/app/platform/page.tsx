// /platform — the fleet roster (Zone 2). Data comes from the same source the platform GET
// exposes (listTenants); a server component reads it directly (no self-fetch). Auth is gated
// by the platform layout, so only platform users reach here.

import { getDb } from '@/lib/db/client';
import { listTenants } from '@/lib/services/tenants';
import { FleetRoster } from '@/components/platform/FleetRoster';

export const dynamic = 'force-dynamic';

export default async function PlatformFleetPage() {
  const tenants = await listTenants(getDb());
  return <FleetRoster tenants={tenants} />;
}
