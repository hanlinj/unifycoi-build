'use client';

import { useState, useRef } from 'react';

interface UploadedDoc {
  id: string;
  doc_type: string;
  uploaded_at: string;
}

interface Props {
  token: string;
  vendorName: string;
  requiredDocTypes: string[];
  initialUploadedDocs: UploadedDoc[];
}

const DOC_META: Record<string, { label: string; description: string }> = {
  coi: {
    label: 'Proof of Insurance',
    description:
      'Your current certificate of insurance. Ask your insurance agent if you need a copy.',
  },
  w9: {
    label: 'W-9 Tax Form',
    description: 'IRS W-9 with your business name and tax ID for payment setup.',
  },
  ach: {
    label: 'Banking Info for Payment',
    description:
      'A voided check or bank letter for direct deposit. Stored encrypted — only authorized staff can see it.',
  },
};

export function UploadFlow({ token, vendorName, requiredDocTypes, initialUploadedDocs }: Props) {
  const [uploaded, setUploaded] = useState<UploadedDoc[]>(initialUploadedDocs);
  const [uploading, setUploading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const uploadedTypes = new Set(uploaded.map((d) => d.doc_type));
  const allDone = requiredDocTypes.every((t) => uploadedTypes.has(t));

  async function handleFile(docType: string, file: File) {
    setUploading(docType);
    setErrors((prev) => ({ ...prev, [docType]: '' }));

    const form = new FormData();
    form.append('file', file);
    form.append('doc_type', docType);

    try {
      const res = await fetch(`/api/v/${token}/documents`, { method: 'POST', body: form });
      const json = (await res.json()) as { data?: { document_id: string }; error?: string };

      if (!res.ok) {
        setErrors((prev) => ({
          ...prev,
          [docType]: json.error ?? 'Upload failed. Please try again.',
        }));
      } else {
        setUploaded((prev) => [
          ...prev.filter((d) => d.doc_type !== docType),
          {
            id: json.data!.document_id,
            doc_type: docType,
            uploaded_at: new Date().toISOString(),
          },
        ]);
      }
    } catch {
      setErrors((prev) => ({
        ...prev,
        [docType]: 'Network error. Check your connection and try again.',
      }));
    } finally {
      setUploading(null);
    }
  }

  return (
    <main style={s.page}>
      <div style={s.container}>
        {/* Header */}
        <div style={s.header}>
          <h1 style={s.heading}>Almost ready to work together</h1>
          <p style={s.body}>
            Before <strong>{vendorName}</strong> can start, we need a few documents — it
            takes about five minutes.
          </p>
          <p style={s.body}>
            We need proof of insurance, a W-9, and your bank info so we can pay you
            quickly.
          </p>
        </div>

        {/* Doc cards */}
        <div style={s.list}>
          {requiredDocTypes.map((docType) => {
            const meta = DOC_META[docType] ?? { label: docType, description: '' };
            const done = uploadedTypes.has(docType);
            const busy = uploading === docType;
            const err = errors[docType];

            return (
              <div key={docType} style={{ ...s.card, ...(done ? s.cardDone : {}) }}>
                <div style={s.row}>
                  <div style={s.cardLeft}>
                    <div style={s.label}>{meta.label}</div>
                    {!done && <div style={s.hint}>{meta.description}</div>}
                    {done && (
                      <button
                        style={s.replace}
                        onClick={() => inputRefs.current[docType]?.click()}
                        disabled={busy}
                      >
                        Replace
                      </button>
                    )}
                  </div>

                  <div style={s.cardRight}>
                    {done && !busy && <span style={s.check}>✓ Uploaded</span>}
                    {busy && <span style={s.busy}>Uploading…</span>}
                    {!done && !busy && (
                      <button
                        style={s.uploadBtn}
                        onClick={() => inputRefs.current[docType]?.click()}
                      >
                        Upload
                      </button>
                    )}
                  </div>
                </div>

                {err && <div style={s.error}>{err}</div>}

                <input
                  ref={(el) => {
                    inputRefs.current[docType] = el;
                  }}
                  type="file"
                  accept=".pdf,application/pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(docType, f);
                    e.target.value = '';
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* All done banner */}
        {allDone && (
          <div style={s.doneBanner}>
            <span style={s.doneIcon}>✓</span>
            <div>
              <strong>You&rsquo;re all set!</strong> Your contact will review everything
              and reach out if anything else is needed. You don&rsquo;t need to do
              anything else right now.
            </div>
          </div>
        )}

        {/* Reassurance footer */}
        <p style={s.footer}>
          Your documents are encrypted and stored securely. Banking info is visible only to
          authorized staff — not the person who sent you this link.
        </p>
      </div>
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f9fafb',
    padding: '24px 16px 48px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  container: { maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 28 },
  heading: { fontSize: 22, fontWeight: 700, color: '#111827', margin: '0 0 12px' },
  body: { fontSize: 15, color: '#374151', lineHeight: '1.6', margin: '0 0 8px' },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: {
    background: '#fff',
    borderRadius: 10,
    padding: 16,
    border: '1.5px solid #e5e7eb',
  },
  cardDone: { borderColor: '#86efac', background: '#f0fdf4' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  cardLeft: { flex: 1 },
  cardRight: { flexShrink: 0, paddingTop: 2 },
  label: { fontSize: 16, fontWeight: 600, color: '#111827' },
  hint: { fontSize: 13, color: '#6b7280', marginTop: 4, lineHeight: '1.5' },
  check: { fontSize: 14, fontWeight: 600, color: '#16a34a' },
  busy: { fontSize: 14, color: '#6b7280' },
  uploadBtn: {
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '9px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 40,
    minWidth: 80,
  },
  replace: {
    marginTop: 6,
    background: 'none',
    border: 'none',
    color: '#6b7280',
    fontSize: 13,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  },
  error: { marginTop: 8, color: '#dc2626', fontSize: 13 },
  doneBanner: {
    marginTop: 24,
    background: '#f0fdf4',
    border: '1.5px solid #86efac',
    borderRadius: 10,
    padding: 16,
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    fontSize: 15,
    color: '#166534',
    lineHeight: '1.6',
  },
  doneIcon: { fontSize: 22, flexShrink: 0, color: '#16a34a' },
  footer: {
    marginTop: 24,
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: '1.6',
    textAlign: 'center',
  },
};
