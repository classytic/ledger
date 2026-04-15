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

// ── Events (§11-14) ────────────────────────────────────────────────────────

export type { LedgerEventName } from './events/event-constants.js';
export { LEDGER_EVENTS } from './events/event-constants.js';
export type {
  AccountBulkCreatedPayload,
  AccountSeededPayload,
  EntryArchivedPayload,
  EntryCreatedPayload,
  EntryDuplicatedPayload,
  EntryPostedPayload,
  EntryReversedPayload,
  EntryUnpostedPayload,
  JournalSeededPayload,
  ReconciliationMatchedPayload,
  ReconciliationUnmatchedPayload,
} from './events/event-payloads.js';
export type { EventContext } from './events/helpers.js';
export { createEvent } from './events/helpers.js';
export type { InProcessLedgerBusOptions } from './events/in-process-bus.js';
export { InProcessLedgerBus } from './events/in-process-bus.js';
export type {
  OutboxAcknowledgeOptions,
  OutboxClaimOptions,
  OutboxErrorInfo,
  OutboxFailOptions,
  OutboxStore,
  OutboxWriteOptions,
} from './events/outbox-store.js';
export { OutboxOwnershipError } from './events/outbox-store.js';
export type {
  DomainEvent,
  EventHandler,
  EventLogger,
  EventTransport,
  PublishManyResult,
} from './events/transport.js';

// ── Hardening primitives (0.9.0) ───────────────────────────────────────────

export type { ImmutableGuardOptions } from './plugins/immutable-guard.plugin.js';
export { immutableGuardPlugin } from './plugins/immutable-guard.plugin.js';
export type { FieldError } from './utils/errors.js';
export {
  AccountingError,
  ConcurrencyError,
  classifyDuplicateKey,
  DuplicateReferenceError,
  Errors,
  IdempotencyConflictError,
  ImmutableViolationError,
} from './utils/errors.js';

// ── Bridges (§7, §23) ──────────────────────────────────────────────────────

export type {
  EntryReversedNotification,
  LedgerBridges,
  NotificationBridge,
  NotificationBridgeContext,
  PeriodLockedNotification,
  ReconciliationMismatchNotification,
  SourceBridge,
  SourceBridgeContext,
  SourceRef,
} from './bridges/index.js';

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

export type { CreditLimitPluginOptions } from './plugins/credit-limit.plugin.js';
export { creditLimitPlugin } from './plugins/credit-limit.plugin.js';
export { doubleEntryPlugin } from './plugins/double-entry.plugin.js';
export type { FxRealizationPluginOptions } from './plugins/fx-realization.plugin.js';
export { fxRealizationPlugin } from './plugins/fx-realization.plugin.js';
export { idempotencyPlugin } from './plugins/idempotency.plugin.js';
export type {
  CreateLockPluginOptions,
  DailyLockPluginOptions,
  FiscalLockPluginOptions,
  LockAccountSelector,
  LockHit,
  LockResolver,
  LockResolverContext,
  PeriodResolverOptions,
  WatermarkResolverOptions,
} from './plugins/lock/index.js';
export {
  createLockPlugin,
  dailyLockPlugin,
  fiscalLockPlugin,
  periodResolver,
  watermarkResolver,
} from './plugins/lock/index.js';

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
  PartnerLedgerLine,
  PartnerLedgerOptions,
  PartnerLedgerParams,
  PartnerLedgerReport,
} from './reports/partner-ledger.js';
export { generatePartnerLedger } from './reports/partner-ledger.js';
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

export type { CountryPack, CountryPackInput, JournalTemplate } from './country/index.js';
export { defineCountryPack } from './country/index.js';

// ── Repository Types ──────────────────────────────────────────────────────

export type {
  MatchHookContext,
  MatchHookItem,
  UnmatchHookContext,
} from './repositories/reconciliation.repository.js';
export type {
  AccountRepository,
  BulkCreateInput,
  BulkCreateResult,
  JournalEntryRepository,
  JournalItemRef,
  JournalRepository,
  MatchInput,
  OpenItem,
  PostOptions,
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
