// /vendors/[vendorId] — Vendor Record workbench.
// Admin: full 5-zone workbench (identity, evaluations, locations, documents, activity).
// Manager: read-only status view, Sensitive fields not exposed.
// Server component — fetches vendor data from the internal API.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SearchCheck } from 'lucide-react';
import { requestBaseUrl } from '@/lib/http/base-url';
import { Card, CardHeader, CardTitle, CardBody, Badge, type BadgeTone } from '@/components/ui';
import { buildUnifyReviewSummary } from '@/lib/verification/summary';
import { DocumentsAccordion } from './DocumentsAccordion';
import { ComplianceGridView } from './ComplianceGridView';
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

interface ActivityEvent {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  event_type: string;
  payload: Record<string, unknown> | null;
}

interface GridRow {
  requirementKey: string;
  requiredValue: string | null;
  extractedValue: string | null;
  comparisonResult: 'meets' | 'fails' | 'indeterminate' | 'missing' | 'not_evaluated';
  status: 'green' | 'red';
  note: string | null;
}

interface LocationGrid {
  locationId: string;
  locationName: string;
  rows: GridRow[];
}

interface ComplianceGrid {
  locations: LocationGrid[];
  countMeets: number;
  countBelowOrMissing: number;
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
  grid?: ComplianceGrid | null;
  documents: DocumentRow[];
  activity?: ActivityEvent[];
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

// ── Activity (Zone 5) helpers ────────────────────────────────────────────────

function actorLabel(ev: ActivityEvent): string {
  switch (ev.actor_type) {
    case 'user': return ev.actor_name ?? 'Admin';
    case 'system': return 'System';
    case 'ai': return 'AI engine';
    case 'vendor': return 'Vendor';
    case 'platform': return 'Platform';
    default: return ev.actor_type;
  }
}

function actorTone(actorType: string): BadgeTone {
  switch (actorType) {
    case 'user': return 'info';
    case 'ai': return 'attention';
    case 'vendor': return 'success';
    default: return 'neutral'; // system, platform
  }
}

function titleCaseEventType(eventType: string): string {
  return eventType.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** event_type -> human sentence. Falls back to a title-cased event_type for anything unmapped
 *  (new event types stay visible in the timeline without a code change here). */
function describeAuditEvent(ev: ActivityEvent, locationNameById: Record<string, string>): string {
  const p = ev.payload ?? {};
  const loc = (key: string): string => {
    const id = p[key];
    return typeof id === 'string' ? (locationNameById[id] ?? id) : '';
  };
  const str = (key: string): string | undefined => (typeof p[key] === 'string' ? (p[key] as string) : undefined);

  switch (ev.event_type) {
    case 'vendor.invited':
      return `Vendor invited${str('trade') ? ` (${str('trade')})` : ''}`;
    case 'vendor.invite_resent':
      return 'Invite resent';
    case 'vendor.onboarding_started':
      return 'Vendor opened the onboarding link';
    case 'vendor.submitted':
      return `Documents submitted for review${str('recommendation') ? ` — engine recommended ${str('recommendation')}` : ''}`;
    case 'vendor.approved':
      return `Approved for ${loc('location_id') || 'a location'}`;
    case 'vendor.declined':
      return `Declined for ${loc('location_id') || 'a location'}${str('reason') ? ` — "${str('reason')}"` : ''}`;
    case 'vendor.correction_requested': {
      const count = typeof p.location_count === 'number' ? p.location_count : null;
      return `Correction requested${count !== null ? ` (${count} location${count === 1 ? '' : 's'})` : ''}${str('reason') ? ` — "${str('reason')}"` : ''}`;
    }
    case 'vendor.location_added': {
      const ids = Array.isArray(p.location_ids) ? p.location_ids.length : null;
      return `Added to ${ids ?? 'a'} new location${ids === 1 ? '' : 's'}`;
    }
    case 'vendor.non_compliant_rule_change':
      return 'Flagged Non-Compliant after a requirement change';
    case 'vendor.expired':
      return 'Coverage expired — pulled from hireable';
    case 'vendor.renewal_reminder_sent':
      return `Manual renewal reminder sent${loc('location_id') ? ` for ${loc('location_id')}` : ''}`;
    case 'evaluation.uncertain_accepted':
      return `Uncertain finding accepted (${str('requirement_key') ?? 'requirement'})${str('reasoning') ? ` — "${str('reasoning')}"` : ''}`;
    case 'ai.recommendation':
      return `Verification run recommended ${str('recommendation') ?? '—'}`;
    case 'ai.advisory':
      return `Advisory: ${str('message') ?? str('key') ?? ''}`;
    default:
      return titleCaseEventType(ev.event_type);
  }
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
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
  const { vendor, locations, verificationRun, grid, documents, activity, role } = json.data;
  const isAdmin = role === 'admin';
  const locationNameById: Record<string, string> = Object.fromEntries(
    locations.map((l) => [l.location_id, l.location_name])
  );
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

      {/* In-progress state — the vendor has submitted (under_review) but the background
          verification job (src/lib/verification/worker.ts) hasn't produced a run yet. No new
          FSM state: this reuses the existing under_review status + the absence of a
          verification_runs row as the signal. Gates the workbench content that follows (Unify
          Review → grid → decision panel), so the admin never opens a half-finished or empty
          workbench mid-job — Documents on File still renders regardless, since the uploaded
          files themselves are already real, whether or not the background run has finished. */}
      {isAdmin && !verificationRun && locations.some((l) => l.status === 'under_review') && (
        <section style={{ marginBottom: 32, padding: '16px 20px', borderRadius: 8, border: '1px solid #d0d7de', background: '#f6f8fa' }}>
          <p style={{ margin: 0, fontSize: 14, color: '#57606a', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#9a6700', display: 'inline-block', flexShrink: 0 }} />
            Verification in progress — documents are being reviewed by the AI engine. Refresh in a moment to see results.
          </p>
        </section>
      )}

      {/* Workbench, top to bottom in the order an Admin actually works it (Gate 2, Stage 4):
          Unify Review summary → compliance grid (per facility) → documents → decision panel. */}

      {/* Unify Review callout (Gate 2 restyle) — Admin only. Generated FROM the grid's own
          gap/pass counts (src/lib/verification/summary.ts), never a fresh AI call, so it can
          never contradict the grid rendered directly below it. Recommends; does not decide.
          Content is unchanged from Stage 2 — only the visual treatment (accent callout, icon,
          tag) changed here. */}
      {isAdmin && grid && verificationRun && (
        <section
          className="font-sans"
          style={{
            marginBottom: 20,
            padding: '16px 20px',
            borderRadius: 12,
            border: '1px solid #54AEFF',
            background: '#DDF4FF',
            display: 'flex',
            gap: 14,
            alignItems: 'flex-start',
          }}
        >
          <span
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, borderRadius: '50%', background: '#0969DA', flexShrink: 0,
            }}
          >
            <SearchCheck size={18} color="white" strokeWidth={2.25} />
          </span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#0969DA' }}>Unify Review</span>
              <span style={{
                fontSize: 11, fontWeight: 600, color: '#57606a', background: 'white',
                border: '1px solid #d0d7de', borderRadius: 999, padding: '1px 8px',
              }}>
                summary · you decide
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: '#1F2328', lineHeight: 1.5 }}>
              {buildUnifyReviewSummary(grid, verificationRun.recommendation, vendor.business_name)}
            </p>
          </div>
        </section>
      )}

      {/* Compliance Grid (Gate 2, Stage 1 + restyle) — Admin only. Collapsible per facility,
          humanized labels, per-location count pills — see ComplianceGridView.tsx. */}
      {isAdmin && grid && <ComplianceGridView grid={grid} />}

      {/* Zone 4: Documents on file. Admin gets the interactive accordion (Gate 2, Stage 3) —
          click a row to expand the real PDF, view/reveal audit events fire per action. Manager
          keeps the plain read-only table (no viewer, no reveal — Sensitive stays server-masked
          per invariant #8, and original_filename is never even sent to a non-admin). */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Documents on File</h2>
        {isAdmin ? (
          <DocumentsAccordion vendorId={vendor.id} documents={documents} />
        ) : documents.length === 0 ? (
          <p style={{ color: '#57606a', fontSize: 14 }}>No documents uploaded yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f6f8fa' }}>
                <th style={th}>Type</th>
                <th style={th}>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><code style={{ fontSize: 12 }}>{doc.doc_type.toUpperCase()}</code></td>
                  <td style={td}>{new Date(doc.uploaded_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Decision panel (Gate 2, Stage 4 — last in reading order). Evaluations table (with
          per-row uncertainty actions) and the decision panel share client state so "Treat as
          deficient" pre-populates the correction scope. Component itself untouched — Approve /
          Reject / Request Correction still call the same applyDecision()-backed API exactly as
          before; only this block's position on the page moved. */}
      {isAdmin && verificationRun && (
        <Workbench
          vendorId={vendor.id}
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

      {/* Zone 5: Activity — the vendor's audit trail, read-only, newest first. Admin-only
          (activity is present on VendorData only when the API's admin branch ran). */}
      {isAdmin && activity && (
        <section className="font-sans" style={{ marginTop: 32 }}>
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              {activity.length === 0 ? (
                <p className="px-5 py-6 text-sm text-fg-muted">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {activity.map((ev) => (
                    <li key={ev.id} className="flex items-start gap-3 px-5 py-3">
                      <Badge tone={actorTone(ev.actor_type)} className="mt-0.5 shrink-0">
                        {actorLabel(ev)}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-fg">{describeAuditEvent(ev, locationNameById)}</p>
                        <p className="mt-0.5 text-xs text-fg-muted">{formatTimestamp(ev.created_at)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </section>
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
