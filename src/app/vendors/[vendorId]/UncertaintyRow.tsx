'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UncertaintyRow — the LOAD-BEARING TRUST INTERFACE between the engine and the Admin.
//
// Per MISSION tiebreaker #4 (humans in control): the AI verifies and recommends, but a
// human always makes the call. When the engine returns an "uncertain" finding, it is
// explicitly declining to decide — it hands the requirement to a person. THIS row is
// where that handoff happens. It is NOT a generic table cell.
//
// The two actions are deliberately distinct and visually opposed:
//   • "Accept"             — the Admin overrides the engine's hesitation, treating the
//                            requirement as satisfied for approval. Gated behind a
//                            confirmation with REQUIRED written reasoning (logged to audit),
//                            so it can never be a one-click slip.
//   • "Treat as deficient" — the Admin agrees the requirement isn't met, routing this
//                            specific requirement_key into the correction request scope.
//
// Do not collapse these into one button, auto-resolve them, or remove the reasoning gate.
// The friction is the feature: it forces a deliberate, attributable human decision.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';

export interface UncertainEvaluation {
  id: string;
  requirement_key: string;
  required_value: string | null;
  extracted_value_ref: string | null;
  confidence_band: string | null;
  note: string | null;
}

interface UncertaintyRowProps {
  vendorId: string;
  evaluation: UncertainEvaluation;
  isAccepted: boolean;
  isMarkedDeficient: boolean;
  onAccepted: (evalId: string) => void;
  onTreatAsDeficient: (requirementKey: string) => void;
}

const MIN_REASONING_LENGTH = 10;

const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };

export function UncertaintyRow({
  vendorId,
  evaluation,
  isAccepted,
  isMarkedDeficient,
  onAccepted,
  onTreatAsDeficient,
}: UncertaintyRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [reasoning, setReasoning] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasoningTooShort = reasoning.trim().length < MIN_REASONING_LENGTH;

  async function submitAccept() {
    if (reasoningTooShort) {
      setError(`Reasoning must be at least ${MIN_REASONING_LENGTH} characters`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/evaluations/${evaluation.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasoning: reasoning.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? `Server error ${res.status}`);
        return;
      }
      setConfirming(false);
      onAccepted(evaluation.id);
    } catch {
      setError('Network error — try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <tr style={{ borderBottom: confirming ? 'none' : '1px solid #f0f0f0', background: '#fffbe6' }}>
        <td style={td}><code style={{ fontSize: 12 }}>{evaluation.requirement_key}</code></td>
        <td style={td}>{evaluation.required_value ?? '—'}</td>
        <td style={td}>{evaluation.extracted_value_ref ?? '—'}</td>
        <td style={td}>
          <span style={{ color: '#9a6700', fontWeight: 600 }}>Uncertain</span>
        </td>
        <td style={td}>{evaluation.confidence_band ?? '—'}</td>
        <td style={td}>
          {isAccepted ? (
            <span style={{ color: '#1f883d', fontWeight: 600, fontSize: 12 }}>✓ Accepted</span>
          ) : isMarkedDeficient ? (
            <span style={{ color: '#cf222e', fontWeight: 600, fontSize: 12 }}>→ In correction</span>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => { setConfirming(true); setError(null); }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid #1f883d',
                  background: '#dafbe1',
                  color: '#1a7f37',
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Accept
              </button>
              <button
                onClick={() => onTreatAsDeficient(evaluation.requirement_key)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid #cf222e',
                  background: '#ffebe9',
                  color: '#cf222e',
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Treat as deficient
              </button>
            </div>
          )}
        </td>
      </tr>

      {/* Inline confirm — Accept requires written reasoning before it commits */}
      {confirming && (
        <tr style={{ borderBottom: '1px solid #f0f0f0', background: '#fffbe6' }}>
          <td style={td} colSpan={6}>
            <div style={{ padding: '8px 0' }}>
              <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600 }}>
                Accept this uncertain finding as satisfied?
              </p>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#57606a' }}>
                You are overriding the engine&apos;s hesitation. Explain your reasoning — this is
                recorded in the audit trail and attributed to you.
              </p>
              <textarea
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value)}
                rows={2}
                placeholder="Why is this requirement actually satisfied? (required)"
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid #d0d7de', resize: 'vertical', fontSize: 13 }}
              />
              {error && <p style={{ margin: '4px 0 0', color: '#cf222e', fontSize: 12 }}>{error}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={submitAccept}
                  disabled={submitting || reasoningTooShort}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#1f883d',
                    color: 'white',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: submitting || reasoningTooShort ? 'not-allowed' : 'pointer',
                    opacity: submitting || reasoningTooShort ? 0.6 : 1,
                  }}
                >
                  {submitting ? 'Recording…' : 'Confirm Accept'}
                </button>
                <button
                  onClick={() => { setConfirming(false); setReasoning(''); setError(null); }}
                  disabled={submitting}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: '1px solid #d0d7de',
                    background: 'white',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
