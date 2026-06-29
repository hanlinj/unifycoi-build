'use client';

// Workbench — the Admin review surface (Zone 2). Holds the verification evaluation table
// and the decision panel together so they can share state: when the Admin accepts an
// uncertain finding or routes one to correction, both the table and the correction drawer
// react in lockstep. See UncertaintyRow for the load-bearing trust interface (MISSION #4).

import { useState } from 'react';
import { UncertaintyRow, type UncertainEvaluation } from './UncertaintyRow';
import { DecisionPanel } from './DecisionPanel';

export interface EvaluationRow {
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

export interface AdvisoryRow {
  id: string;
  key: string;
  severity: string;
  message: string;
}

export interface WorkbenchLocation {
  id: string;
  location_id: string;
  location_name: string;
  status: string;
}

interface WorkbenchProps {
  vendorId: string;
  trigger: string;
  recommendation: string;
  evaluations: EvaluationRow[];
  advisories: AdvisoryRow[];
  locations: WorkbenchLocation[];
}

const th: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12,
  color: '#57606a', borderBottom: '1px solid #d0d7de',
};
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };

function outcomeLabel(o: string): string {
  return o === 'deficient' ? 'Deficient' : o === 'uncertain' ? 'Uncertain' : o;
}
function outcomeColor(o: string): string {
  if (o === 'deficient') return '#cf222e';
  if (o === 'uncertain') return '#9a6700';
  return '#1f883d';
}

export function Workbench({
  vendorId, trigger, recommendation, evaluations, advisories, locations,
}: WorkbenchProps) {
  // Per-row uncertainty resolution state (the human-in-control handoff).
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [deficientReqKeys, setDeficientReqKeys] = useState<Set<string>>(new Set());

  function handleAccepted(evalId: string) {
    setAcceptedIds((prev) => new Set(prev).add(evalId));
  }
  function handleTreatAsDeficient(reqKey: string) {
    setDeficientReqKeys((prev) => new Set(prev).add(reqKey));
  }

  return (
    <>
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>
          Verification Review
          <span style={{ fontSize: 13, fontWeight: 400, color: '#57606a', marginLeft: 8 }}>
            Trigger: {trigger} · Recommendation:{' '}
            <strong style={{ color: recommendation === 'approve' ? '#1f883d' : '#cf222e' }}>
              {recommendation}
            </strong>
          </span>
        </h2>

        {evaluations.length === 0 ? (
          <p style={{ color: '#57606a', fontSize: 14 }}>No deficiencies or uncertainties found.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f6f8fa' }}>
                <th style={th}>Requirement</th>
                <th style={th}>Required</th>
                <th style={th}>Extracted</th>
                <th style={th}>Outcome</th>
                <th style={th}>Confidence</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((ev) => {
                if (ev.outcome === 'uncertain') {
                  const ue: UncertainEvaluation = {
                    id: ev.id,
                    requirement_key: ev.requirement_key,
                    required_value: ev.required_value,
                    extracted_value_ref: ev.extracted_value_ref,
                    confidence_band: ev.confidence_band,
                    note: ev.note,
                  };
                  return (
                    <UncertaintyRow
                      key={ev.id}
                      vendorId={vendorId}
                      evaluation={ue}
                      isAccepted={acceptedIds.has(ev.id)}
                      isMarkedDeficient={deficientReqKeys.has(ev.requirement_key)}
                      onAccepted={handleAccepted}
                      onTreatAsDeficient={handleTreatAsDeficient}
                    />
                  );
                }
                // Non-uncertain (deficient) rows: informational, no per-row action
                return (
                  <tr key={ev.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={td}><code style={{ fontSize: 12 }}>{ev.requirement_key}</code></td>
                    <td style={td}>{ev.required_value ?? '—'}</td>
                    <td style={td}>{ev.extracted_value_ref ?? '—'}</td>
                    <td style={td}>
                      <span style={{ color: outcomeColor(ev.outcome), fontWeight: 600 }}>
                        {outcomeLabel(ev.outcome)}
                      </span>
                    </td>
                    <td style={td}>{ev.confidence_band ?? '—'}</td>
                    <td style={td}>{ev.note ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Advisories panel — informational, no actions (spec: separate, non-gating) */}
        {advisories.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Advisories</h3>
            {advisories.map((adv) => (
              <div key={adv.id} style={{
                padding: '8px 12px', marginBottom: 6, borderRadius: 6,
                background: adv.severity === 'warn' ? '#fff8c5' : '#f6f8fa',
                border: `1px solid ${adv.severity === 'warn' ? '#d4a72c' : '#d0d7de'}`,
                fontSize: 13,
              }}>
                <strong>{adv.key}</strong>: {adv.message}
              </div>
            ))}
          </div>
        )}
      </section>

      <DecisionPanel
        vendorId={vendorId}
        locations={locations}
        prefilledDeficientRequirements={[...deficientReqKeys]}
        acceptedUncertaintyIds={[...acceptedIds]}
      />
    </>
  );
}
