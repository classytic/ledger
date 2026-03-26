import { describe, it, expect } from 'vitest';
import { flattenJournalEntry, flattenJournalEntries } from '../../src/exports/flatten-journal.js';
import type { PopulatedJournalEntry, PopulatedAccount } from '../../src/exports/types.js';

const makeEntry = (overrides: Partial<PopulatedJournalEntry> = {}): PopulatedJournalEntry => ({
  _id: 'entry-1',
  journalType: 'SALES',
  referenceNumber: 'SALES/2025/01/0001',
  label: 'Test Sale',
  date: new Date('2025-01-15'),
  journalItems: [
    {
      account: { _id: 'acc-1', accountTypeCode: '4000', name: 'Revenue' } as PopulatedAccount,
      label: 'Sale line 1',
      debit: 0,
      credit: 10000,
      taxDetails: [{ taxCode: 'GST', taxName: 'GST 5%' }],
    },
    {
      account: { _id: 'acc-2', accountTypeCode: '1010', name: 'Cash' } as PopulatedAccount,
      label: 'Cash received',
      debit: 10000,
      credit: 0,
    },
  ],
  totalDebit: 10000,
  totalCredit: 10000,
  state: 'posted',
  ...overrides,
});

describe('flattenJournalEntry', () => {
  it('creates one row per journal item', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows).toHaveLength(2);
  });

  it('populates entry-level fields on each row', () => {
    const rows = flattenJournalEntry(makeEntry());
    for (const row of rows) {
      expect(row.entryId).toBe('entry-1');
      expect(row.journalType).toBe('SALES');
      expect(row.referenceNumber).toBe('SALES/2025/01/0001');
      expect(row.entryLabel).toBe('Test Sale');
      expect(row.state).toBe('posted');
      expect(row.totalDebit).toBe(10000);
      expect(row.totalCredit).toBe(10000);
    }
  });

  it('populates item-level fields', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[0].accountName).toBe('Revenue');
    expect(rows[0].accountTypeCode).toBe('4000');
    expect(rows[0].debit).toBe(0);
    expect(rows[0].credit).toBe(10000);
    expect(rows[0].taxCode).toBe('GST');
    expect(rows[0].taxName).toBe('GST 5%');

    expect(rows[1].accountName).toBe('Cash');
    expect(rows[1].debit).toBe(10000);
    expect(rows[1].credit).toBe(0);
  });

  it('tracks itemIndex and itemCount', () => {
    const rows = flattenJournalEntry(makeEntry());
    expect(rows[0].itemIndex).toBe(0);
    expect(rows[0].itemCount).toBe(2);
    expect(rows[1].itemIndex).toBe(1);
    expect(rows[1].itemCount).toBe(2);
  });

  it('handles string account references', () => {
    const entry = makeEntry({
      journalItems: [
        { account: 'acc-string-id', debit: 5000, credit: 0 },
        { account: 'acc-string-id2', debit: 0, credit: 5000 },
      ],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].accountId).toBe('acc-string-id');
    expect(rows[0].accountName).toBe('');
    expect(rows[0].accountTypeCode).toBe('');
  });

  it('handles null/undefined account', () => {
    const entry = makeEntry({
      journalItems: [
        { account: null as any, debit: 5000, credit: 0 },
        { account: undefined as any, debit: 0, credit: 5000 },
      ],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].accountId).toBe('');
    expect(rows[1].accountId).toBe('');
  });

  it('handles entry with no items', () => {
    const entry = makeEntry({ journalItems: [] });
    const rows = flattenJournalEntry(entry);
    expect(rows).toHaveLength(0);
  });

  it('handles missing label', () => {
    const entry = makeEntry({ label: undefined });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].entryLabel).toBe('');
  });

  it('handles reversed flag', () => {
    const entry = makeEntry({ reversed: true });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].reversed).toBe(true);
  });

  it('defaults reversed to false', () => {
    const entry = makeEntry({ reversed: undefined });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].reversed).toBe(false);
  });

  it('handles missing taxDetails', () => {
    const entry = makeEntry({
      journalItems: [
        { account: { _id: 'a1', accountTypeCode: '1010' } as PopulatedAccount, debit: 5000, credit: 0 },
      ],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].taxCode).toBe('');
    expect(rows[0].taxName).toBe('');
  });

  it('handles string date on entry', () => {
    const entry = makeEntry({ date: '2025-06-15' as any });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].entryDate).toBeInstanceOf(Date);
  });

  it('handles item-level dates', () => {
    const itemDate = new Date('2025-02-01');
    const entry = makeEntry({
      journalItems: [
        {
          account: { _id: 'a1', accountTypeCode: '1010' } as PopulatedAccount,
          debit: 5000, credit: 0, date: itemDate,
        },
      ],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].itemDate.getTime()).toBe(itemDate.getTime());
  });

  it('uses entry date as item date fallback', () => {
    const entryDate = new Date('2025-03-01');
    const entry = makeEntry({
      date: entryDate,
      journalItems: [
        { account: { _id: 'a1', accountTypeCode: '1010' } as PopulatedAccount, debit: 5000, credit: 0 },
      ],
    });
    const rows = flattenJournalEntry(entry);
    expect(rows[0].itemDate.getTime()).toBe(entryDate.getTime());
  });
});

describe('flattenJournalEntries', () => {
  it('flattens multiple entries', () => {
    const entries = [makeEntry(), makeEntry({ _id: 'entry-2' })];
    const rows = flattenJournalEntries(entries);
    expect(rows).toHaveLength(4); // 2 items each
  });

  it('handles empty array', () => {
    const rows = flattenJournalEntries([]);
    expect(rows).toHaveLength(0);
  });

  it('preserves order', () => {
    const entries = [
      makeEntry({ _id: 'first' }),
      makeEntry({ _id: 'second' }),
    ];
    const rows = flattenJournalEntries(entries);
    expect(rows[0].entryId).toBe('first');
    expect(rows[2].entryId).toBe('second');
  });
});
