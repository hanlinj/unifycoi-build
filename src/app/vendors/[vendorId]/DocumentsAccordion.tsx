'use client';

// Documents accordion (Gate 2, Stage 3 + restyle) — Admin only. Click a row to expand the real
// PDF in place below it (served by GET /api/vendors/:id/documents/:documentId, which audits
// every view); click again to collapse. W-9/ACH rows also show their Sensitive extracted
// fields masked by default, with an independent click-to-reveal per field (each reveal is its
// own audited event), plus a click-to-copy control on a revealed value (each copy is ALSO its
// own audited event — previously missing entirely).

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Copy, Check } from 'lucide-react';
import { Badge } from '@/components/ui';
import { docTypeStyle } from '@/lib/verification/doc-type-style';

// Client-only: pdfjs-dist's worker is not SSR-safe. ssr: false keeps this component (and its
// pdfjs-dist import) out of the server render entirely — the effect-scoped dynamic import
// inside PdfViewer itself is the other half of that guarantee.
const PdfViewer = dynamic(() => import('./PdfViewer').then((m) => m.PdfViewer), { ssr: false });

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
        const style = docTypeStyle(doc.doc_type);
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
                <Badge tone={style.tone}>{style.label}</Badge>
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
                {/* PDF.js renderer — same serve route, same auth, same document.viewed audit
                    event (unchanged); this only replaces how the fetched bytes get displayed
                    (was: native <iframe> embed, inconsistent thumbnail/page-rail rendering
                    across browsers). See PdfViewer.tsx. */}
                <PdfViewer src={`/api/vendors/${vendorId}/documents/${doc.id}`} />
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
  const [copied, setCopied] = useState(false);

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

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write failed (e.g. no permission) — still log the attempted copy below? No:
      // if the value never actually reached the clipboard, don't claim it did in the audit
      // trail. Silently no-op the UI feedback; the audit call below only fires on success.
      return;
    }
    // Every copy is its own audited event — previously missing entirely (reveal was logged,
    // copy was not). Fire-and-forget: a failed audit call shouldn't block the user's copy.
    void fetch(`/api/vendors/${vendorId}/documents/${documentId}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field }),
    });
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
      {value !== null && (
        <button
          type="button"
          onClick={copy}
          title="Copy to clipboard"
          aria-label={`Copy ${label}`}
          style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: copied ? '#1f883d' : '#57606a' }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
      {error && <span style={{ color: '#cf222e', fontSize: 11 }}>{error}</span>}
    </span>
  );
}
