'use client';

// Workbench — the Admin review surface. Holds the uncertain-finding review table and the
// decision panel together so they can share state: when the Admin accepts an uncertain finding
// or routes one to correction, both the table and the correction drawer react in lockstep.
// See UncertaintyRow for the load-bearing trust interface (MISSION #4).
//
// Gate 2 restyle: the old "Verification Review" heading + full evaluations table (every
// requirement, deficient rows shown as inert info) is gone — Unify Review + the Compliance
// Grid now show that, humanized, per facility. What could NOT come out: the uncertain-outcome
// rows' accept/treat-as-deficient interaction. That's a real decision-adjacent action (accept
// calls a real API and requires written reasoning; treat-as-deficient feeds the correction
// scope below) — not a display of information the grid already shows another way — so it stays,
// under its own honest label, only when there's actually something uncertain to review.

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
  evaluations: EvaluationRow[];
  advisories: AdvisoryRow[];
  locations: WorkbenchLocation[];
}

const th: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12,
  color: '#57606a', borderBottom: '1px solid #d0d7de',
};

export function Workbench({
  vendorId, evaluations, advisories, locations,
}: WorkbenchProps) {
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [deficientReqKeys, setDeficientReqKeys] = useState<Set<string>>(new Set());

  function handleAccepted(evalId: string) {
    setAcceptedIds((prev) => new Set(prev).add(evalId));
  }
  function handleTreatAsDeficient(reqKey: string) {
    setDeficientReqKeys((prev) => new Set(prev).add(reqKey));
  }

  const uncertainEvaluations = evaluations.filter((ev) => ev.outcome === 'uncertain');

  return (
    <>
      {uncertainEvaluations.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Needs Your Review</h2>
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
              {uncertainEvaluations.map((ev) => {
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
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* Advisories panel — informational, no actions. Not shown by Unify Review or the grid. */}
      {advisories.length > 0 && (
        <section style={{ marginBottom: 32 }}>
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
        </section>
      )}

      <DecisionPanel
        vendorId={vendorId}
        locations={locations}
        prefilledDeficientRequirements={[...deficientReqKeys]}
        acceptedUncertaintyIds={[...acceptedIds]}
      />
    </>
  );
}
