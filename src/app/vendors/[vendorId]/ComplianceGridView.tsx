'use client';

// Compliance Grid render (Gate 2 restyle) — collapsible per facility, with each location's own
// meets/below pills in its header row (moved out of a single top-level strip). First location
// expanded on load, the rest collapsed; click a header to toggle. Requirement labels and Yes/No
// value formatting come from the one central map (src/lib/verification/requirement-labels.ts)
// so this can never show a raw dotted key or drift from the Unify Review summary's wording.

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

export function ComplianceGridView({ grid }: { grid: ComplianceGrid }) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(grid.locations[0] ? [grid.locations[0].locationId] : [])
  );

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
            <Card key={loc.locationId}>
              <button
                type="button"
                onClick={() => toggle(loc.locationId)}
                className="w-full text-left"
                aria-expanded={isOpen}
              >
                <CardHeader>
                  <CardTitle>{loc.locationName}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge tone="success">{meets} meet</Badge>
                    <Badge tone="danger">{below} below</Badge>
                    <span className="text-xs font-semibold text-fg-muted">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </CardHeader>
              </button>
              {isOpen && (
                loc.rows.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-fg-muted">No requirements resolved for this location.</p>
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Requirement</TH>
                        <TH>Required</TH>
                        <TH>On Certificate</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {loc.rows.map((row, i) => (
                        <TR key={`${row.requirementKey}-${i}`}>
                          <TD>{humanizeRequirementKey(row.requirementKey)}</TD>
                          <TD>{formatGridValue(row.requirementKey, row.requiredValue)}</TD>
                          <TD>{formatGridValue(row.requirementKey, row.extractedValue)}</TD>
                          <TD>
                            <Badge tone={row.status === 'green' ? 'success' : 'danger'}>
                              {gridStatusLabel(row)}
                            </Badge>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
