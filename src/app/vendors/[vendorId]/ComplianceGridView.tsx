'use client';

// Compliance Grid render (Gate 2 restyle + polish pass; per-location decisions, Stage 3) —
// collapsible per facility, with each location's own pass/warning pills in its header row.
// All locations start collapsed; click a header to toggle. Requirement labels and Yes/No value
// formatting come from the one central map (src/lib/verification/requirement-labels.ts) so this
// can never show a raw dotted key or drift from the Unify Review summary's wording.
//
// Per-location Approve/Reject now lives here (Stage 3) — the old single vendor-level Decision
// panel is gone. Each location's box carries its own decision, scoped to that location_id only,
// via the exact same applyDecision()-backed API the old panel used (untouched service logic).
// Approved/declined locations keep their header visible (a green check / red marker replaces
// the Pass/Warnings pills) — these headers are the admin's progress trail, never hidden.

import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, Badge, Table, THead, TBody, TR, TH, TD } from '@/components/ui';
import { humanizeRequirementKey, formatGridValue } from '@/lib/verification/requirement-labels';

export interface GridRow {
  requirementKey: string;
  requiredValue: string | null;
  extractedValue: string | null;
  comparisonResult: 'meets' | 'fails' | 'indeterminate' | 'missing' | 'not_evaluated';
  status: 'green' | 'red';
  note: string | null;
}

export interface LocationGrid {
  locationId: string;
  locationName: string;
  rows: GridRow[];
}

export interface ComplianceGrid {
  locations: LocationGrid[];
  countMeets: number;
  countBelowOrMissing: number;
}

interface Props {
  vendorId: string;
  grid: ComplianceGrid;
  // vendor_locations.status per location_id — the grid itself is purely evaluation-derived
  // (computeComplianceGrid never touches vendor_locations), so this is threaded in separately
  // from page.tsx rather than added to the grid recompute.
  statusByLocationId: Record<string, string>;
}

// Same soft-pastel tokens the old vendor-level DecisionPanel used — Approve = success green,
// Reject = danger red — preserved here since that panel is gone.
const ACTION_COLOR = {
  approve: { bg: '#DAFBE1', text: '#1F883D', ring: '#1F883D' },
  reject: { bg: '#FFEBE9', text: '#C0392E', ring: '#C0392E' },
} as const;

function gridStatusLabel(row: GridRow): string {
  switch (row.comparisonResult) {
    case 'meets': return 'Meets';
    case 'fails': return 'Fails';
    case 'missing': return 'Missing';
    case 'indeterminate': return 'Indeterminate';
    case 'not_evaluated': return 'Not evaluated';
    default: return row.comparisonResult;
  }
}

// Matches the existing "Locations" table's header row (page.tsx) exactly — the ONE grey token
// this page already uses for a header band, so the location boxes below don't introduce a
// second, unrelated shade of grey.
const LOCATION_HEADER_BG = '#f6f8fa';

export function ComplianceGridView({ vendorId, grid, statusByLocationId }: Props) {
  // All locations start collapsed — the admin opts into each one, rather than the first being
  // opened for them.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // "Approve all passing" — only locations still under_review AND with zero red (warning/
  // failure) rows. Never touches a location with any outstanding warning, and never an
  // already-decided one (approving twice would just 409 from applyDecision's own status check).
  const passingLocationIds = grid.locations
    .filter((loc) => (statusByLocationId[loc.locationId] ?? '') === 'under_review')
    .filter((loc) => loc.rows.every((r) => r.status !== 'red'))
    .map((loc) => loc.locationId);

  return (
    <section className="font-sans" style={{ marginBottom: 32 }}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Compliance Grid</h2>
        {passingLocationIds.length > 0 && (
          <ApproveAllPassing vendorId={vendorId} locationIds={passingLocationIds} />
        )}
      </div>
      <div className="space-y-4">
        {grid.locations.map((loc) => (
          <LocationCard
            key={loc.locationId}
            vendorId={vendorId}
            loc={loc}
            status={statusByLocationId[loc.locationId] ?? ''}
            isOpen={expanded.has(loc.locationId)}
            onToggle={() => toggle(loc.locationId)}
          />
        ))}
      </div>
    </section>
  );
}

function ApproveAllPassing({ vendorId, locationIds }: { vendorId: string; locationIds: string[] }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approveAll() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', location_ids: locationIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Server error ${res.status}`);
        return;
      }
      if (typeof window !== 'undefined') window.location.reload();
    } catch {
      setError('Network error — try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={approveAll}
        disabled={submitting}
        style={{
          padding: '6px 14px',
          borderRadius: 6,
          border: `2px solid ${ACTION_COLOR.approve.ring}`,
          background: ACTION_COLOR.approve.bg,
          color: ACTION_COLOR.approve.text,
          fontWeight: 600,
          fontSize: 13,
          cursor: submitting ? 'not-allowed' : 'pointer',
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting ? 'Approving…' : `Approve all passing (${locationIds.length})`}
      </button>
      {error && <span style={{ color: '#cf222e', fontSize: 12 }}>{error}</span>}
    </div>
  );
}

function LocationCard({
  vendorId, loc, status, isOpen, onToggle,
}: {
  vendorId: string;
  loc: LocationGrid;
  status: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const meets = loc.rows.filter((r) => r.status === 'green').length;
  const below = loc.rows.filter((r) => r.status === 'red').length;
  const [submittingAction, setSubmittingAction] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: 'approve' | 'reject') {
    setSubmittingAction(action);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, location_ids: [loc.locationId] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Server error ${res.status}`);
        setSubmittingAction(null);
        return;
      }
      if (typeof window !== 'undefined') window.location.reload();
    } catch {
      setError('Network error — try again');
      setSubmittingAction(null);
    }
  }

  return (
    // overflow-hidden: Card has no clipping of its own, so an explicitly-colored button
    // background (below) would otherwise square off the top corners past the card's
    // own rounded-card radius.
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left"
        // Explicit background + border reset — an unstyled native <button> otherwise
        // shows the browser's own default button chrome (a flat grey found nowhere else
        // on this page); this pins it to the same grey the Locations table's header row
        // already uses, in every state (not just on hover/expand).
        style={{ background: LOCATION_HEADER_BG, border: 'none', display: 'block', margin: 0 }}
        aria-expanded={isOpen}
      >
        <CardHeader>
          <CardTitle>{loc.locationName}</CardTitle>
          <div className="flex items-center gap-2">
            {status === 'approved' ? (
              <span className="flex items-center text-success" title="Approved">
                <CheckCircle2 size={18} strokeWidth={2.25} />
              </span>
            ) : status === 'declined' ? (
              <span className="flex items-center text-danger" title="Declined">
                <XCircle size={18} strokeWidth={2.25} />
              </span>
            ) : (
              <>
                <Badge tone="success">{meets} Pass</Badge>
                <Badge tone="attention">{below} Warnings</Badge>
              </>
            )}
            <span className="text-xs font-semibold text-fg-muted">{isOpen ? '▲' : '▼'}</span>
          </div>
        </CardHeader>
      </button>
      {isOpen && (
        <>
          {loc.rows.length === 0 ? (
            <p className="px-5 py-4 text-sm text-fg-muted">No requirements resolved for this location.</p>
          ) : (
            // pt-2: a little air between the location header and the column-heading row,
            // instead of the table butting straight up against the header's bottom border.
            <div className="pt-2">
              <Table>
                <THead>
                  <TR>
                    <TH style={{ color: '#1F2328' }}>Requirement</TH>
                    <TH style={{ color: '#1F2328' }}>Required</TH>
                    <TH style={{ color: '#1F2328' }}>On Certificate</TH>
                    <TH style={{ color: '#1F2328' }}>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {loc.rows.map((row, i) => (
                    <TR key={`${row.requirementKey}-${i}`}>
                      <TD style={{ padding: '8px 12px', lineHeight: 1.3 }}>{humanizeRequirementKey(row.requirementKey)}</TD>
                      <TD style={{ padding: '8px 12px', lineHeight: 1.3 }}>{formatGridValue(row.requirementKey, row.requiredValue)}</TD>
                      <TD style={{ padding: '8px 12px', lineHeight: 1.3 }}>{formatGridValue(row.requirementKey, row.extractedValue)}</TD>
                      <TD style={{ padding: '8px 12px', lineHeight: 1.3 }}>
                        <Badge tone={row.status === 'green' ? 'success' : 'danger'}>
                          {gridStatusLabel(row)}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}

          {/* Per-location decision — only while this location is actually under_review.
              Correction is deliberately NOT offered here: it's vendor-level and already lives
              in the Request More Info panel near Documents. */}
          {status === 'under_review' && (
            <div className="flex items-center gap-2 border-t border-border px-5 py-3">
              <button
                type="button"
                onClick={() => decide('approve')}
                disabled={submittingAction !== null}
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: `2px solid ${ACTION_COLOR.approve.ring}`,
                  background: ACTION_COLOR.approve.bg,
                  color: ACTION_COLOR.approve.text,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: submittingAction !== null ? 'not-allowed' : 'pointer',
                  opacity: submittingAction !== null ? 0.7 : 1,
                }}
              >
                {submittingAction === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => decide('reject')}
                disabled={submittingAction !== null}
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: `2px solid ${ACTION_COLOR.reject.ring}`,
                  background: ACTION_COLOR.reject.bg,
                  color: ACTION_COLOR.reject.text,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: submittingAction !== null ? 'not-allowed' : 'pointer',
                  opacity: submittingAction !== null ? 0.7 : 1,
                }}
              >
                {submittingAction === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>
              {error && <span style={{ color: '#cf222e', fontSize: 12 }}>{error}</span>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
