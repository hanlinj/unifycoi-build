// /vendors/[vendorId] — Vendor Record workbench.
// Admin: full 5-zone workbench (identity, evaluations, locations, documents, activity).
// Manager: read-only status view, Sensitive fields not exposed.
// Server component — fetches vendor data from the internal API.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBaseUrl } from '@/lib/http/base-url';
import { Workbench } from './Workbench';

export const dynamic = 'force-dynamic';

// ── Types ─────────────────────────────────────────────────────────────────────

interface VendorLocation {
  id: string;
  location_id: string;
  location_name: string;
  status: string;
  flags_json: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
}

interface EvaluationRow {
  id: string;
  location_id: string;
  requirement_key: string;
  required_value: string | null;
  extracted_value_ref: string | null;
  comparison_result: string;
  confidence_band: string | null;
  outcome: string;
  note: string | null;
}

interface AdvisoryRow {
  id: string;
  key: string;
  severity: string;
  message: string;
}

interface VerificationRun {
  id: string;
  trigger: string;
  recommendation: string;
  created_at: string;
  evaluations: EvaluationRow[];
  advisories: AdvisoryRow[];
}

interface DocumentRow {
  id: string;
  doc_type: string;
  original_filename?: string | null;
  uploaded_at: string;
}

interface VendorData {
  vendor: {
    id: string;
    business_name: string;
    trade: string;
    contact_name: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
  };
  locations: VendorLocation[];
  verificationRun?: VerificationRun | null;
  documents: DocumentRow[];
  role: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveOverallStatus(locations: VendorLocation[]): string {
  if (locations.length === 0) return 'Unknown';
  const statuses = locations.map((l) => l.status);
  const approvedCount = statuses.filter((s) => s === 'approved').length;
  if (approvedCount === locations.length) return 'Approved';
  if (approvedCount > 0) return `Approved · ${approvedCount} of ${locations.length} locations`;
  // In-pipeline: pick the leading status
  const priority = ['under_review', 'onboarding', 'invited_pending', 'declined', 'expired', 'non_compliant'];
  for (const s of priority) {
    if (statuses.includes(s)) return statusLabel(s);
  }
  return statusLabel(statuses[0]);
}

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    invited_pending: 'Invited / Pending',
    onboarding: 'Onboarding',
    under_review: 'Under Review',
    approved: 'Approved',
    expired: 'Expired',
    non_compliant: 'Non-Compliant',
    declined: 'Declined',
  };
  return map[s] ?? s;
}

function statusColor(s: string): string {
  if (s === 'approved') return '#1f883d';
  if (s === 'declined' || s === 'expired' || s === 'non_compliant') return '#cf222e';
  if (s === 'under_review') return '#9a6700';
  return '#57606a';
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function VendorRecordPage({ params }: { params: { vendorId: string } }) {
  const authHeader = headers().get('Authorization') ?? '';
  const cookieHeader = cookies().toString();

  // Resolve the base URL for the internal API call (honors x-forwarded-proto; http in dev).
  const base = requestBaseUrl(headers());

  const res = await fetch(`${base}/api/vendors/${params.vendorId}`, {
    headers: {
      Authorization: authHeader,
      Cookie: cookieHeader,
    },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/');
  if (res.status === 403) redirect('/');
  if (res.status === 404) {
    return <p style={{ padding: 32 }}>Vendor not found.</p>;
  }
  if (!res.ok) {
    return <p style={{ padding: 32 }}>Failed to load vendor record.</p>;
  }

  const json = await res.json() as { data: VendorData };
  const { vendor, locations, verificationRun, documents, role } = json.data;
  const isAdmin = role === 'admin';
  const overallStatus = deriveOverallStatus(locations);

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px', fontFamily: 'system-ui, sans-serif' }}>

      {/* Zone 1: Identity header */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>{vendor.business_name}</h1>
            <span style={{
              display: 'inline-block',
              padding: '2px 10px',
              borderRadius: 12,
              background: '#f6f8fa',
              border: '1px solid #d0d7de',
              fontSize: 12,
              marginRight: 8,
            }}>{vendor.trade}</span>
            {vendor.contact_name && (
              <span style={{ fontSize: 14, color: '#57606a' }}>{vendor.contact_name}</span>
            )}
            {isAdmin && vendor.contact_email && (
              <span style={{ fontSize: 14, color: '#57606a', marginLeft: 8 }}>· {vendor.contact_email}</span>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{
              display: 'inline-block',
              padding: '4px 12px',
              borderRadius: 12,
              background: '#f6f8fa',
              border: `1px solid ${statusColor(locations[0]?.status ?? '')}`,
              color: statusColor(locations[0]?.status ?? ''),
              fontWeight: 600,
              fontSize: 14,
            }}>
              {overallStatus}
            </span>
          </div>
        </div>
      </section>

      {/* Zone 2: Review workbench (evaluations + uncertainty UX + decision panel) — Admin only.
          Rendered at the bottom alongside the decision drawer via <Workbench>; the uncertainty
          accept / treat-as-deficient handoff lives there (MISSION #4). */}

      {/* Zone 3: Per-location compliance */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Locations</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f6f8fa' }}>
              <th style={th}>Location</th>
              <th style={th}>Status</th>
              {isAdmin && <th style={th}>Approved by</th>}
              {isAdmin && <th style={th}>Approved at</th>}
            </tr>
          </thead>
          <tbody>
            {locations.map((loc) => {
              const flags = loc.flags_json ? (JSON.parse(loc.flags_json) as Record<string, boolean>) : {};
              return (
                <tr key={loc.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}>{loc.location_name}</td>
                  <td style={td}>
                    <span style={{ color: statusColor(loc.status), fontWeight: 600 }}>
                      {statusLabel(loc.status)}
                    </span>
                    {flags.action_needed && (
                      <span style={{ marginLeft: 6, fontSize: 11, background: '#fff8c5', padding: '1px 6px', borderRadius: 4 }}>
                        Action Needed
                      </span>
                    )}
                    {flags.expiring_soon && (
                      <span style={{ marginLeft: 6, fontSize: 11, background: '#fff8c5', padding: '1px 6px', borderRadius: 4 }}>
                        Expiring Soon
                      </span>
                    )}
                  </td>
                  {isAdmin && <td style={td}>{loc.approved_by ?? '—'}</td>}
                  {isAdmin && <td style={td}>{loc.approved_at ? new Date(loc.approved_at).toLocaleDateString() : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Zone 4: Documents on file */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Documents on File</h2>
        {documents.length === 0 ? (
          <p style={{ color: '#57606a', fontSize: 14 }}>No documents uploaded yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f6f8fa' }}>
                <th style={th}>Type</th>
                {isAdmin && <th style={th}>Filename</th>}
                <th style={th}>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><code style={{ fontSize: 12 }}>{doc.doc_type.toUpperCase()}</code></td>
                  {isAdmin && <td style={td}>{(doc as { original_filename?: string | null }).original_filename ?? '—'}</td>}
                  <td style={td}>{new Date(doc.uploaded_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Zone 2 workbench + decision drawer — Admin only.
          Evaluations table (with per-row uncertainty actions) and the decision panel share
          client state so "Treat as deficient" pre-populates the correction scope. */}
      {isAdmin && verificationRun && (
        <Workbench
          vendorId={vendor.id}
          trigger={verificationRun.trigger}
          recommendation={verificationRun.recommendation}
          evaluations={verificationRun.evaluations}
          advisories={verificationRun.advisories}
          locations={locations.map((l) => ({
            id: l.id,
            location_id: l.location_id,
            location_name: l.location_name,
            status: l.status,
          }))}
        />
      )}
    </main>
  );
}

// ── Shared table styles ───────────────────────────────────────────────────────

const th: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 12,
  color: '#57606a',
  borderBottom: '1px solid #d0d7de',
};

const td: React.CSSProperties = {
  padding: '8px 12px',
  verticalAlign: 'top',
};
