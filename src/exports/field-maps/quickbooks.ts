/**
 * QuickBooks General Journal Import Field Map
 *
 * Produces CSV compatible with QuickBooks Desktop and Online
 * "Import General Journal Entries" feature.
 *
 * @module @classytic/ledger/exports
 */

import type { ExportFieldMap, FlatJournalRow } from '../types.js';
import { Money } from '../../money.js';

function formatQbDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  return `${m}/${d}/${y}`;
}

/** Convert integer cents to dollar string, blank for zero. */
function amountOrBlank(cents: number): string {
  if (cents === 0) return '';
  return Money.formatPlain(cents);
}

export const quickbooksFieldMap: ExportFieldMap<FlatJournalRow> = {
  name: 'QuickBooks General Journal',
  target: 'quickbooks',
  fields: [
    { header: 'Date',             extract: (row) => formatQbDate(row.entryDate) },
    { header: 'Transaction Type', extract: () => 'General Journal' },
    { header: 'Num',              extract: (row) => row.referenceNumber },
    { header: 'Name',             extract: () => '' },
    { header: 'Memo/Description', extract: (row) => row.itemLabel || row.entryLabel },
    { header: 'Account',          extract: (row) => row.accountName || row.accountTypeCode || row.accountId },
    { header: 'Debit',            extract: (row) => amountOrBlank(row.debit) },
    { header: 'Credit',           extract: (row) => amountOrBlank(row.credit) },
    { header: 'Class',            extract: () => '' },
  ],
};
