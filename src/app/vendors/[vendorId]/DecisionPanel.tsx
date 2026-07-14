'use client';

import { useState, useEffect } from 'react';

interface VendorLocation {
  id: string;
  location_id: string;
  location_name: string;
  status: string;
}

interface DecisionPanelProps {
  vendorId: string;
  locations: VendorLocation[];
  // Requirement keys routed here by "Treat as deficient" on an uncertain finding.
  // When non-empty, the correction drawer auto-opens with this scope pre-populated.
  prefilledDeficientRequirements?: string[];
  // Uncertain evaluation ids the Admin accepted via the per-row buttons. Bundled into
  // the approve action body for backwards-compat / bulk-approve flows.
  acceptedUncertaintyIds?: string[];
}

type DecisionAction = 'approve' | 'reject' | 'request_correction';

// Color identity per action (styling only — Approve = success green, Reject = danger red,
// Request Correction stays neutral gray, matching the design system's --success/--danger tokens).
const ACTION_COLOR: Record<DecisionAction, { border: string; text: string; fill: string; fillText: string }> = {
  approve: { border: '#1f883d', text: '#1f883d', fill: '#1f883d', fillText: 'white' },
  reject: { border: '#cf222e', text: '#cf222e', fill: '#cf222e', fillText: 'white' },
  // Neutral: border is a light hairline, but text needs real contrast against white — using the
  // border color for both (as approve/reject do) would render nearly invisible gray-on-white.
  request_correction: { border: '#d0d7de', text: '#57606a', fill: '#57606a', fillText: 'white' },
};

export function DecisionPanel({
  vendorId,
  locations,
  prefilledDeficientRequirements = [],
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

  // When the Admin routes an uncertain finding to correction, auto-open the
  // correction drawer so the pre-populated scope is immediately visible.
  useEffect(() => {
    if (prefilledDeficientRequirements.length > 0) {
      setAction('request_correction');
    }
  }, [prefilledDeficientRequirements.length]);

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
    if (action !== 'request_correction' && selectedLocIds.size === 0) {
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
          location_ids: action === 'request_correction' ? [] : [...selectedLocIds],
          ...(reason && { reason }),
          ...(action === 'approve' && acceptedUncertaintyIds.length > 0
            ? { accepted_uncertainty_ids: acceptedUncertaintyIds }
            : {}),
          ...(action === 'request_correction' && prefilledDeficientRequirements.length > 0
            ? { deficient_requirements: prefilledDeficientRequirements }
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
    request_correction: 'Request Correction',
  };

  return (
    <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: 20, marginTop: 24 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>Decision</h3>

      {/* Action selector — color only (wiring/behavior unchanged): Approve = green, Reject =
          red, Request Correction stays neutral. Each button shows a colored outline as its
          identity even before selection; selecting it fills solid in that color. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['approve', 'reject', 'request_correction'] as DecisionAction[]).map((a) => {
          const selected = action === a;
          const c = ACTION_COLOR[a];
          return (
            <button
              key={a}
              onClick={() => setAction(a)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: `2px solid ${c.border}`,
                background: selected ? c.fill : 'white',
                color: selected ? c.fillText : c.text,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {actionLabel[a]}
            </button>
          );
        })}
      </div>

      {/* Location selector (approve / reject only) */}
      {action && action !== 'request_correction' && (
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

      {/* request_correction info + pre-populated scope */}
      {action === 'request_correction' && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#57606a' }}>
            All under-review locations will return to Onboarding. A correction invite will be sent to the vendor.
          </p>
          {prefilledDeficientRequirements.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600 }}>
                Correction scope (from uncertain findings you routed here):
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {prefilledDeficientRequirements.map((rk) => (
                  <li key={rk} style={{ fontSize: 12 }}><code>{rk}</code></li>
                ))}
              </ul>
            </div>
          )}
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
            border: 'none',
            background: ACTION_COLOR[action].fill,
            color: 'white',
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
