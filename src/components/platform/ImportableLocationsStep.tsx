'use client';

// The editable store+manager table (Slice 12/5b, Feature 1) — design-system skin, used by the
// ProvisioningWizard's Locations step. A parallel inline-style skin
// (src/app/locations/ImportableLocationsSection.tsx) renders the same
// useImportableLocationsRows state for the unmigrated tenant app (FENCE: migration-only,
// ADR-012-01) — deliberately two renderers over one hook, not one component straddling both
// visual systems.

import React from 'react';
import { Button, Input, Alert, Table, THead, TBody, TR, TH, TD } from '@/components/ui';
import type { useImportableLocationsRows } from '@/lib/import/useImportableLocationsRows';

export function ImportableLocationsStep({
  importable,
  idPrefix,
  parseEndpoint,
}: {
  importable: ReturnType<typeof useImportableLocationsRows>;
  idPrefix: string;
  parseEndpoint: string;
}) {
  const { rows, table, updateRow, addRow, removeRow, uploadFile, uploading, uploadError } = importable;
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (file) await uploadFile(file, parseEndpoint);
  }

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info">
        Type rows directly, or upload a .csv/.xlsx to fill the table — nothing is created until you provision. Fix any
        flagged field before continuing.
      </Alert>

      <div className="flex items-center gap-2.5">
        <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Reading file…' : 'Upload spreadsheet'}
        </Button>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={onFileChange} className="hidden" />
      </div>
      {uploadError && <Alert tone="danger">{uploadError}</Alert>}

      {table.duplicateGroups.map((g) => (
        <Alert key={g.email} tone="attention">
          {g.email} appears on {g.rowIndexes.length} rows — they&rsquo;ll manage all {g.rowIndexes.length} stores as one invite.
        </Alert>
      ))}

      <Table>
        <THead>
          <TR>
            <TH>Store name</TH>
            <TH>Address</TH>
            <TH>Manager first</TH>
            <TH>Manager last</TH>
            <TH>Manager email</TH>
            <TH aria-hidden />
          </TR>
        </THead>
        <TBody>
          {rows.map((row, i) => {
            const errors = table.rowErrors[i];
            return (
              <TR key={i}>
                <TD>
                  <Input
                    aria-label={`Store name, row ${i + 1}`}
                    value={row.storeName}
                    onChange={(e) => updateRow(i, { storeName: e.target.value })}
                    aria-invalid={!!errors.storeName}
                    placeholder="Main St"
                  />
                  {errors.storeName && <p role="alert" className="mt-1 text-xs font-medium text-danger">{errors.storeName}</p>}
                </TD>
                <TD>
                  <Input
                    aria-label={`Address, row ${i + 1}`}
                    value={row.address}
                    onChange={(e) => updateRow(i, { address: e.target.value })}
                    placeholder="Optional"
                  />
                </TD>
                <TD>
                  <Input
                    aria-label={`Manager first name, row ${i + 1}`}
                    value={row.managerFirstName}
                    onChange={(e) => updateRow(i, { managerFirstName: e.target.value })}
                  />
                </TD>
                <TD>
                  <Input
                    aria-label={`Manager last name, row ${i + 1}`}
                    value={row.managerLastName}
                    onChange={(e) => updateRow(i, { managerLastName: e.target.value })}
                  />
                </TD>
                <TD>
                  <Input
                    aria-label={`Manager email, row ${i + 1}`}
                    value={row.managerEmail}
                    onChange={(e) => updateRow(i, { managerEmail: e.target.value })}
                    aria-invalid={!!errors.managerEmail}
                    placeholder="manager@store.test"
                  />
                  {errors.managerEmail && <p role="alert" className="mt-1 text-xs font-medium text-danger">{errors.managerEmail}</p>}
                </TD>
                <TD>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(i)} aria-label={`Remove row ${i + 1}`}>
                    Remove
                  </Button>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={addRow} id={`${idPrefix}-add-row`}>Add row</Button>
      </div>
    </div>
  );
}
