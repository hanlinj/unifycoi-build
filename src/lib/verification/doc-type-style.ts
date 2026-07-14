// Central doc_type -> {label, tone} map. The ONE place a document type's pill color is
// defined, so COI/W-9/ACH render as the same fixed, distinct color everywhere the type is
// shown (currently: the admin documents accordion). Tones map to the existing Badge component's
// tone palette (src/components/ui/Badge.tsx) — no new colors invented.

import type { BadgeTone } from '@/components/ui';

export interface DocTypeStyle {
  label: string;
  tone: BadgeTone;
}

export const DOC_TYPE_STYLE: Record<string, DocTypeStyle> = {
  coi: { label: 'COI', tone: 'info' },
  w9: { label: 'W-9', tone: 'success' },
  ach: { label: 'ACH', tone: 'attention' },
};

export function docTypeStyle(docType: string): DocTypeStyle {
  return DOC_TYPE_STYLE[docType] ?? { label: docType.toUpperCase(), tone: 'neutral' };
}
