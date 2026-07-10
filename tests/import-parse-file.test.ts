import ExcelJS from 'exceljs';
import { parseSpreadsheetFile } from '@/lib/import/parse-file';

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function makeWorkbookBuffer(headers: string[], rows: string[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(headers);
  for (const r of rows) sheet.addRow(r);
  const written = await wb.xlsx.writeBuffer();
  return toArrayBuffer(Buffer.from(written));
}

describe('parseSpreadsheetFile — csv', () => {
  test('parses a valid csv', async () => {
    const csv = 'Store Name,Address,Manager First Name,Manager Last Name,Manager Email\nMain St,1 Main St,Bob,Jones,bob@store.test\n';
    const buf = toArrayBuffer(Buffer.from(csv, 'utf-8'));
    const result = await parseSpreadsheetFile('stores.csv', buf);
    expect(result.headerErrors).toHaveLength(0);
    expect(result.rows).toEqual([{ storeName: 'Main St', address: '1 Main St', managerFirstName: 'Bob', managerLastName: 'Jones', managerEmail: 'bob@store.test' }]);
  });

  test('missing required column is rejected', async () => {
    const buf = toArrayBuffer(Buffer.from('Address\n1 Main St\n', 'utf-8'));
    const result = await parseSpreadsheetFile('bad.csv', buf);
    expect(result.headerErrors.length).toBeGreaterThan(0);
  });
});

describe('parseSpreadsheetFile — xlsx', () => {
  test('parses a real .xlsx workbook via exceljs', async () => {
    const buf = await makeWorkbookBuffer(
      ['Store Name', 'Address', 'Manager Email'],
      [
        ['Main St', '1 Main St', 'bob@store.test'],
        ['Oak Ave', '2 Oak Ave', ''],
      ]
    );
    const result = await parseSpreadsheetFile('stores.xlsx', buf);
    expect(result.headerErrors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].storeName).toBe('Main St');
    expect(result.rows[0].managerEmail).toBe('bob@store.test');
    expect(result.rows[1].managerEmail).toBe('');
  });

  test('an unreadable file produces a header error, not a throw', async () => {
    const result = await parseSpreadsheetFile('corrupt.xlsx', toArrayBuffer(Buffer.from('not a real workbook')));
    expect(result.headerErrors.length).toBeGreaterThan(0);
  });
});

describe('parseSpreadsheetFile — unsupported type', () => {
  test('rejects a non csv/xlsx filename', async () => {
    const result = await parseSpreadsheetFile('stores.txt', toArrayBuffer(Buffer.from('x')));
    expect(result.headerErrors.length).toBeGreaterThan(0);
  });
});
