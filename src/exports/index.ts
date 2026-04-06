/**
 * @classytic/ledger/exports
 *
 * Generic CSV export builder with predefined field maps for
 * QuickBooks and universal journal entry export.
 *
 * Pure data transformations — no DB, no I/O, no side effects.
 */

export { buildCsv, escapeCell, serializeCsv } from './csv-serializer.js';
export { exportToCsv, extractAllRows, extractRow, getHeaders } from './field-map.js';
export { quickbooksFieldMap } from './field-maps/quickbooks.js';
export { universalFieldMap } from './field-maps/universal.js';
export { flattenJournalEntries, flattenJournalEntry } from './flatten-journal.js';

export type {
  CsvOptions,
  ExportField,
  ExportFieldMap,
  FlatJournalRow,
  PopulatedAccount,
  PopulatedJournalEntry,
  PopulatedJournalItem,
} from './types.js';
