// Server-only file parsing for the bulk store+manager import (Slice 12/5b, Feature 1). xlsx/xls
// go through exceljs (Node-native; not bundled into any client component — see the ADR in
// docs/decisions.md for why exceljs over SheetJS/xlsx: the npm-published xlsx package carries
// two unpatched high-severity CVEs, prototype pollution + ReDoS, with no fix available via npm —
// a bad fit for a feature whose whole job is parsing untrusted uploaded files).
//
// CSV reuses the existing hand-rolled parser (src/lib/csv.ts). Both funnel into
// rowsFromSheet (src/lib/import/location-rows.ts) so header-alias handling is identical
// regardless of file type.

import ExcelJS from 'exceljs';
import { parseCSV } from '@/lib/csv';
import { rowsFromSheet, type ImportLocationRow } from './location-rows';

export interface ParseFileResult {
  rows: ImportLocationRow[];
  headerErrors: string[];
}

function cellsFromCSV(text: string): string[][] {
  const parsed = parseCSV(text);
  if (parsed.headers.length === 0) return [];
  return [parsed.headers, ...parsed.rows.map((row) => parsed.headers.map((h) => row[h] ?? ''))];
}

async function cellsFromWorkbook(buffer: ArrayBuffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const cells: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // 1-indexed; index 0 is unused
    const line: string[] = [];
    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      line.push(v === null || v === undefined ? '' : String(v).trim());
    }
    cells.push(line);
  });
  return cells;
}

/** filename decides the parse path: .csv → text parser, .xlsx/.xls → exceljs. Anything else is rejected. */
export async function parseSpreadsheetFile(filename: string, buffer: ArrayBuffer): Promise<ParseFileResult> {
  const lower = filename.toLowerCase();
  let cells: string[][];

  if (lower.endsWith('.csv')) {
    cells = cellsFromCSV(Buffer.from(buffer).toString('utf-8'));
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    try {
      cells = await cellsFromWorkbook(buffer);
    } catch {
      return { rows: [], headerErrors: ['Could not read this file — is it a valid .xlsx spreadsheet?'] };
    }
  } else {
    return { rows: [], headerErrors: ['Unsupported file type — upload a .csv or .xlsx file.'] };
  }

  return rowsFromSheet(cells);
}
