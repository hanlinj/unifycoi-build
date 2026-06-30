// Audit export CSV — ONE combined file with a leading `record_type` column (chosen over two
// separate CSVs so a single download is one self-contained file). Positional columns f1..f7
// carry section-specific meaning, documented here and machine-filterable by record_type:
//
//   record_type=meta        f1=label        f2=value
//   record_type=posture     f1=metric       f2=value
//   record_type=requirement f1=location     f2=trade   f3=requirement f4=required f5=source
//   record_type=event       f1=created_at   f2=actor_type f3=actor_id f4=event_type
//                           f5=target_type  f6=target_id  f7=payload_json
//   record_type=document    f1=vendor       f2=doc_type f3=document_id f4=uploaded_at
//                           f5=state        f6=sensitive

import { toCsv } from '@/lib/reports/csv';
import type { AuditExportContent } from './content';

const HEADER = ['record_type', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];

export function renderAuditExportCsv(content: AuditExportContent): string {
  const rows: (string | number)[][] = [];
  for (const m of content.metadata) rows.push(['meta', m.label, m.value, '', '', '', '', '']);
  for (const p of content.posture) rows.push(['posture', p.metric, p.value, '', '', '', '', '']);
  for (const r of content.requirements) rows.push(['requirement', r.location, r.trade, r.requirement, r.required, r.source, '', '']);
  for (const e of content.events) rows.push(['event', e.created_at, e.actor_type, e.actor_id, e.event_type, e.target_type, e.target_id, e.payload_json]);
  for (const d of content.documents) rows.push(['document', d.vendor, d.doc_type, d.document_id, d.uploaded_at, d.state, d.sensitive, '']);
  return toCsv(HEADER, rows);
}
