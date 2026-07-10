// Shared, client-safe (no DB / Node-only imports) row model for the bulk store+manager import
// (Slice 12/5b, Feature 1). One rule set powers three call sites: live inline validation as an
// operator edits the table, the immediate check after a file upload populates it, and a
// defensive server-side re-check on submit (never trust the client alone).
//
// Deliberate spec deviation from Bulk_Location_Import.md's preview-and-approve-or-reject gate:
// this is a plain editable form. A "bad row" is a red asterisk to fix, not a rejected row in a
// separate report. See docs/decisions.md for the ADR.

export interface ImportLocationRow {
  storeName: string;
  address: string;
  managerFirstName: string;
  managerLastName: string;
  managerEmail: string;
}

export function emptyImportRow(): ImportLocationRow {
  return { storeName: '', address: '', managerFirstName: '', managerLastName: '', managerEmail: '' };
}

export type ImportRowField = keyof ImportLocationRow;

export interface RowFieldErrors {
  storeName?: string;
  address?: string;
  managerEmail?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True if every field is blank — an all-blank row is ignored, not flagged (it's just an unused slot). */
export function isBlankRow(row: ImportLocationRow): boolean {
  return !row.storeName.trim() && !row.address.trim() && !row.managerFirstName.trim() && !row.managerLastName.trim() && !row.managerEmail.trim();
}

/** Per-field validation for one row. Blank rows validate clean (nothing to flag yet). */
export function validateRow(row: ImportLocationRow): RowFieldErrors {
  if (isBlankRow(row)) return {};
  const errors: RowFieldErrors = {};

  if (!row.storeName.trim()) errors.storeName = 'Store name is required';

  const email = row.managerEmail.trim();
  const hasManagerName = !!(row.managerFirstName.trim() || row.managerLastName.trim());
  if (email && !EMAIL_RE.test(email)) {
    errors.managerEmail = 'Enter a valid email address';
  } else if (hasManagerName && !email) {
    errors.managerEmail = 'Manager email is required when a manager name is entered';
  }

  return errors;
}

export function rowIsValid(row: ImportLocationRow): boolean {
  const e = validateRow(row);
  return !e.storeName && !e.address && !e.managerEmail;
}

export interface DuplicateEmailGroup {
  email: string; // normalized (lowercased, trimmed)
  rowIndexes: number[];
}

/** Groups non-blank manager emails that repeat across rows — informational (confirm), not an error. */
export function findDuplicateEmailGroups(rows: ImportLocationRow[]): DuplicateEmailGroup[] {
  const byEmail = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const email = row.managerEmail.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return;
    const list = byEmail.get(email) ?? [];
    list.push(i);
    byEmail.set(email, list);
  });
  return [...byEmail.entries()]
    .filter(([, idxs]) => idxs.length > 1)
    .map(([email, rowIndexes]) => ({ email, rowIndexes }));
}

export interface TableValidation {
  rowErrors: RowFieldErrors[]; // one per row, aligned by index
  duplicateGroups: DuplicateEmailGroup[];
  /** True iff every non-blank row is clean — gates the submit button. */
  isClean: boolean;
  /** Non-blank rows only, in original order — what submit actually sends. */
  nonBlankRows: ImportLocationRow[];
}

export function validateTable(rows: ImportLocationRow[]): TableValidation {
  const rowErrors = rows.map(validateRow);
  const isClean = rowErrors.every((e) => !e.storeName && !e.address && !e.managerEmail);
  return {
    rowErrors,
    duplicateGroups: findDuplicateEmailGroups(rows),
    isClean,
    nonBlankRows: rows.filter((r) => !isBlankRow(r)),
  };
}

// ── Header aliases for file upload (csv/xlsx) — same accepted strings as the original
// Bulk_Location_Import.md table, minus the columns this table doesn't carry (city/state/zip
// collapse into the single free-text Address field the wizard already used). ──

export const HEADER_ALIASES: Record<string, ImportRowField> = {
  'store name': 'storeName',
  'location name': 'storeName',
  'name': 'storeName',
  'address': 'address',
  'street address': 'address',
  'manager first name': 'managerFirstName',
  'first name': 'managerFirstName',
  'manager last name': 'managerLastName',
  'last name': 'managerLastName',
  'manager email': 'managerEmail',
  'email': 'managerEmail',
};

export function mapHeaderRow(rawHeaders: string[]): (ImportRowField | null)[] {
  return rawHeaders.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
}

/** Turns raw parsed cell rows (array-of-arrays, first row = headers) into ImportLocationRow[]. Unrecognized columns are ignored; a completely blank source row is dropped. */
export function rowsFromSheet(cells: string[][]): { rows: ImportLocationRow[]; headerErrors: string[] } {
  if (cells.length === 0) return { rows: [], headerErrors: ['Empty file'] };
  const fieldByCol = mapHeaderRow(cells[0]);
  if (!fieldByCol.includes('storeName')) return { rows: [], headerErrors: ['Missing required column: Store Name (or Location Name)'] };
  if (!fieldByCol.includes('address')) return { rows: [], headerErrors: ['Missing required column: Address (or Street Address)'] };

  const rows: ImportLocationRow[] = [];
  for (const raw of cells.slice(1)) {
    if (raw.every((c) => !c || !c.trim())) continue; // fully blank source row
    const row = emptyImportRow();
    fieldByCol.forEach((field, colIdx) => {
      if (field) row[field] = (raw[colIdx] ?? '').trim();
    });
    rows.push(row);
  }
  return { rows, headerErrors: [] };
}
