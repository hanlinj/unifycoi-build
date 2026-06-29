// /v/[token] — vendor onboarding page (server component)
// Validates the invite token, fires open_link FSM transition on first load,
// then renders the guided upload UI.
// No login required — the token is the credential.

import { getRawDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { validateInviteToken } from '@/lib/services/vendor-token';
import { fsmTransition } from '@/lib/services/vendor-fsm';
import { UploadFlow } from './UploadFlow';

export const dynamic = 'force-dynamic';

const REQUIRED_DOC_TYPES = ['coi', 'w9', 'ach'] as const;

export default async function VendorTokenPage({
  params,
}: {
  params: { token: string };
}) {
  const db = getRawDb();
  const validated = validateInviteToken(db, params.token);

  if (!validated) {
    return <InvalidTokenPage />;
  }

  const { invite, vendor, vendorLocations } = validated;

  // Fire open_link: invited_pending → onboarding on the vendor's first page load.
  // Idempotent — if locations are already past invited_pending, the check is false.
  const allPending =
    vendorLocations.length > 0 &&
    vendorLocations.every((vl) => vl.status === 'invited_pending');
  if (allPending) {
    fsmTransition(db, invite.tenant_id, invite.vendor_id, 'open_link');
  }

  const tdb = new TenantDB(db, invite.tenant_id);
  const uploadedDocs = tdb.all<{ id: string; doc_type: string; uploaded_at: string }>(
    `SELECT id, doc_type, uploaded_at
     FROM documents
     WHERE tenant_id = ? AND vendor_id = ? AND superseded_by IS NULL AND state = 'active'
     ORDER BY uploaded_at ASC`,
    [invite.vendor_id]
  );

  return (
    <UploadFlow
      token={params.token}
      vendorName={vendor.business_name}
      requiredDocTypes={[...REQUIRED_DOC_TYPES]}
      initialUploadedDocs={uploadedDocs}
    />
  );
}

function InvalidTokenPage() {
  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⏱</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 12px', color: '#111827' }}>
          This link has expired
        </h1>
        <p style={{ fontSize: 16, color: '#4b5563', lineHeight: '1.6', margin: 0 }}>
          This invitation link is no longer valid. Please contact the company that sent it
          and ask them to resend a fresh link.
        </p>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#f9fafb',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: '32px 24px',
  maxWidth: 480,
  width: '100%',
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  textAlign: 'center',
};
