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
    description: 'Your current certificate of insurance. A photo of the document is fine.',
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
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Two hidden inputs per card: one for file picker, one for rear camera
  const fileInputRefs   = useRef<Record<string, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

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
          { id: json.data!.document_id, doc_type: docType, uploaded_at: new Date().toISOString() },
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

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`/api/v/${token}/submit`, { method: 'POST' });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setSubmitError(j.error ?? 'Submission failed. Please try again.');
      } else {
        setSubmitted(true);
      }
    } catch {
      setSubmitError('Network error. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // After submit: replace the whole flow with a confirmation (no refresh needed)
  if (submitted) {
    return (
      <main style={s.page}>
        <div style={s.container}>
          <div style={{ ...s.card, textAlign: 'center', padding: '32px 24px' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
            <h1 style={{ ...s.heading, textAlign: 'center' }}>Documents submitted</h1>
            <p style={{ ...s.body, textAlign: 'center' }}>
              <strong>{vendorName}</strong>&rsquo;s documents are under review. Your contact
              will reach out if anything else is needed.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={s.page}>
      <div style={s.container}>
        {/* Header */}
        <div style={s.header}>
          <h1 style={s.heading}>Almost ready to work together</h1>
          <p style={s.body}>
            Before <strong>{vendorName}</strong> can start, we need a few documents —
            takes about five minutes.
          </p>
          <p style={s.body}>
            You can upload a PDF or take a photo directly with your phone.
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
                    {done && !busy && (
                      <button
                        style={s.replace}
                        onClick={() => fileInputRefs.current[docType]?.click()}
                      >
                        Replace
                      </button>
                    )}
                  </div>

                  <div style={s.cardRight}>
                    {done && !busy && <span style={s.check}>✓ Uploaded</span>}
                    {busy && <span style={s.busy}>Uploading…</span>}
                    {!done && !busy && (
                      <div style={s.btnGroup}>
                        <button
                          style={s.uploadBtn}
                          onClick={() => fileInputRefs.current[docType]?.click()}
                        >
                          Upload
                        </button>
                        <button
                          style={s.cameraBtn}
                          onClick={() => cameraInputRefs.current[docType]?.click()}
                          title="Take a photo with your camera"
                        >
                          📷
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {err && <div style={s.error}>{err}</div>}

                {/* Regular file picker — accepts PDF and all image types */}
                <input
                  ref={(el) => { fileInputRefs.current[docType] = el; }}
                  type="file"
                  accept="image/*,application/pdf,.pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(docType, f);
                    e.target.value = '';
                  }}
                />

                {/* Camera input — opens rear camera directly on mobile */}
                <input
                  ref={(el) => { cameraInputRefs.current[docType] = el; }}
                  type="file"
                  accept="image/*"
                  capture="environment"
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

        {/* Submit section — appears only when all docs are uploaded */}
        {allDone && (
          <div style={s.submitSection}>
            <p style={s.submitNote}>
              All documents provided — tap below to submit for review.
            </p>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{ ...s.submitBtn, ...(submitting ? s.submitBtnDisabled : {}) }}
            >
              {submitting ? 'Submitting…' : 'Submit documents'}
            </button>
            {submitError && <div style={{ ...s.error, marginTop: 8 }}>{submitError}</div>}
          </div>
        )}

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
  btnGroup: { display: 'flex', gap: 8, alignItems: 'center' },
  uploadBtn: {
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '9px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 80,
  },
  cameraBtn: {
    background: '#f3f4f6',
    border: '1.5px solid #d1d5db',
    borderRadius: 8,
    padding: '9px 12px',
    fontSize: 18,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 44,
    lineHeight: 1,
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
  submitSection: {
    marginTop: 24,
    background: '#fff',
    borderRadius: 10,
    padding: 20,
    border: '1.5px solid #e5e7eb',
  },
  submitNote: {
    fontSize: 15,
    color: '#374151',
    margin: '0 0 16px',
    lineHeight: '1.6',
  },
  submitBtn: {
    width: '100%',
    background: '#16a34a',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '14px 24px',
    fontSize: 17,
    fontWeight: 700,
    cursor: 'pointer',
    minHeight: 52,
  },
  submitBtnDisabled: {
    background: '#86efac',
    cursor: 'not-allowed',
  },
  footer: {
    marginTop: 24,
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: '1.6',
    textAlign: 'center',
  },
};
