/**
 * `@classytic/ledger/sync` — import/export bridge between fin-io's canonical
 * shapes and the ledger's JournalEntry repository.
 *
 * Public API:
 *
 *   import {
 *     wireImport,
 *     wireExport,
 *     bankStatementMapper,
 *     invoiceMapper,
 *     journalEntryMapper,
 *   } from '@classytic/ledger/sync';
 *
 * Each mapper converts a specific fin-io canonical shape into a JournalEntry
 * creation payload:
 *
 *   bankStatementMapper   — CanonicalTransaction → 2-line JE (Cash ↔ Suspense)
 *                            Works with all bank parsers: OFX, CAMT, MT940, CSV, Plaid
 *   invoiceMapper         — CanonicalInvoice → multi-line JE (AR/AP ↔ Revenue/Expense ↔ Tax)
 *                            Works with QBO + Xero invoice JSON
 *   journalEntryMapper    — CanonicalJournalEntry → multi-line JE (1:1 mapping)
 *                            Works with QBO + Xero manual journal JSON
 *
 * wireImport ties them together:
 *
 *   const importer = wireImport({
 *     source: parsed.data.flatMap(s => s.transactions),
 *     mapper: bankStatementMapper({ bankAccountId, suspenseAccountId }),
 *     journalEntries: repo,
 *     context: { organizationId },
 *   });
 *   const report = await importer.run();
 *   console.log(`imported ${report.inserted}, skipped ${report.skipped}`);
 *
 * wireExport is the symmetric helper for extracting ledger data into external
 * formats (CSV, OFX, IIF) via fin-io's emitters.
 */

// Re-export sync types so consumers don't need two imports
export type {
  ExportReport,
  ExportSink,
  ImportContext,
  ImportError,
  ImportMapper,
  ImportReport,
  JournalEntryInput,
  JournalItemInput,
  WireExportArgs,
  WireImportArgs,
} from '../types/sync';
export type { OpeningBalanceInput, OpeningBalanceResult } from './builders/opening-balance';
export { buildOpeningBalanceEntry } from './builders/opening-balance';
export type {
  LedgerBridge,
  LedgerBridgeAccounts,
  LedgerBridgeConfig,
  LedgerPaymentInput,
  LedgerPostInput,
  LedgerPostLine,
  LedgerReverseContext,
} from './ledger-bridge';
export { createLedgerBridge } from './ledger-bridge';
export type { BankStatementMapperConfig } from './mappers/bank-statement';
export { bankStatementMapper } from './mappers/bank-statement';
export type { InvoiceMapperConfig } from './mappers/invoice';
export { invoiceMapper } from './mappers/invoice';
export type { JournalEntryMapperConfig } from './mappers/journal-entry';
export { journalEntryMapper } from './mappers/journal-entry';
export type { OpeningBalanceMapperConfig, TrialBalanceInput } from './mappers/opening-balance';
export { openingBalanceMapper } from './mappers/opening-balance';
export { wireExport } from './wire-export';
export { wireImport } from './wire-import';
