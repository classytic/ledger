/**
 * QuickBooks General Journal Import Field Map
 *
 * Produces CSV compatible with QuickBooks Desktop and Online
 * "Import General Journal Entries" feature.
 *
 * @module @classytic/ledger/exports
 */

import { Money } from '../../money.js';
import type { ExportFieldMap, FlatJournalRow } from '../types.js';

function formatQbDate(date: Date): string {
  // MM/DD/YYYY in UTC — deterministic across deploy machines, never
  // server-local getMonth/getDate (which would shift the exported date across
  // midnight on a non-UTC host). The static field map has no engine config, so
  // UTC is the stable choice; a zone-aware export can thread a zone in later.
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const y = date.getUTCFullYear();
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
    { header: 'Date', extract: (row) => formatQbDate(row.entryDate) },
    { header: 'Transaction Type', extract: () => 'General Journal' },
    { header: 'Num', extract: (row) => row.referenceNumber },
    { header: 'Name', extract: () => '' },
    { header: 'Memo/Description', extract: (row) => row.itemLabel || row.entryLabel },
    {
      header: 'Account',
      extract: (row) => row.accountName || row.accountTypeCode || row.accountId,
    },
    { header: 'Debit', extract: (row) => amountOrBlank(row.debit) },
    { header: 'Credit', extract: (row) => amountOrBlank(row.credit) },
    { header: 'Class', extract: () => '' },
  ],
};
