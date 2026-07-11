// /v/[token] — vendor onboarding page (server component)
// Validates the invite token, fires open_link FSM transition on first load,
// then renders the guided upload UI or the already-submitted confirmation.
// No login required — the token is the credential.

import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { validateInviteToken } from '@/lib/services/vendor-token';
import { fireOnboardingStarted } from '@/lib/services/vendor-onboarding';
import { UploadFlow } from './UploadFlow';

export const dynamic = 'force-dynamic';

const REQUIRED_DOC_TYPES = ['coi', 'w9', 'ach'] as const;

export default async function VendorTokenPage({
  params,
}: {
  params: { token: string };
}) {
  const db = getDb();
  const validated = await validateInviteToken(db, params.token);

  if (!validated) {
    return <InvalidTokenPage />;
  }

  const { invite, vendor, vendorLocations } = validated;
  const tdb = new TenantDB(db, invite.tenant_id);

  // Fire open_link: invited_pending → onboarding on first page load, audited (Stage 6b
  // collapses this onto the same fireOnboardingStarted() the GET API route already used —
  // this page previously called fsmTransition() directly, silently skipping the audit event).
  await fireOnboardingStarted(db, {
    tenantId: invite.tenant_id,
    vendorId: invite.vendor_id,
    inviteId: invite.id,
    purpose: invite.purpose,
    vendorLocations,
  });

  // If the vendor has already submitted (a verification run exists), show read-only confirmation.
  const hasRun = !!(await tdb.get<{ id: string }>(
    `SELECT id FROM verification_runs WHERE tenant_id = $1 AND vendor_id = $2 LIMIT 1`,
    [invite.vendor_id]
  ));
  if (hasRun) {
    return <SubmittedPage vendorName={vendor.business_name} />;
  }

  const uploadedDocs = await tdb.all<{ id: string; doc_type: string; uploaded_at: Date }>(
    `SELECT id, doc_type, uploaded_at
     FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND superseded_by IS NULL AND state = 'active'
     ORDER BY uploaded_at ASC`,
    [invite.vendor_id]
  );

  return (
    <UploadFlow
      token={params.token}
      vendorName={vendor.business_name}
      requiredDocTypes={[...REQUIRED_DOC_TYPES]}
      initialUploadedDocs={uploadedDocs.map((d) => ({ ...d, uploaded_at: d.uploaded_at.toISOString() }))}
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
