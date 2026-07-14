'use client';

import { useState } from 'react';

interface VendorLocation {
  id: string;
  location_id: string;
  location_name: string;
  status: string;
}

interface DecisionPanelProps {
  vendorId: string;
  locations: VendorLocation[];
  // Uncertain evaluation ids the Admin accepted via the per-row buttons. Bundled into
  // the approve action body for backwards-compat / bulk-approve flows.
  acceptedUncertaintyIds?: string[];
}

type DecisionAction = 'approve' | 'reject';

// Color identity per action (styling only — Approve = success green, Reject = danger red,
// matching the design system's --success/--danger tokens). Soft pastel fill — same tone
// family as the document-type pills (Badge's success/danger/attention soft tones:
// src/components/ui/Badge.tsx), not a strong solid fill. `ring` is the border shown only on
// the SELECTED button, so selection state doesn't depend on a background change — background
// stays the soft fill in every state, consistent as a set.
//
// request_correction moved OUT of this panel (Stage 2c) — correction is vendor-level and now
// document-targeted, not a per-location decision action. See RequestMoreInfoPanel.tsx, rendered
// next to the Documents section on the vendor page instead of here.
const ACTION_COLOR: Record<DecisionAction, { bg: string; text: string; ring: string }> = {
  approve: { bg: '#DAFBE1', text: '#1F883D', ring: '#1F883D' },
  reject: { bg: '#FFEBE9', text: '#C0392E', ring: '#C0392E' },
};

export function DecisionPanel({
  vendorId,
  locations,
  acceptedUncertaintyIds = [],
}: DecisionPanelProps) {
  const underReview = locations.filter((l) => l.status === 'under_review');
  const [action, setAction] = useState<DecisionAction | null>(null);
  const [selectedLocIds, setSelectedLocIds] = useState<Set<string>>(
    new Set(underReview.map((l) => l.location_id))
  );
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (underReview.length === 0) return null;

  function toggleLoc(locId: string) {
    setSelectedLocIds((prev) => {
      const next = new Set(prev);
      if (next.has(locId)) next.delete(locId);
      else next.add(locId);
      return next;
    });
  }

  async function submit() {
    if (!action) return;
    if (selectedLocIds.size === 0) {
      setError('Select at least one location');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          location_ids: [...selectedLocIds],
          ...(reason && { reason }),
          ...(action === 'approve' && acceptedUncertaintyIds.length > 0
            ? { accepted_uncertainty_ids: acceptedUncertaintyIds }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Server error ${res.status}`);
        return;
      }
      // Full page reload to show updated status. (Phase 6: adequate; router
      // invalidation deferred — see checkpoint notes.)
      if (typeof window !== 'undefined') window.location.reload();
    } catch {
      setError('Network error — try again');
    } finally {
      setSubmitting(false);
    }
  }

  const actionLabel: Record<DecisionAction, string> = {
    approve: 'Approve',
    reject: 'Reject',
  };

  return (
    <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: 20, marginTop: 24 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>Decision</h3>

      {/* Action selector — color only (wiring/behavior unchanged): Approve = green soft-fill,
          Reject = red soft-fill. Background stays the soft fill in every state; selection is
          shown by a matching-color ring instead of a background swap. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['approve', 'reject'] as DecisionAction[]).map((a) => {
          const selected = action === a;
          const c = ACTION_COLOR[a];
          return (
            <button
              key={a}
              onClick={() => setAction(a)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: `2px solid ${selected ? c.ring : 'transparent'}`,
                background: c.bg,
                color: c.text,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {actionLabel[a]}
            </button>
          );
        })}
      </div>

      {/* Location selector */}
      {action && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#57606a' }}>
            Select locations to {action}:
          </p>
          {underReview.map((loc) => (
            <label key={loc.location_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={selectedLocIds.has(loc.location_id)}
                onChange={() => toggleLoc(loc.location_id)}
              />
              {loc.location_name}
            </label>
          ))}
        </div>
      )}

      {/* Optional reason */}
      {action && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid #d0d7de', resize: 'vertical' }}
            placeholder="Note for audit trail..."
          />
        </div>
      )}

      {error && (
        <p style={{ margin: '0 0 12px', color: '#cf222e', fontSize: 13 }}>{error}</p>
      )}

      {action && (
        <button
          onClick={submit}
          disabled={submitting}
          style={{
            padding: '8px 20px',
            borderRadius: 6,
            border: `2px solid ${ACTION_COLOR[action].ring}`,
            background: ACTION_COLOR[action].bg,
            color: ACTION_COLOR[action].text,
            fontWeight: 600,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? 'Submitting…' : `Confirm ${actionLabel[action]}`}
        </button>
      )}
    </section>
  );
}
