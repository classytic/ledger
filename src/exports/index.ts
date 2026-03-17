/**
 * @classytic/ledger/exports
 *
 * Generic CSV export builder with predefined field maps for
 * QuickBooks and universal journal entry export.
 *
 * Pure data transformations — no DB, no I/O, no side effects.
 */

export { escapeCell, serializeCsv, buildCsv } from './csv-serializer.js';
export { getHeaders, extractRow, extractAllRows, exportToCsv } from './field-map.js';
export { flattenJournalEntry, flattenJournalEntries } from './flatten-journal.js';
export { quickbooksFieldMap } from './field-maps/quickbooks.js';
export { universalFieldMap } from './field-maps/universal.js';

export type {
  PopulatedAccount,
  PopulatedJournalItem,
  PopulatedJournalEntry,
  FlatJournalRow,
  ExportField,
  ExportFieldMap,
  CsvOptions,
} from './types.js';
