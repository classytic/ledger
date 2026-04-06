import { describe, expect, it } from 'vitest';
import {
  buildCsv,
  escapeCell,
  exportToCsv,
  extractAllRows,
  extractRow,
  flattenJournalEntries,
  flattenJournalEntry,
  getHeaders,
  quickbooksFieldMap,
  serializeCsv,
  universalFieldMap,
} from '../../src/exports/index.js';
import type { FlatJournalRow, PopulatedJournalEntry } from '../../src/exports/types.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<PopulatedJournalEntry>): PopulatedJournalEntry {
  return {
    _id: 'entry-1',
    journalType: 'GENERAL',
    referenceNumber: 'GENERAL/2025/01/0001',
    label: 'Office supplies purchase',
    date: new Date('2025-01-15'),
    journalItems: [
      {
        account: { _id: 'acc-1', accountTypeCode: '5000', name: 'Office Supplies Expense' },
        label: 'Staples order',
        date: new Date('2025-01-15'),
        debit: 5000,
        credit: 0,
        taxDetails: [{ taxCode: 'GST5', taxName: 'GST 5%' }],
      },
      {
        account: { _id: 'acc-2', accountTypeCode: '1060', name: 'Chequing Account' },
        label: '',
        debit: 0,
        credit: 5000,
        taxDetails: [],
      },
    ],
    totalDebit: 5000,
    totalCredit: 5000,
    state: 'posted',
    reversed: false,
    ...overrides,
  };
}

function makeFlatRow(overrides?: Partial<FlatJournalRow>): FlatJournalRow {
  return {
    entryId: 'entry-1',
    journalType: 'GENERAL',
    referenceNumber: 'GENERAL/2025/01/0001',
    entryLabel: 'Office supplies purchase',
    entryDate: new Date('2025-01-15'),
    state: 'posted',
    reversed: false,
    totalDebit: 5000,
    totalCredit: 5000,
    accountId: 'acc-1',
    accountName: 'Office Supplies Expense',
    accountTypeCode: '5000',
    itemLabel: 'Staples order',
    itemDate: new Date('2025-01-15'),
    debit: 5000,
    credit: 0,
    taxCode: 'GST5',
    taxName: 'GST 5%',
    itemIndex: 0,
    itemCount: 2,
    ...overrides,
  };
}

// ── CSV Serializer ───────────────────────────────────────────────────────────

describe('CSV Serializer', () => {
  describe('escapeCell', () => {
    it('passes through plain strings unchanged', () => {
      expect(escapeCell('hello')).toBe('hello');
    });

    it('wraps values containing commas in double quotes', () => {
      expect(escapeCell('hello, world')).toBe('"hello, world"');
    });

    it('wraps values containing double quotes and doubles internal quotes', () => {
      expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
    });

    it('wraps values containing newlines', () => {
      expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
      expect(escapeCell('line1\r\nline2')).toBe('"line1\r\nline2"');
    });

    it('handles empty string', () => {
      expect(escapeCell('')).toBe('');
    });
  });

  describe('serializeCsv', () => {
    it('serializes a simple 2D array to CSV', () => {
      const rows = [
        ['a', 'b'],
        ['c', 'd'],
      ];
      expect(serializeCsv(rows)).toBe('a,b\r\nc,d');
    });

    it('uses CRLF line terminators by default', () => {
      const rows = [['x'], ['y']];
      expect(serializeCsv(rows)).toBe('x\r\ny');
    });

    it('respects custom delimiter', () => {
      const rows = [['a', 'b']];
      expect(serializeCsv(rows, { delimiter: '\t' })).toBe('a\tb');
    });

    it('respects custom line terminator', () => {
      const rows = [['a'], ['b']];
      expect(serializeCsv(rows, { lineTerminator: '\n' })).toBe('a\nb');
    });

    it('handles empty rows array', () => {
      expect(serializeCsv([])).toBe('');
    });

    it('handles rows with empty cells', () => {
      const rows = [['', 'b', '']];
      expect(serializeCsv(rows)).toBe(',b,');
    });
  });

  describe('buildCsv', () => {
    it('includes header row by default', () => {
      const csv = buildCsv(['Name', 'Age'], [['Alice', '30']]);
      expect(csv).toBe('Name,Age\r\nAlice,30');
    });

    it('omits header row when includeHeaders is false', () => {
      const csv = buildCsv(['Name', 'Age'], [['Alice', '30']], { includeHeaders: false });
      expect(csv).toBe('Alice,30');
    });

    it('produces correct output with headers and multiple data rows', () => {
      const csv = buildCsv(['X'], [['1'], ['2'], ['3']]);
      expect(csv).toBe('X\r\n1\r\n2\r\n3');
    });
  });
});

// ── Flatten Journal ──────────────────────────────────────────────────────────

describe('flattenJournalEntry', () => {
  it('produces one row per journal item', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows).toHaveLength(2);
  });

  it('repeats entry-level fields on every row', () => {
    const rows = flattenJournalEntry(makeEntry());
    for (const row of rows) {
      expect(row.entryId).toBe('entry-1');
      expect(row.referenceNumber).toBe('GENERAL/2025/01/0001');
      expect(row.journalType).toBe('GENERAL');
      expect(row.state).toBe('posted');
    }
  });

  it('extracts account name/id/typeCode from populated accounts', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[0].accountName).toBe('Office Supplies Expense');
    expect(rows[0].accountId).toBe('acc-1');
    expect(rows[0].accountTypeCode).toBe('5000');
  });

  it('handles unpopulated (string) account references', () => {
    const entry = makeEntry({
      journalItems: [{ account: 'raw-id-123', debit: 1000, credit: 0 }],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].accountId).toBe('raw-id-123');
    expect(rows[0].accountName).toBe('');
  });

  it('handles missing account', () => {
    const entry = makeEntry({
      journalItems: [{ account: null as any, debit: 1000, credit: 0 }],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].accountId).toBe('');
    expect(rows[0].accountName).toBe('');
  });

  it('converts string dates to Date objects', () => {
    const entry = makeEntry({ date: '2025-06-15T00:00:00.000Z' });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].entryDate).toBeInstanceOf(Date);
    expect(rows[0].entryDate.getFullYear()).toBe(2025);
  });

  it('uses entry date when item date is missing', () => {
    const entry = makeEntry({
      journalItems: [
        {
          account: { _id: 'a', accountTypeCode: '1000', name: 'Cash' },
          debit: 1000,
          credit: 0,
        },
      ],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].itemDate.getTime()).toBe(rows[0].entryDate.getTime());
  });

  it('extracts first taxDetail to taxCode/taxName', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[0].taxCode).toBe('GST5');
    expect(rows[0].taxName).toBe('GST 5%');
  });

  it('handles empty taxDetails', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[1].taxCode).toBe('');
    expect(rows[1].taxName).toBe('');
  });

  it('sets itemIndex and itemCount correctly', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[0].itemIndex).toBe(0);
    expect(rows[0].itemCount).toBe(2);
    expect(rows[1].itemIndex).toBe(1);
    expect(rows[1].itemCount).toBe(2);
  });

  it('handles entry with zero items', () => {
    const entry = makeEntry({ journalItems: [] });
    const rows = flattenJournalEntry(entry);
    expect(rows).toHaveLength(0);
  });

  it('preserves cent amounts without conversion', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[0].debit).toBe(5000);
    expect(rows[0].credit).toBe(0);
    expect(rows[1].debit).toBe(0);
    expect(rows[1].credit).toBe(5000);
  });
});

describe('flattenJournalEntries', () => {
  it('flattens multiple entries into a single array', () => {
    const entries = [makeEntry(), makeEntry({ _id: 'entry-2' })];
    const rows = flattenJournalEntries(entries);
    expect(rows).toHaveLength(4);
  });

  it('maintains entry order', () => {
    const entries = [makeEntry({ _id: 'first' }), makeEntry({ _id: 'second' })];
    const rows = flattenJournalEntries(entries);
    expect(rows[0].entryId).toBe('first');
    expect(rows[2].entryId).toBe('second');
  });

  it('handles empty entries array', () => {
    expect(flattenJournalEntries([])).toHaveLength(0);
  });
});

// ── Field Map Application ────────────────────────────────────────────────────

describe('Field Map Application', () => {
  it('returns headers from quickbooks field map', () => {
    const headers = getHeaders(quickbooksFieldMap);
    expect(headers).toEqual([
      'Date',
      'Transaction Type',
      'Num',
      'Name',
      'Memo/Description',
      'Account',
      'Debit',
      'Credit',
      'Class',
    ]);
  });

  it('returns headers from universal field map', () => {
    const headers = getHeaders(universalFieldMap);
    expect(headers[0]).toBe('Entry ID');
    expect(headers).toHaveLength(18);
  });

  it('extracts a single row with quickbooks field map', () => {
    const row = makeFlatRow();
    const cells = extractRow(quickbooksFieldMap, row);
    expect(cells).toHaveLength(9);
    expect(cells[0]).toBe('01/15/2025');
    expect(cells[1]).toBe('General Journal');
  });

  it('maps all rows through field map', () => {
    const rows = [makeFlatRow(), makeFlatRow({ debit: 0, credit: 5000 })];
    const result = extractAllRows(quickbooksFieldMap, rows);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(9);
  });

  it('returns empty array for empty input', () => {
    expect(extractAllRows(quickbooksFieldMap, [])).toHaveLength(0);
  });

  it('produces complete CSV with exportToCsv', () => {
    const rows = [makeFlatRow()];
    const csv = exportToCsv(quickbooksFieldMap, rows);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Date');
    expect(lines[1]).toContain('01/15/2025');
  });
});

// ── QuickBooks Field Map ─────────────────────────────────────────────────────

describe('QuickBooks Field Map', () => {
  it('formats date as MM/DD/YYYY', () => {
    const row = makeFlatRow({ entryDate: new Date('2025-03-05') });
    const cells = extractRow(quickbooksFieldMap, row);
    expect(cells[0]).toBe('03/05/2025');
  });

  it('sets Transaction Type to General Journal', () => {
    const cells = extractRow(quickbooksFieldMap, makeFlatRow());
    expect(cells[1]).toBe('General Journal');
  });

  it('uses referenceNumber as Num', () => {
    const cells = extractRow(quickbooksFieldMap, makeFlatRow());
    expect(cells[2]).toBe('GENERAL/2025/01/0001');
  });

  it('uses item label, falls back to entry label for Memo', () => {
    const cells1 = extractRow(quickbooksFieldMap, makeFlatRow({ itemLabel: 'Item memo' }));
    expect(cells1[4]).toBe('Item memo');

    const cells2 = extractRow(quickbooksFieldMap, makeFlatRow({ itemLabel: '' }));
    expect(cells2[4]).toBe('Office supplies purchase');
  });

  it('returns empty string for zero debit/credit', () => {
    const cells = extractRow(quickbooksFieldMap, makeFlatRow({ debit: 0, credit: 5000 }));
    expect(cells[6]).toBe('');
    expect(cells[7]).toBe('50.00');
  });

  it('converts debit to decimal string', () => {
    const cells = extractRow(quickbooksFieldMap, makeFlatRow({ debit: 12345 }));
    expect(cells[6]).toBe('123.45');
  });
});

// ── Universal Field Map ──────────────────────────────────────────────────────

describe('Universal Field Map', () => {
  it('formats date as YYYY-MM-DD ISO', () => {
    const row = makeFlatRow({ entryDate: new Date('2025-03-05T00:00:00Z') });
    const cells = extractRow(universalFieldMap, row);
    expect(cells[1]).toBe('2025-03-05');
  });

  it('always shows 0.00 for zero amounts', () => {
    const cells = extractRow(universalFieldMap, makeFlatRow({ debit: 0, credit: 0 }));
    expect(cells[10]).toBe('0.00');
    expect(cells[11]).toBe('0.00');
  });

  it('shows Yes/No for reversed flag', () => {
    const cellsNo = extractRow(universalFieldMap, makeFlatRow({ reversed: false }));
    expect(cellsNo[6]).toBe('No');

    const cellsYes = extractRow(universalFieldMap, makeFlatRow({ reversed: true }));
    expect(cellsYes[6]).toBe('Yes');
  });

  it('shows 1-based line numbers', () => {
    const cells = extractRow(universalFieldMap, makeFlatRow({ itemIndex: 0 }));
    expect(cells[16]).toBe('1');
  });
});

// ── End-to-end ───────────────────────────────────────────────────────────────

describe('End-to-end: entries -> CSV', () => {
  it('produces valid QuickBooks CSV from journal entries', () => {
    const entries = [makeEntry()];
    const flatRows = flattenJournalEntries(entries);
    const csv = exportToCsv(quickbooksFieldMap, flatRows);

    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 items

    // Header row
    expect(lines[0]).toBe(
      'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit,Class',
    );

    // First item: debit line
    expect(lines[1]).toContain('01/15/2025');
    expect(lines[1]).toContain('General Journal');
    expect(lines[1]).toContain('Office Supplies Expense');
    expect(lines[1]).toContain('50.00');

    // Second item: credit line
    expect(lines[2]).toContain('Chequing Account');
  });

  it('handles multiple entries in sequence', () => {
    const entries = [
      makeEntry({ _id: 'e1', referenceNumber: 'GEN/2025/01/0001' }),
      makeEntry({
        _id: 'e2',
        referenceNumber: 'GEN/2025/01/0002',
        label: 'Rent payment',
        journalItems: [
          {
            account: { _id: 'a3', accountTypeCode: '6000', name: 'Rent Expense' },
            label: 'Jan rent',
            debit: 150000,
            credit: 0,
          },
          {
            account: { _id: 'a4', accountTypeCode: '1060', name: 'Chequing Account' },
            label: '',
            debit: 0,
            credit: 150000,
          },
        ],
        totalDebit: 150000,
        totalCredit: 150000,
      }),
    ];

    const csv = exportToCsv(quickbooksFieldMap, flattenJournalEntries(entries));
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(5); // header + 4 items
    expect(lines[3]).toContain('Rent Expense');
    expect(lines[3]).toContain('1500.00');
  });
});
