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
export type { LedgerModels, ResolvedModelNames } from './models/factory.js';
export { createModels, resolveModelNames } from './models/factory.js';
export type {
  LedgerPaginationConfig,
  LedgerRepositories,
  LedgerRepositoryPlugins,
} from './repositories/factory.js';
export { createRepositories } from './repositories/factory.js';

// ── Semantic Primitives (for AI agents, MCP tools, apps) ──────────────────

export type {
  AccountSummary,
  FiscalPeriodSummary,
  IntrospectAPI,
  ReportDescriptor,
} from './semantic/introspect.js';
export type {
  AccountCode,
  ActorContext,
  Cents as SemanticCents,
  RecordAdjustmentInput,
  RecordAdjustmentLine,
  RecordAPI,
  RecordExpenseInput,
  RecordOptions,
  RecordPaymentInput,
  RecordSaleInput,
  RecordTransferInput,
  TaxInput,
} from './semantic/record.js';

// ── Money ──────────────────────────────────────────────────────────────────

export {
  add,
  allocate,
  format,
  formatPlain,
  fromDecimal,
  Money,
  multiply,
  parseCents,
  percentage,
  splitTaxExclusive,
  splitTaxInclusive,
  subtract,
  toDecimal,
} from './money.js';

// ── Plugins ────────────────────────────────────────────────────────────────

export { dateLockPlugin } from './plugins/date-lock.plugin.js';
export { doubleEntryPlugin } from './plugins/double-entry.plugin.js';
export { fiscalLockPlugin } from './plugins/fiscal-lock.plugin.js';
export { idempotencyPlugin } from './plugins/idempotency.plugin.js';

// ── Reports ────────────────────────────────────────────────────────────────

export type {
  AgedBalanceOptions,
  AgedBalanceParams,
  AgedBalanceReport,
  AgedBalanceRow,
  AgedBucketConfig,
} from './reports/aged-balance.js';
export { DEFAULT_BUCKETS, generateAgedBalance } from './reports/aged-balance.js';
export { generateBalanceSheet } from './reports/balance-sheet.js';
export type {
  BudgetVsActualOptions,
  BudgetVsActualParams,
  BudgetVsActualReport,
  BudgetVsActualRow,
} from './reports/budget-vs-actual.js';
export { generateBudgetVsActual } from './reports/budget-vs-actual.js';
export { generateCashFlow } from './reports/cash-flow.js';
export { generateDimensionBreakdown } from './reports/dimension-breakdown.js';
export { closeFiscalPeriod, reopenFiscalPeriod } from './reports/fiscal-close.js';
export { generateGeneralLedger } from './reports/general-ledger.js';
export { generateIncomeStatement } from './reports/income-statement.js';
export type {
  RevaluationOptions,
  RevaluationParams,
  RevaluationReport,
} from './reports/revaluation.js';
export { generateRevaluation } from './reports/revaluation.js';
export { generateTrialBalance } from './reports/trial-balance.js';
export type {
  AccountForeignBalance,
  RevaluationRate,
  RevaluationResult,
} from './utils/revaluation.js';
export { buildRevaluationEntry, computeRevaluation } from './utils/revaluation.js';

// ── Constants ──────────────────────────────────────────────────────────────

export {
  CATEGORIES,
  CATEGORY_KEYS,
  getNormalBalance,
  isBalanceSheet,
  isIncomeStatement,
  isValidCategory,
} from './constants/categories.js';
export {
  CURRENCIES,
  getCurrency,
  getMinorUnit,
  isValidCurrency,
} from './constants/currencies.js';
export {
  getCustomJournalTypes,
  getJournalType,
  getJournalTypeCodes,
  isValidJournalType,
  JOURNAL_CODES,
  JOURNAL_TYPES,
  registerJournalType,
} from './constants/journals.js';

// ── Country Pack ───────────────────────────────────────────────────────────

export type {
  CountryPack,
  CountryPackInput,
  TaxCode,
  TaxCodesByRegion,
  TaxReportLine,
  TaxReportTemplate,
} from './country/index.js';
export { defineCountryPack } from './country/index.js';

// ── Repository Types ──────────────────────────────────────────────────────

export type {
  AccountRepository,
  BulkCreateInput,
  BulkCreateResult,
  JournalEntryRepository,
  PostOptions,
  ReconcileParams,
  ReconciliationRepository,
  ReverseOptions,
  ReverseResult,
  SeedOptions,
  SeedResult,
} from './types/repositories.js';

// ── Utilities ──────────────────────────────────────────────────────────────

export {
  buildAccountTypeMap,
  calculateTotal,
  computeEndingBalance,
  isVirtualTaxAccount,
} from './utils/account-helpers.js';
export {
  getDateRange,
  getFiscalYearStart,
} from './utils/date-range.js';
export type { DimensionDefinition } from './utils/dimensions.js';
export { buildDimensionFields, buildDimensionIndexes } from './utils/dimensions.js';
export type { FieldError } from './utils/errors.js';
export { AccountingError, Errors } from './utils/errors.js';
export { buildItemFilters } from './utils/filter-builder.js';
export type { Logger } from './utils/logger.js';
export { defaultLogger } from './utils/logger.js';
export type { SessionResult } from './utils/session.js';
export { acquireSession, finalizeSession } from './utils/session.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type {
  DimensionBreakdownOptions,
  DimensionBreakdownParams,
  DimensionBreakdownReport,
  DimensionBreakdownRow,
} from './reports/dimension-breakdown.js';
export type {
  // Engine
  AccountingEngineConfig,
  AccountType,
  AuditConfig,
  BalanceSheetReport,
  CashFlowCategory,
  CashFlowReport,
  CashFlowSection,
  CategoryKey,
  // Core
  Cents,
  Currency,
  DateOption,
  DateRange,
  EntryState,
  GeneralLedgerAccount,
  GeneralLedgerReport,
  IncomeStatementReport,
  JournalItem,
  JournalSchemaOptions,
  JournalType,
  LedgerEntry,
  MainType,
  ModelNames,
  MultiCurrencyConfig,
  MultiTenantConfig,
  NormalBalance,
  PostingContract,
  PostingResult,
  ReportAccount,
  ReportCategory,
  ReportGroup,
  SchemaOptions,
  StatementType,
  StrictnessConfig,
  SubledgerJournalItem,
  // Posting Contracts
  SubledgerPostingInput,
  TaxDetail,
  TaxMetadata,
  TaxReport,
  TaxReturnSummary,
  TotalAccountOp,
  // Reports
  TrialBalanceReport,
  TrialBalanceRow,
} from './types/index.js';

// ── Exports ───────────────────────────────────────────────────────────────

export type {
  ExportField,
  ExportFieldMap,
  FlatJournalRow,
  PopulatedJournalEntry,
} from './exports/index.js';
export {
  exportToCsv,
  flattenJournalEntries,
  quickbooksFieldMap,
  universalFieldMap,
} from './exports/index.js';
