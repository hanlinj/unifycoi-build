// CSV rendering — RFC 4180 quoting, UTF-8 BOM (Excel), header row required.
// Built as a single string for v1 (reports are bounded; true streaming is a later swap for
// very large org rosters — see Phase 9 checkpoint).

const BOM = '\uFEFF';

function escapeField(value: string | number): string {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** columns + rows → CSV text (with BOM + header). An empty `rows` yields headers only. */
export function toCsv(columns: string[], rows: (string | number)[][]): string {
  const lines = [columns.map(escapeField).join(',')];
  for (const r of rows) lines.push(r.map(escapeField).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}
