'use client';

// Compliance Grid render (Gate 2 restyle + polish pass) — collapsible per facility, with each
// location's own pass/warning pills in its header row (moved out of a single top-level strip).
// All locations start collapsed; click a header to toggle. Requirement labels and Yes/No value
// formatting come from the one central map (src/lib/verification/requirement-labels.ts) so this
// can never show a raw dotted key or drift from the Unify Review summary's wording.

import { useState } from 'react';
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

export function ComplianceGridView({ grid }: { grid: ComplianceGrid }) {
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

  return (
    <section className="font-sans" style={{ marginBottom: 32 }}>
      <h2 className="mb-3 text-base font-semibold text-fg">Compliance Grid</h2>
      <div className="space-y-4">
        {grid.locations.map((loc) => {
          const isOpen = expanded.has(loc.locationId);
          const meets = loc.rows.filter((r) => r.status === 'green').length;
          const below = loc.rows.filter((r) => r.status === 'red').length;
          return (
            // overflow-hidden: Card has no clipping of its own, so an explicitly-colored button
            // background (below) would otherwise square off the top corners past the card's
            // own rounded-card radius.
            <Card key={loc.locationId} className="overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(loc.locationId)}
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
                    <Badge tone="success">{meets} Pass</Badge>
                    <Badge tone="attention">{below} Warnings</Badge>
                    <span className="text-xs font-semibold text-fg-muted">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </CardHeader>
              </button>
              {isOpen && (
                loc.rows.length === 0 ? (
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
                )
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
