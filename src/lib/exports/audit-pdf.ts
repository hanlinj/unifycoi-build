// Audit export PDF — a paper-review evidentiary document: metadata header, posture,
// requirements-in-force, the event trail GROUPED BY DATE, and the documents manifest. Every
// page carries a scope header and a page number. Print typography (pdf-lib / Helvetica).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { winAnsi } from '@/lib/reports/pdf';
import type { AuditExportContent } from './content';

const PAGE_W = 612, PAGE_H = 792, MARGIN = 50;
const INK = rgb(0.13, 0.15, 0.18), MUTED = rgb(0.45, 0.48, 0.52), LINE = rgb(0.82, 0.84, 0.86);

export async function renderAuditExportPdf(
  content: AuditExportContent,
  meta: { tenantName: string; scopeLabel: string; generatedAt: string }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page!: PDFPage;
  let y = 0;
  let pageNum = 0;

  const fit = (t: string, f: PDFFont, size: number, maxW: number): string => {
    let s = winAnsi(t);
    if (f.widthOfTextAtSize(s, size) <= maxW) return s;
    while (s.length > 1 && f.widthOfTextAtSize(s + '...', size) > maxW) s = s.slice(0, -1);
    return s + '...';
  };
  const startPage = () => {
    pageNum++;
    page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(fit(`${meta.tenantName} — Audit Export — ${meta.scopeLabel}`, bold, 9, PAGE_W - 2 * MARGIN), { x: MARGIN, y: PAGE_H - MARGIN + 8, size: 9, font: bold, color: MUTED });
    page.drawLine({ start: { x: MARGIN, y: PAGE_H - MARGIN }, end: { x: PAGE_W - MARGIN, y: PAGE_H - MARGIN }, thickness: 0.5, color: LINE });
    page.drawText(`generated ${meta.generatedAt}`, { x: MARGIN, y: MARGIN - 20, size: 7, font, color: MUTED });
    page.drawText(`Page ${pageNum}`, { x: PAGE_W - MARGIN - 40, y: MARGIN - 20, size: 7, font, color: MUTED });
    y = PAGE_H - MARGIN - 22;
  };
  const ensure = (need: number) => { if (y - need < MARGIN + 6) startPage(); };
  const line = (text: string, size = 9, f: PDFFont = font, indent = 0, color = INK) => {
    ensure(size + 4);
    page.drawText(fit(text, f, size, PAGE_W - 2 * MARGIN - indent), { x: MARGIN + indent, y: y - size, size, font: f, color });
    y -= size + 4;
  };
  const heading = (text: string) => { y -= 8; ensure(16); page.drawText(winAnsi(text), { x: MARGIN, y: y - 12, size: 12, font: bold, color: INK }); y -= 18; };

  startPage();

  // Title
  page.drawText('Audit Export', { x: MARGIN, y: y - 18, size: 18, font: bold, color: INK });
  y -= 28;

  // Metadata
  heading('Export details');
  for (const m of content.metadata) line(`${m.label}: ${m.value}`);

  // Posture
  heading('Compliance posture (as of generation)');
  for (const p of content.posture) line(`${p.metric}: ${p.value}`);

  // Requirements in force
  heading('Requirements in force');
  if (content.requirements.length === 0) line('No requirements resolved for the scope.', 9, font, 0, MUTED);
  for (const r of content.requirements) line(`${r.location} · ${r.trade} · ${r.requirement} = ${r.required} (${r.source})`, 8);

  // Event trail, grouped by date
  heading('Event trail');
  if (content.events.length === 0) {
    line('No events in scope.', 9, font, 0, MUTED);
  } else {
    let curDate = '';
    for (const e of content.events) {
      const date = e.created_at.slice(0, 10);
      if (date !== curDate) { curDate = date; y -= 4; line(date, 9, bold); }
      const time = e.created_at.slice(11, 19);
      line(`${time}  ${e.actor_type}:${e.actor_id || '-'}  ${e.event_type}  ${e.target_type}:${e.target_id || '-'}`, 8, font, 10);
    }
  }

  // Documents manifest
  heading('Documents on file');
  if (content.documents.length === 0) {
    line('No documents in scope.', 9, font, 0, MUTED);
  } else {
    for (const d of content.documents) {
      const sens = d.sensitive ? `  [${d.sensitive}]` : '';
      line(`${d.vendor} · ${d.doc_type} · uploaded ${d.uploaded_at.slice(0, 10)} · ${d.state}${sens}`, 8);
    }
  }

  return doc.save({ useObjectStreams: false });
}
