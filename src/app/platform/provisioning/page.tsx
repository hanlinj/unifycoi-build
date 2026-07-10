// /platform/provisioning — the New Client Provisioning wizard (Phase 12 · Slice 4, OPS-8 UI).
// Templates come from the same source the platform GET would expose (listTemplates); a server
// component reads it directly (no self-fetch), same convention as the fleet page.

import { getRawDb } from '@/lib/db/client';
import { listTemplates } from '@/lib/requirements/templates';
import { ProvisioningWizard } from '@/components/platform/ProvisioningWizard';

export const dynamic = 'force-dynamic';

export default function ProvisioningPage() {
  const templates = listTemplates(getRawDb()).map((t) => ({ id: t.id, name: t.name }));
  return <ProvisioningWizard templates={templates} />;
}
