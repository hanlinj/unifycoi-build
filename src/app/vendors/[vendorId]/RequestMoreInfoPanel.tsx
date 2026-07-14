'use client';

// "Request more info" (Stage 2c) — the writer for the document-flag spine built in Stage 2a
// (src/lib/documents/flags.ts) and the vendor-level correction revert (Stage 1). A single
// vendor-level action, admin-only, placed next to Documents on File — NOT per-location, and
// NOT inside DecisionPanel (which only has Approve/Reject now; see DecisionPanel.tsx's own
// comment). Reuses the existing request_correction action end to end: vendor_locations sweep,
// invite, and correction email are all unchanged — this only adds doc_types + note to that same
// call, which decision.ts now uses to flag the selected documents (flagDocumentsForReplacement).

import { useState } from 'react';
import { Modal, Badge, Button, Textarea } from '@/components/ui';
import { docTypeStyle } from '@/lib/verification/doc-type-style';

export interface RequestMoreInfoDocument {
  id: string;
  doc_type: string;
}

interface Props {
  vendorId: string;
  documents: RequestMoreInfoDocument[];
}

// Local to this panel, deliberately NOT added to the shared doc-type-style.ts map: "Payment
// info" is clearer for a vendor-facing ask about the ACH document than the generic "ACH" label
// DocumentsAccordion already uses elsewhere — changing the shared map would ripple there too,
// which isn't wanted. Tone/color still comes from docTypeStyle() so the pill colors stay the
// one standardized set.
const PICKER_LABEL: Record<string, string> = { coi: 'COI', w9: 'W-9', ach: 'Payment info' };

const PRESETS = ['Unreadable / blurry', 'Expired', 'Wrong document', 'Missing pages'];

export function RequestMoreInfoPanel({ vendorId, documents }: Props) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (documents.length === 0) return null;

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    setSelectedIds(new Set());
    setNote('');
    setError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function send() {
    // Required — don't disable Send silently; tell the admin why nothing happened.
    if (selectedIds.size === 0) {
      setError('Select at least one document');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const docTypes = documents.filter((d) => selectedIds.has(d.id)).map((d) => d.doc_type);
      const res = await fetch(`/api/vendors/${vendorId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_correction',
          location_ids: [],
          doc_types: docTypes,
          ...(note.trim() && { reason: note.trim() }),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Server error ${res.status}`);
        return;
      }
      close();
      // Full page reload to show the flagged state — same convention DecisionPanel uses.
      if (typeof window !== 'undefined') window.location.reload();
    } catch {
      setError('Network error — try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Request more info
      </Button>

      <Modal
        open={open}
        onClose={close}
        title="Request more info"
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={send} disabled={submitting}>
              {submitting ? 'Sending…' : 'Send'}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-fg-muted">
          Select the document(s) that need to be resent. The vendor gets one email naming them,
          with your note.
        </p>

        <div className="mb-4 flex flex-col gap-2">
          {documents.map((doc) => {
            const style = docTypeStyle(doc.doc_type);
            const label = PICKER_LABEL[doc.doc_type] ?? style.label;
            return (
              <label key={doc.id} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedIds.has(doc.id)}
                  onChange={() => toggle(doc.id)}
                />
                <Badge tone={style.tone}>{label}</Badge>
              </label>
            );
          })}
        </div>

        <div className="mb-2 flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setNote(preset)}
              className="rounded-pill border border-border px-3 py-1 text-xs font-medium text-fg-muted hover:bg-surface-2"
            >
              {preset}
            </button>
          ))}
        </div>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Note for the vendor (optional)…"
        />

        {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      </Modal>
    </>
  );
}
