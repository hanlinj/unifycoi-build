'use client';

// The editable store+manager table (Slice 12/5b, Feature 1) — inline-style skin matching the
// unmigrated tenant app (/locations, /users — FENCE: migration-only, ADR-012-01). Renders the
// same useImportableLocationsRows state as the design-system skin used by the ProvisioningWizard
// (src/components/platform/ImportableLocationsStep.tsx); deliberately two renderers, one hook.

import { useRef, useState } from 'react';
import { useImportableLocationsRows } from '@/lib/import/useImportableLocationsRows';

const input: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13, width: '100%' };
const inputInvalid: React.CSSProperties = { ...input, border: '1px solid #cf222e', background: '#fff8f8' };
const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const btnOutline: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, border: '1px solid #d0d7de', background: 'white', color: '#24292f', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const th: React.CSSProperties = { padding: '7px 8px', fontSize: 12, color: '#57606a', fontWeight: 600, textAlign: 'left' };
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };

export function ImportableLocationsSection() {
  const { rows, table, updateRow, addRow, removeRow, uploadFile, uploading, uploadError } = useImportableLocationsRows();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<{ locations: number; managersCreated: number; managersReused: number } | null>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await uploadFile(file, '/api/locations/import/parse');
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/locations/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: table.nonBlankRows }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError((body as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      const data = (body as { data: { locationIds: string[]; managersCreated: number; managersReused: number } }).data;
      setDone({ locations: data.locationIds.length, managersCreated: data.managersCreated, managersReused: data.managersReused });
    } catch {
      setSubmitError('Network error — nothing was created.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: 16, marginTop: 20 }}>
        <p style={{ fontSize: 13, color: '#1a7f37', fontWeight: 600, margin: 0 }}>
          Created {done.locations} location{done.locations === 1 ? '' : 's'}
          {done.managersCreated + done.managersReused > 0 && (
            <> · {done.managersCreated} new manager{done.managersCreated === 1 ? '' : 's'} (dormant — send invites from Users)
            {done.managersReused > 0 ? `, ${done.managersReused} reused` : ''}</>
          )}
          .
        </p>
        <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
          <a href="/locations" style={btnOutline as React.CSSProperties}>Back to locations</a>
          <a href="/users" style={btn as React.CSSProperties}>Go send invites</a>
        </div>
      </section>
    );
  }

  return (
    <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: 16, marginTop: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>Add locations</h2>
      <p style={{ fontSize: 12, color: '#57606a', margin: '0 0 12px' }}>
        Type rows directly, or upload a .csv/.xlsx to fill the table. Nothing is created until you submit. A store
        manager email creates a dormant manager — invite them later from Users.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} style={btnOutline}>
          {uploading ? 'Reading file…' : 'Upload spreadsheet'}
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={onFileChange} style={{ display: 'none' }} />
      </div>
      {uploadError && <p role="alert" style={{ fontSize: 12, color: '#cf222e' }}>{uploadError}</p>}

      {table.duplicateGroups.map((g) => (
        <p key={g.email} style={{ fontSize: 12, color: '#9a6700', background: '#fff8c5', border: '1px solid #d4a72c', borderRadius: 6, padding: '6px 10px' }}>
          {g.email} appears on {g.rowIndexes.length} rows — they&rsquo;ll manage all {g.rowIndexes.length} stores as one invite.
        </p>
      ))}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
        <thead>
          <tr style={{ background: '#f6f8fa' }}>
            <th style={th}>Store name</th>
            <th style={th}>Address</th>
            <th style={th}>Manager first</th>
            <th style={th}>Manager last</th>
            <th style={th}>Manager email</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const errors = table.rowErrors[i];
            return (
              <tr key={i} style={{ borderTop: '1px solid #f0f3f6' }}>
                <td style={td}>
                  <input aria-label={`Store name, row ${i + 1}`} value={row.storeName} onChange={(e) => updateRow(i, { storeName: e.target.value })} style={errors.storeName ? inputInvalid : input} placeholder="Main St" />
                  {errors.storeName && <div role="alert" style={{ fontSize: 11, color: '#cf222e', marginTop: 2 }}>{errors.storeName}</div>}
                </td>
                <td style={td}>
                  <input aria-label={`Address, row ${i + 1}`} value={row.address} onChange={(e) => updateRow(i, { address: e.target.value })} style={input} placeholder="Optional" />
                </td>
                <td style={td}>
                  <input aria-label={`Manager first name, row ${i + 1}`} value={row.managerFirstName} onChange={(e) => updateRow(i, { managerFirstName: e.target.value })} style={input} />
                </td>
                <td style={td}>
                  <input aria-label={`Manager last name, row ${i + 1}`} value={row.managerLastName} onChange={(e) => updateRow(i, { managerLastName: e.target.value })} style={input} />
                </td>
                <td style={td}>
                  <input aria-label={`Manager email, row ${i + 1}`} value={row.managerEmail} onChange={(e) => updateRow(i, { managerEmail: e.target.value })} style={errors.managerEmail ? inputInvalid : input} placeholder="manager@store.test" />
                  {errors.managerEmail && <div role="alert" style={{ fontSize: 11, color: '#cf222e', marginTop: 2 }}>{errors.managerEmail}</div>}
                </td>
                <td style={td}>
                  <button type="button" onClick={() => removeRow(i)} aria-label={`Remove row ${i + 1}`} style={{ ...btnOutline, color: '#cf222e', borderColor: '#cf222e' }}>Remove</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" onClick={addRow} style={btnOutline}>Add row</button>
        <span style={{ flex: 1 }} />
        {submitError && <span role="alert" style={{ fontSize: 12, color: '#cf222e' }}>{submitError}</span>}
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !table.isClean || table.nonBlankRows.length === 0}
          style={{ ...btn, opacity: submitting || !table.isClean || table.nonBlankRows.length === 0 ? 0.5 : 1 }}
        >
          {submitting ? 'Creating…' : `Create ${table.nonBlankRows.length || ''} location${table.nonBlankRows.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  );
}
