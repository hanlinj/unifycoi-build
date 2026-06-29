// /v/[token] — vendor onboarding page (server component)
// Validates the invite token, fires open_link FSM transition on first load,
// then renders the guided upload UI or the already-submitted confirmation.
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
  const tdb = new TenantDB(db, invite.tenant_id);

  // Fire open_link: invited_pending → onboarding on first page load.
  // Idempotent — guard is false once locations have moved past invited_pending.
  const allPending =
    vendorLocations.length > 0 &&
    vendorLocations.every((vl) => vl.status === 'invited_pending');
  if (allPending) {
    fsmTransition(db, invite.tenant_id, invite.vendor_id, 'open_link');
  }

  // If the vendor has already submitted (a verification run exists), show read-only confirmation.
  const hasRun = !!tdb.get<{ id: string }>(
    `SELECT id FROM verification_runs WHERE tenant_id = ? AND vendor_id = ? LIMIT 1`,
    [invite.vendor_id]
  );
  if (hasRun) {
    return <SubmittedPage vendorName={vendor.business_name} />;
  }

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

// ── Static pages ──────────────────────────────────────────────────────────────

function InvalidTokenPage() {
  return (
    <main style={centeredPage}>
      <div style={card}>
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

function SubmittedPage({ vendorName }: { vendorName: string }) {
  return (
    <main style={centeredPage}>
      <div style={card}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 12px', color: '#111827' }}>
          Documents submitted
        </h1>
        <p style={{ fontSize: 16, color: '#4b5563', lineHeight: '1.6', margin: 0 }}>
          <strong>{vendorName}</strong>&rsquo;s documents have been received and are under
          review. Your contact will reach out if anything else is needed.
        </p>
      </div>
    </main>
  );
}

const centeredPage: React.CSSProperties = {
  minHeight: '100vh',
  background: '#f9fafb',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: '32px 24px',
  maxWidth: 480,
  width: '100%',
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  textAlign: 'center',
};
