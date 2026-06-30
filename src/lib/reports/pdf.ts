// Report PDF rendering with pdf-lib. Print typography (not screen): Letter page, generous
// margins, Helvetica, a ruled header band (tenant name) and a footer (report name · generation
// timestamp · applied filters · page number). Empty reports render a single clean page.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ReportTable } from './project';
import type { ReportFilters } from './index';

const PAGE_W = 612, PAGE_H = 792, MARGIN = 50;
const TITLE_SIZE = 18, SUB_SIZE = 10, HEAD_SIZE = 9, BODY_SIZE = 9, FOOT_SIZE = 8;
const ROW_H = 16;
const INK = rgb(0.13, 0.15, 0.18), MUTED = rgb(0.45, 0.48, 0.52), LINE = rgb(0.82, 0.84, 0.86);

function filtersLine(f: ReportFilters): string {
  const parts: string[] = [];
  if (f.region) parts.push(`region=${f.region}`);
  if (f.location) parts.push(`location=${f.location}`);
  if (f.trade) parts.push(`trade=${f.trade}`);
  if (f.from) parts.push(`from=${f.from.slice(0, 10)}`);
  if (f.to) parts.push(`to=${f.to.slice(0, 10)}`);
  return parts.length ? parts.join(', ') : 'none';
}

// StandardFonts use WinAnsi (≈ latin1); map common Unicode punctuation to ASCII and drop any
// remaining non-encodable codepoint, so report text never crashes the PDF embedder.
export function winAnsi(s: string): string {
  return s
    .replace(/→/g, '->').replace(/←/g, '<-')
    .replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[^\x00-\xFF]/g, '?');
}

function fit(text: string | number, font: PDFFont, size: number, maxW: number): string {
  let s = winAnsi(String(text ?? ''));
  const ell = '...';
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  while (s.length > 1 && font.widthOfTextAtSize(s + ell, size) > maxW) s = s.slice(0, -1);
  return s + ell;
}

export async function renderReportPdf(input: {
  tenantName: string;
  table: ReportTable;
  generatedAt: string;
  filters: ReportFilters;
}): Promise<Uint8Array> {
  const { tenantName, table, generatedAt, filters } = input;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const footText = `${table.title}  ·  generated ${new Date(generatedAt).toLocaleString()}  ·  filters: ${filtersLine(filters)}`;
  let pageNum = 0;

  const newPage = (): { page: PDFPage; y: number } => {
    pageNum++;
    const page = doc.addPage([PAGE_W, PAGE_H]);
    // header band — operator (tenant) name
    page.drawText(fit(tenantName, bold, 10, PAGE_W - 2 * MARGIN), { x: MARGIN, y: PAGE_H - MARGIN + 6, size: 10, font: bold, color: MUTED });
    page.drawLine({ start: { x: MARGIN, y: PAGE_H - MARGIN }, end: { x: PAGE_W - MARGIN, y: PAGE_H - MARGIN }, thickness: 0.5, color: LINE });
    // footer
    page.drawText(fit(footText, font, FOOT_SIZE, PAGE_W - 2 * MARGIN - 60), { x: MARGIN, y: MARGIN - 22, size: FOOT_SIZE, font, color: MUTED });
    page.drawText(`Page ${pageNum}`, { x: PAGE_W - MARGIN - 40, y: MARGIN - 22, size: FOOT_SIZE, font, color: MUTED });
    return { page, y: PAGE_H - MARGIN - 24 };
  };

  let { page, y } = newPage();

  // Title + subtitle
  page.drawText(fit(table.title, bold, TITLE_SIZE, PAGE_W - 2 * MARGIN), { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold, color: INK });
  y -= TITLE_SIZE + 8;
  if (table.subtitle) {
    page.drawText(fit(table.subtitle, font, SUB_SIZE, PAGE_W - 2 * MARGIN), { x: MARGIN, y: y - SUB_SIZE, size: SUB_SIZE, font, color: MUTED });
    y -= SUB_SIZE + 14;
  } else {
    y -= 6;
  }

  if (table.rows.length === 0) {
    page.drawText('No results for the selected scope / filters.', { x: MARGIN, y: y - 14, size: 11, font, color: MUTED });
    return doc.save();
  }

  // Column geometry — first column wider, rest equal.
  const usableW = PAGE_W - 2 * MARGIN;
  const n = table.columns.length;
  const firstW = usableW * Math.min(0.32, 1.6 / n);
  const restW = (usableW - firstW) / (n - 1 || 1);
  const colX = (i: number) => MARGIN + (i === 0 ? 0 : firstW + (i - 1) * restW);
  const colW = (i: number) => (i === 0 ? firstW : restW) - 6;

  const drawHeader = () => {
    for (let i = 0; i < n; i++) {
      page.drawText(fit(table.columns[i], bold, HEAD_SIZE, colW(i)), { x: colX(i), y: y - HEAD_SIZE, size: HEAD_SIZE, font: bold, color: INK });
    }
    y -= ROW_H;
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: PAGE_W - MARGIN, y: y + 4 }, thickness: 0.5, color: LINE });
  };
  drawHeader();

  for (const row of table.rows) {
    if (y < MARGIN + 8) { ({ page, y } = newPage()); drawHeader(); }
    for (let i = 0; i < n; i++) {
      page.drawText(fit(row[i], font, BODY_SIZE, colW(i)), { x: colX(i), y: y - BODY_SIZE, size: BODY_SIZE, font, color: INK });
    }
    y -= ROW_H;
  }

  // useObjectStreams:false keeps content streams uncompressed → drawn text stays literal in
  // the bytes. This makes the defensibility Sensitive-scan over the PDF output meaningful
  // (a leak would be findable), at the cost of a slightly larger file — fine for compliance PDFs.
  return doc.save({ useObjectStreams: false });
}
