import { describe, expect, it } from 'vitest';
import { buildCsv, escapeCell, serializeCsv } from '../../src/exports/csv-serializer.js';
import {
  exportToCsv,
  extractAllRows,
  extractRow,
  getHeaders,
} from '../../src/exports/field-map.js';
import { quickbooksFieldMap } from '../../src/exports/field-maps/quickbooks.js';
import { universalFieldMap } from '../../src/exports/field-maps/universal.js';
import type { ExportFieldMap, FlatJournalRow } from '../../src/exports/types.js';

// ── CSV Serializer Edge Cases ─────────────────────────────────────────────

describe('escapeCell (edge cases)', () => {
  it('returns plain string unchanged', () => {
    expect(escapeCell('hello')).toBe('hello');
  });

  it('wraps and escapes double quotes', () => {
    expect(escapeCell('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps strings with commas', () => {
    expect(escapeCell('one,two')).toBe('"one,two"');
  });

  it('wraps strings with newlines', () => {
    expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('wraps strings with carriage returns', () => {
    expect(escapeCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('handles empty string', () => {
    expect(escapeCell('')).toBe('');
  });

  it('handles string with only quotes', () => {
    expect(escapeCell('""')).toBe('""""""');
  });
});

describe('serializeCsv (edge cases)', () => {
  it('serializes single row', () => {
    expect(serializeCsv([['a', 'b', 'c']])).toBe('a,b,c');
  });

  it('serializes multiple rows with CRLF', () => {
    const csv = serializeCsv([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(csv).toBe('a,b\r\nc,d');
  });

  it('handles empty rows array', () => {
    expect(serializeCsv([])).toBe('');
  });

  it('handles custom delimiter', () => {
    const csv = serializeCsv([['a', 'b']], { delimiter: '\t' });
    expect(csv).toBe('a\tb');
  });

  it('handles custom line terminator', () => {
    const csv = serializeCsv([['a'], ['b']], { lineTerminator: '\n' });
    expect(csv).toBe('a\nb');
  });

  it('handles single column', () => {
    const csv = serializeCsv([['only']]);
    expect(csv).toBe('only');
  });
});

describe('buildCsv (edge cases)', () => {
  it('includes headers by default', () => {
    const csv = buildCsv(['H1', 'H2'], [['a', 'b']]);
    expect(csv).toBe('H1,H2\r\na,b');
  });

  it('excludes headers when includeHeaders=false', () => {
    const csv = buildCsv(['H1', 'H2'], [['a', 'b']], { includeHeaders: false });
    expect(csv).toBe('a,b');
  });

  it('handles empty data with headers', () => {
    const csv = buildCsv(['H1', 'H2'], []);
    expect(csv).toBe('H1,H2');
  });
});

// ── Field Map Application ─────────────────────────────────────────────────

const simpleFieldMap: ExportFieldMap<{ name: string; age: number }> = {
  name: 'Test Map',
  target: 'test',
  fields: [
    { header: 'Name', extract: (row) => row.name },
    { header: 'Age', extract: (row) => String(row.age) },
  ],
};

describe('getHeaders', () => {
  it('extracts headers from field map', () => {
    expect(getHeaders(simpleFieldMap)).toEqual(['Name', 'Age']);
  });
});

describe('extractRow', () => {
  it('extracts row using field extractors', () => {
    const row = extractRow(simpleFieldMap, { name: 'Alice', age: 30 });
    expect(row).toEqual(['Alice', '30']);
  });
});

describe('extractAllRows', () => {
  it('extracts multiple rows', () => {
    const rows = extractAllRows(simpleFieldMap, [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
    expect(rows).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  it('handles empty array', () => {
    expect(extractAllRows(simpleFieldMap, [])).toEqual([]);
  });
});

describe('exportToCsv', () => {
  it('produces complete CSV from field map + data', () => {
    const csv = exportToCsv(simpleFieldMap, [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
    expect(csv).toBe('Name,Age\r\nAlice,30\r\nBob,25');
  });

  it('handles empty data', () => {
    const csv = exportToCsv(simpleFieldMap, []);
    expect(csv).toBe('Name,Age');
  });
});

// ── QuickBooks Field Map ──────────────────────────────────────────────────

describe('quickbooksFieldMap', () => {
  const sampleRow: FlatJournalRow = {
    entryId: 'e1',
    journalType: 'SALES',
    referenceNumber: 'SALES/2025/01/0001',
    entryLabel: 'Sale',
    entryDate: new Date(2025, 0, 15), // Jan 15, 2025
    state: 'posted',
    reversed: false,
    totalDebit: 10000,
    totalCredit: 10000,
    accountId: 'acc-1',
    accountName: 'Cash',
    accountTypeCode: '1010',
    itemLabel: 'Cash received',
    itemDate: new Date(2025, 0, 15),
    debit: 10000,
    credit: 0,
    taxCode: 'GST',
    taxName: 'GST 5%',
    itemIndex: 0,
    itemCount: 2,
  };

  it('has 9 columns', () => {
    expect(quickbooksFieldMap.fields).toHaveLength(9);
  });

  it('formats date as MM/DD/YYYY', () => {
    const headers = getHeaders(quickbooksFieldMap);
    const row = extractRow(quickbooksFieldMap, sampleRow);
    expect(headers[0]).toBe('Date');
    expect(row[0]).toBe('01/15/2025');
  });

  it('uses Transaction Type "General Journal"', () => {
    const row = extractRow(quickbooksFieldMap, sampleRow);
    expect(row[1]).toBe('General Journal');
  });

  it('shows debit amount and blank credit for debit line', () => {
    const row = extractRow(quickbooksFieldMap, sampleRow);
    expect(row[6]).toBe('100.00'); // debit
    expect(row[7]).toBe(''); // credit (zero → blank)
  });

  it('shows blank debit and credit amount for credit line', () => {
    const creditRow = { ...sampleRow, debit: 0, credit: 10000 };
    const row = extractRow(quickbooksFieldMap, creditRow);
    expect(row[6]).toBe(''); // debit (zero → blank)
    expect(row[7]).toBe('100.00'); // credit
  });

  it('uses accountName as Account', () => {
    const row = extractRow(quickbooksFieldMap, sampleRow);
    expect(row[5]).toBe('Cash');
  });

  it('falls back to accountTypeCode when accountName empty', () => {
    const noName = { ...sampleRow, accountName: '' };
    const row = extractRow(quickbooksFieldMap, noName);
    expect(row[5]).toBe('1010');
  });

  it('falls back to accountId when both empty', () => {
    const noNameNoCode = { ...sampleRow, accountName: '', accountTypeCode: '' };
    const row = extractRow(quickbooksFieldMap, noNameNoCode);
    expect(row[5]).toBe('acc-1');
  });
});

// ── Universal Field Map ───────────────────────────────────────────────────

describe('universalFieldMap', () => {
  const sampleRow: FlatJournalRow = {
    entryId: 'e1',
    journalType: 'SALES',
    referenceNumber: 'SALES/2025/01/0001',
    entryLabel: 'Sale',
    entryDate: new Date('2025-01-15'),
    state: 'posted',
    reversed: false,
    totalDebit: 10000,
    totalCredit: 10000,
    accountId: 'acc-1',
    accountName: 'Cash',
    accountTypeCode: '1010',
    itemLabel: 'Cash received',
    itemDate: new Date('2025-01-15'),
    debit: 10000,
    credit: 0,
    taxCode: 'GST',
    taxName: 'GST 5%',
    itemIndex: 0,
    itemCount: 2,
  };

  it('has 18 columns', () => {
    expect(universalFieldMap.fields).toHaveLength(18);
  });

  it('formats date as ISO YYYY-MM-DD', () => {
    const row = extractRow(universalFieldMap, sampleRow);
    expect(row[1]).toBe('2025-01-15');
  });

  it('shows reversed as Yes/No', () => {
    const row = extractRow(universalFieldMap, sampleRow);
    expect(row[6]).toBe('No');

    const reversedRow = { ...sampleRow, reversed: true };
    const revRow = extractRow(universalFieldMap, reversedRow);
    expect(revRow[6]).toBe('Yes');
  });

  it('converts cents to dollar strings', () => {
    const row = extractRow(universalFieldMap, sampleRow);
    expect(row[10]).toBe('100.00'); // debit
    expect(row[11]).toBe('0.00'); // credit
  });

  it('shows line number (1-indexed)', () => {
    const row = extractRow(universalFieldMap, sampleRow);
    expect(row[16]).toBe('1'); // itemIndex 0 → Line 1
  });

  it('shows line count', () => {
    const row = extractRow(universalFieldMap, sampleRow);
    expect(row[17]).toBe('2');
  });
});
