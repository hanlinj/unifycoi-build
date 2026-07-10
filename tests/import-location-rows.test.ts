import {
  emptyImportRow,
  validateRow,
  rowIsValid,
  isBlankRow,
  findDuplicateEmailGroups,
  validateTable,
  rowsFromSheet,
  type ImportLocationRow,
} from '@/lib/import/location-rows';

function row(overrides: Partial<ImportLocationRow> = {}): ImportLocationRow {
  return { ...emptyImportRow(), ...overrides };
}

describe('isBlankRow / validateRow', () => {
  test('a fully blank row is blank and valid', () => {
    expect(isBlankRow(row())).toBe(true);
    expect(validateRow(row())).toEqual({});
    expect(rowIsValid(row())).toBe(true);
  });

  test('store name is required once a row is non-blank', () => {
    const errors = validateRow(row({ address: '123 Main' }));
    expect(errors.storeName).toBeTruthy();
  });

  test('address is optional', () => {
    expect(rowIsValid(row({ storeName: 'Main St' }))).toBe(true);
  });

  test('a bad email format is flagged even with no manager name', () => {
    const errors = validateRow(row({ storeName: 'Main St', managerEmail: 'not-an-email' }));
    expect(errors.managerEmail).toBeTruthy();
  });

  test('manager name without an email is flagged', () => {
    const errors = validateRow(row({ storeName: 'Main St', managerFirstName: 'Bob' }));
    expect(errors.managerEmail).toMatch(/required/i);
  });

  test('manager email alone (no name) is fine', () => {
    expect(rowIsValid(row({ storeName: 'Main St', managerEmail: 'bob@store.test' }))).toBe(true);
  });

  test('a fully clean row with a manager has no errors', () => {
    expect(rowIsValid(row({ storeName: 'Main St', address: '1 Main St', managerFirstName: 'Bob', managerLastName: 'Jones', managerEmail: 'bob@store.test' }))).toBe(true);
  });
});

describe('findDuplicateEmailGroups', () => {
  test('flags the same email on multiple rows, case-insensitively', () => {
    const rows = [
      row({ storeName: 'A', managerEmail: 'Alice@Store.test' }),
      row({ storeName: 'B', managerEmail: 'alice@store.test' }),
      row({ storeName: 'C', managerEmail: 'carl@store.test' }),
    ];
    const groups = findDuplicateEmailGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].email).toBe('alice@store.test');
    expect(groups[0].rowIndexes).toEqual([0, 1]);
  });

  test('a unique email per row produces no groups', () => {
    const rows = [row({ managerEmail: 'a@x.test' }), row({ managerEmail: 'b@x.test' })];
    expect(findDuplicateEmailGroups(rows)).toHaveLength(0);
  });

  test('blank/invalid emails are ignored, not grouped together', () => {
    const rows = [row({ managerEmail: '' }), row({ managerEmail: '' }), row({ managerEmail: 'not-an-email' }), row({ managerEmail: 'not-an-email' })];
    expect(findDuplicateEmailGroups(rows)).toHaveLength(0);
  });
});

describe('validateTable', () => {
  test('isClean is true when every non-blank row is valid', () => {
    const t = validateTable([row({ storeName: 'A' }), row(), row({ storeName: 'B', managerEmail: 'b@x.test' })]);
    expect(t.isClean).toBe(true);
    expect(t.nonBlankRows).toHaveLength(2);
  });

  test('isClean is false when any non-blank row has an error', () => {
    const t = validateTable([row({ storeName: 'A' }), row({ managerFirstName: 'Bob' })]); // row 2: name w/o email
    expect(t.isClean).toBe(false);
  });

  test('a fully blank row does not block isClean', () => {
    const t = validateTable([row({ storeName: 'A' }), row(), row()]);
    expect(t.isClean).toBe(true);
  });
});

describe('rowsFromSheet — header aliasing', () => {
  test('rejects a sheet missing the Store Name column', () => {
    const { headerErrors } = rowsFromSheet([['Address'], ['123 Main']]);
    expect(headerErrors.length).toBeGreaterThan(0);
  });

  test('rejects a sheet missing the Address column', () => {
    const { headerErrors } = rowsFromSheet([['Store Name'], ['Main St']]);
    expect(headerErrors.length).toBeGreaterThan(0);
  });

  test('accepts aliased headers (Location Name, First Name, Last Name, Email)', () => {
    const { rows, headerErrors } = rowsFromSheet([
      ['Location Name', 'Street Address', 'First Name', 'Last Name', 'Email'],
      ['Main St', '1 Main St', 'Bob', 'Jones', 'bob@store.test'],
    ]);
    expect(headerErrors).toHaveLength(0);
    expect(rows).toEqual([{ storeName: 'Main St', address: '1 Main St', managerFirstName: 'Bob', managerLastName: 'Jones', managerEmail: 'bob@store.test' }]);
  });

  test('unrecognized columns are ignored, not fatal', () => {
    const { rows, headerErrors } = rowsFromSheet([
      ['Store Name', 'Address', 'Phone', 'Notes'],
      ['Main St', '1 Main St', '555-1234', 'nice store'],
    ]);
    expect(headerErrors).toHaveLength(0);
    expect(rows[0].storeName).toBe('Main St');
  });

  test('a fully blank source row is dropped', () => {
    const { rows } = rowsFromSheet([['Store Name', 'Address'], ['Main St', '1 Main St'], ['', '']]);
    expect(rows).toHaveLength(1);
  });

  test('an empty file produces a header error', () => {
    expect(rowsFromSheet([]).headerErrors.length).toBeGreaterThan(0);
  });
});
