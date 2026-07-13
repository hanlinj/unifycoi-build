'use client';

// Documents accordion (Gate 2, Stage 3) — Admin only. Click a row to expand the real PDF
// in place below it (served by the new GET /api/vendors/:id/documents/:documentId route,
// which audits every view); click again to collapse. W-9/ACH rows also show their Sensitive
// extracted fields masked by default, with an independent click-to-reveal per field (each
// reveal is its own audited event, per the reveal route).

import { useState } from 'react';

export interface AccordionDocument {
  id: string;
  doc_type: string;
  original_filename?: string | null;
  uploaded_at: string;
}

interface Props {
  vendorId: string;
  documents: AccordionDocument[];
}

const SENSITIVE_FIELDS: Record<string, { field: string; label: string }[]> = {
  w9: [{ field: 'tin_value', label: 'TIN' }],
  ach: [
    { field: 'routing_number', label: 'Routing' },
    { field: 'account_number', label: 'Account' },
  ],
};

export function DocumentsAccordion({ vendorId, documents }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (documents.length === 0) {
    return <p style={{ color: '#57606a', fontSize: 14 }}>No documents uploaded yet.</p>;
  }

  function toggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div>
      {documents.map((doc) => {
        const expanded = expandedId === doc.id;
        const sensitiveFields = SENSITIVE_FIELDS[doc.doc_type] ?? [];
        return (
          <div key={doc.id} style={{ border: '1px solid #d0d7de', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle(doc.id)}
              style={{
                width: '100%',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 14px',
                background: expanded ? '#f6f8fa' : 'white',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                textAlign: 'left',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <code style={{ fontSize: 12 }}>{doc.doc_type.toUpperCase()}</code>
                {doc.original_filename && <span style={{ color: '#57606a' }}>{doc.original_filename}</span>}
                <span style={{ color: '#8c959f', fontSize: 12 }}>{new Date(doc.uploaded_at).toLocaleDateString()}</span>
              </span>
              <span style={{ fontSize: 12, color: '#0969da', fontWeight: 600 }}>{expanded ? 'Collapse ▲' : 'View ▼'}</span>
            </button>

            {sensitiveFields.length > 0 && (
              <div style={{ padding: '6px 14px', fontSize: 12, borderTop: '1px solid #eaeef2', display: 'flex', gap: 16 }}>
                {sensitiveFields.map((f) => (
                  <RevealableField key={f.field} vendorId={vendorId} documentId={doc.id} field={f.field} label={f.label} />
                ))}
              </div>
            )}

            {expanded && (
              <div style={{ borderTop: '1px solid #d0d7de' }}>
                <iframe
                  src={`/api/vendors/${vendorId}/documents/${doc.id}`}
                  title={`${doc.doc_type} document`}
                  style={{ width: '100%', height: 700, border: 'none', display: 'block' }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RevealableField({
  vendorId, documentId, field, label,
}: { vendorId: string; documentId: string; field: string; label: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setRevealing(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/documents/${documentId}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? 'Could not reveal');
        return;
      }
      const body = (await res.json()) as { data: { value: string } };
      setValue(body.data.value);
    } catch {
      setError('Network error');
    } finally {
      setRevealing(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: '#57606a' }}>{label}:</span>
      <code style={{ fontSize: 12 }}>{value ?? '••••••••'}</code>
      {value === null && !error && (
        <button
          type="button"
          onClick={reveal}
          disabled={revealing}
          style={{ fontSize: 11, color: '#0969da', background: 'none', border: 'none', cursor: revealing ? 'not-allowed' : 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          {revealing ? 'Revealing…' : 'Reveal'}
        </button>
      )}
      {error && <span style={{ color: '#cf222e', fontSize: 11 }}>{error}</span>}
    </span>
  );
}
