/**
 * @classytic/ledger
 *
 * Production-grade double-entry accounting engine for MongoDB.
 * Built on @classytic/mongokit. Designed for multi-tenant SaaS,
 * AI-powered finance, and global tax compliance.
 *
 * @example
 * ```typescript
 * import { createAccountingEngine } from '@classytic/ledger';
 * import { canadaPack } from '@classytic/ledger-ca';
 *
 * const accounting = createAccountingEngine({
 *   country: canadaPack,
 *   currency: 'CAD',
 *   multiTenant: { orgField: 'business', orgRef: 'Business' },
 * });
 *
 * const AccountSchema = accounting.createAccountSchema();
 * const JournalEntrySchema = accounting.createJournalEntrySchema('Account');
 * ```
 *
 * @module @classytic/ledger
 * @author Classytic (https://github.com/classytic)
 * @license MIT
 */

// ── Engine ─────────────────────────────────────────────────────────────────

export { AccountingEngine, createAccountingEngine } from './engine.js';

// ── Money ──────────────────────────────────────────────────────────────────

export { Money } from './money.js';
export {
  fromDecimal,
  toDecimal,
  add,
  subtract,
  multiply,
  percentage,
  splitTaxInclusive,
  splitTaxExclusive,
  allocate,
  format,
  formatPlain,
  parseCents,
} from './money.js';

// ── Schemas ────────────────────────────────────────────────────────────────

export { createAccountSchema } from './schemas/account.schema.js';
export { createJournalEntrySchema } from './schemas/journal-entry.schema.js';
export { createFiscalPeriodSchema } from './schemas/fiscal-period.schema.js';

// ── Plugins ────────────────────────────────────────────────────────────────

export { doubleEntryPlugin } from './plugins/double-entry.plugin.js';
export { fiscalLockPlugin } from './plugins/fiscal-lock.plugin.js';

// ── Reports ────────────────────────────────────────────────────────────────

export { generateTrialBalance } from './reports/trial-balance.js';
export { generateBalanceSheet } from './reports/balance-sheet.js';
export { generateIncomeStatement } from './reports/income-statement.js';
export { generateGeneralLedger } from './reports/general-ledger.js';
export { generateCashFlow } from './reports/cash-flow.js';
export { closeFiscalPeriod, reopenFiscalPeriod } from './reports/fiscal-close.js';

// ── Constants ──────────────────────────────────────────────────────────────

export {
  CATEGORIES,
  CATEGORY_KEYS,
  isValidCategory,
  getNormalBalance,
  isBalanceSheet,
  isIncomeStatement,
} from './constants/categories.js';

export {
  JOURNAL_TYPES,
  JOURNAL_CODES,
  getJournalTypeCodes,
  isValidJournalType,
} from './constants/journals.js';

export {
  CURRENCIES,
  getCurrency,
  isValidCurrency,
  getMinorUnit,
} from './constants/currencies.js';

// ── Country Pack ───────────────────────────────────────────────────────────

export { defineCountryPack } from './country/index.js';
export type {
  CountryPack,
  CountryPackInput,
  TaxCode,
  TaxCodesByRegion,
  TaxReportLine,
  TaxReportTemplate,
} from './country/index.js';

// ── Repositories ──────────────────────────────────────────────────────────

export { wireJournalEntryMethods } from './repositories/journal-entry.repository.js';
export { wireAccountMethods } from './repositories/account.repository.js';

// ── Utilities ──────────────────────────────────────────────────────────────

export {
  getDateRange,
  getFiscalYearStart,
} from './utils/date-range.js';

export {
  isVirtualTaxAccount,
  computeEndingBalance,
  calculateTotal,
  buildAccountTypeMap,
} from './utils/account-helpers.js';

export { AccountingError, Errors } from './utils/errors.js';
export { defaultLogger } from './utils/logger.js';
export type { Logger } from './utils/logger.js';
export { acquireSession, finalizeSession } from './utils/session.js';
export type { SessionResult } from './utils/session.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type {
  // Core
  Cents,
  StatementType,
  MainType,
  CategoryKey,
  NormalBalance,
  CashFlowCategory,
  AccountType,
  TotalAccountOp,
  TaxMetadata,
  JournalType,
  EntryState,
  TaxDetail,
  JournalItem,
  Currency,
  DateOption,
  DateRange,

  // Engine
  AccountingEngineConfig,
  MultiTenantConfig,
  SchemaOptions,
  JournalSchemaOptions,

  // Reports
  TrialBalanceReport,
  TrialBalanceRow,
  BalanceSheetReport,
  IncomeStatementReport,
  GeneralLedgerReport,
  GeneralLedgerAccount,
  LedgerEntry,
  CashFlowReport,
  CashFlowSection,
  TaxReport,
  TaxReturnSummary,
  ReportCategory,
  ReportGroup,
  ReportAccount,
} from './types/index.js';

// ── Exports ───────────────────────────────────────────────────────────────

export {
  exportToCsv,
  flattenJournalEntries,
  quickbooksFieldMap,
  universalFieldMap,
} from './exports/index.js';

export type {
  PopulatedJournalEntry,
  FlatJournalRow,
  ExportFieldMap,
  ExportField,
} from './exports/index.js';
