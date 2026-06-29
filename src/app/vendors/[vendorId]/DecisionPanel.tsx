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
  onDecisionComplete: () => void;
}

type DecisionAction = 'approve' | 'reject' | 'request_correction';

export function DecisionPanel({ vendorId, locations, onDecisionComplete }: DecisionPanelProps) {
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
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Server error ${res.status}`);
        return;
      }
      onDecisionComplete();
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

      {/* Action selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['approve', 'reject', 'request_correction'] as DecisionAction[]).map((a) => (
          <button
            key={a}
            onClick={() => setAction(a)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: action === a ? '2px solid #0969da' : '1px solid #d0d7de',
              background: action === a ? '#ddf4ff' : 'white',
              cursor: 'pointer',
              fontWeight: action === a ? 600 : 400,
            }}
          >
            {actionLabel[a]}
          </button>
        ))}
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

      {/* request_correction info */}
      {action === 'request_correction' && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#57606a' }}>
          All under-review locations will return to Onboarding. A correction invite will be sent to the vendor.
        </p>
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
            background: action === 'approve' ? '#1f883d' : action === 'reject' ? '#cf222e' : '#9a6700',
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
