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
 *   multiTenant: { tenantField: 'business', ref: 'Business' },
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

// Transport shapes come from @classytic/primitives/events. Ledger's local
// `EventLogger` is tied to the in-process bus implementation.
export type {
  DomainEvent,
  EventHandler,
  EventTransport,
  PublishManyResult,
} from '@classytic/primitives/events';
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
export type { EventLogger, InProcessLedgerBusOptions } from './events/in-process-bus.js';
export { InProcessLedgerBus } from './events/in-process-bus.js';
export type {
  LedgerEventDefinition,
  LedgerEventPayloadOf,
  LedgerEventSchema,
} from './events/ledger-event-catalog.js';
// Arc 2.10 EventRegistry catalog — Zod-backed definitions + JSON Schemas
// derived via `z.toJSONSchema()`. See PACKAGE_RULES §18.5.
export {
  AccountBulkCreated,
  AccountSeeded,
  EntryArchived,
  EntryCreated,
  EntryDuplicated,
  EntryPosted,
  EntryReversed,
  EntryUnposted,
  JournalSeeded,
  ledgerEventDefinitions,
  ReconciliationMatched,
  ReconciliationUnmatched,
} from './events/ledger-event-catalog.js';
export type {
  OutboxAcknowledgeOptions,
  OutboxClaimOptions,
  OutboxErrorInfo,
  OutboxFailOptions,
  OutboxFailureContext,
  OutboxFailureDecision,
  OutboxFailurePolicy,
  OutboxStore,
  OutboxWriteOptions,
} from './events/outbox-store.js';
export { InvalidOutboxEventError, OutboxOwnershipError } from './events/outbox-store.js';

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
  ExchangeRateBridge,
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

export { AccountingEngine, assertLedgerCapabilities, createAccountingEngine } from './engine.js';
export type { LedgerModels, ResolvedModelNames } from './models/factory.js';
export { createModels, resolveModelNames } from './models/factory.js';
export type {
  LedgerPaginationConfig,
  LedgerRepositories,
  LedgerRepositoryPlugins,
} from './repositories/factory.js';
export { createRepositories } from './repositories/factory.js';

// ── Public input shapes + builders ─────────────────────────────────────────

// `buildOpeningBalanceEntry` is a pure (no DB, no Mongoose) function that
// turns a list of account balances into a balanced journal entry. Used
// internally by `engine.record.openingBalance(...)` and exposed publicly
// so cutover/migration tooling in hosts can call it without instantiating
// the engine.
export type {
  OpeningBalanceInput,
  OpeningBalanceResult,
} from './builders/opening-balance.js';
export { buildOpeningBalanceEntry } from './builders/opening-balance.js';
// `JournalEntryInput` / `JournalItemInput` describe the shape accepted by
// `journalEntries.create()`. Hosts that build journal entries from external
// sources (CSV imports, third-party API mappers, etc.) populate this shape.
// In 0.10.x these lived under `@classytic/ledger/sync`; that subpath was
// removed in 0.11.0 — these types now ride the main entry.
export type { JournalEntryInput, JournalItemInput } from './types/journal-input.js';

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
// Opt-in index recommendations for source-provenance fields.
//   - `ENTRY_SOURCE_INDEX`    — entry-level `sourceRef.*`. The bookkeeping
//     "show JEs produced by this source document" drill-down. Add this
//     whenever the host stamps `JournalEntry.sourceRef`.
//   - `LINE_SOURCE_INDEXES`   — per-line `journalItems.sourceRef.*` +
//     `journalItems.linkedRefs.*`. Add when the host stamps per-line
//     source pointers (one payment settling N invoices, etc.).
// Hosts that don't query by a given level can omit its index and pay no
// per-insert index cost.
export {
  ENTRY_SOURCE_INDEX,
  LINE_SOURCE_INDEXES,
} from './schemas/journal-entry.schema.js';

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
  UpdateDraftOptions,
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
  BalanceSheetLineSource,
  BalanceSheetReport,
  BalanceSheetSection,
  CashFlowCategory,
  CashFlowReport,
  CashFlowSection,
  CategoryKey,
  // Core
  Cents,
  ComparativeMode,
  Currency,
  DateOption,
  DateRange,
  EntryState,
  GeneralLedgerAccount,
  GeneralLedgerReport,
  IncomeStatementLineSource,
  IncomeStatementReport,
  IncomeStatementSection,
  JournalItem,
  JournalSchemaOptions,
  JournalType,
  LedgerEntry,
  MainType,
  ModelNames,
  MultiCurrencyConfig,
  MultiTenantConfig,
  NormalBalance,
  PeriodColumn,
  PostingContract,
  PostingResult,
  ReportAccount,
  ReportCategory,
  ReportGroup,
  ReportLine,
  ReportSection,
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
  TrialBalanceColumnRow,
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
