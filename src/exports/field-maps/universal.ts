/**
 * Universal Export Field Map
 *
 * Comprehensive CSV export with all available fields.
 * Useful for data portability, auditing, or spreadsheet import.
 *
 * @module @classytic/ledger/exports
 */

import { Money } from '../../money.js';
import type { ExportFieldMap, FlatJournalRow } from '../types.js';

function formatIsoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Convert integer cents to dollar string (e.g. 10050 → "100.50"). */
function centsToDisplay(cents: number): string {
  return Money.formatPlain(cents);
}

export const universalFieldMap: ExportFieldMap<FlatJournalRow> = {
  name: 'Universal Journal Export',
  target: 'universal',
  fields: [
    { header: 'Entry ID', extract: (row) => row.entryId },
    { header: 'Date', extract: (row) => formatIsoDate(row.entryDate) },
    { header: 'Journal Type', extract: (row) => row.journalType },
    { header: 'Reference Number', extract: (row) => row.referenceNumber },
    { header: 'Entry Description', extract: (row) => row.entryLabel },
    { header: 'State', extract: (row) => row.state },
    { header: 'Reversed', extract: (row) => (row.reversed ? 'Yes' : 'No') },
    { header: 'Account Code', extract: (row) => row.accountTypeCode },
    { header: 'Account Name', extract: (row) => row.accountName },
    { header: 'Line Description', extract: (row) => row.itemLabel },
    { header: 'Debit', extract: (row) => centsToDisplay(row.debit) },
    { header: 'Credit', extract: (row) => centsToDisplay(row.credit) },
    { header: 'Tax Code', extract: (row) => row.taxCode },
    { header: 'Tax Name', extract: (row) => row.taxName },
    { header: 'Entry Total Debit', extract: (row) => centsToDisplay(row.totalDebit) },
    { header: 'Entry Total Credit', extract: (row) => centsToDisplay(row.totalCredit) },
    { header: 'Line', extract: (row) => String(row.itemIndex + 1) },
    { header: 'Line Count', extract: (row) => String(row.itemCount) },
  ],
};
