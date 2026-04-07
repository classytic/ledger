/**
 * @classytic/ledger — Type Definitions
 */

// Side-effect import: activates the mongokit module augmentation that types
// the `_ledgerInternal` flag on RepositoryContext and SessionOptions so
// plugin authors can observe it without casts.
import './mongokit-augmentation.js';

export type {
  PostingContract,
  PostingResult,
  SubledgerJournalItem,
  // Posting contracts
  SubledgerPostingInput,
} from './contracts.js';
export type {
  AccountType,
  CashFlowCategory,
  Category,
  CategoryKey,
  // Primitives
  Cents,
  // Currency
  Currency,
  CustomDateRange,
  // Date
  DateOption,
  DateRange,
  DateValue,
  EntryState,
  JournalItem,
  // Journal types
  JournalType,
  MainType,
  NormalBalance,
  ObjectId,
  // Operations
  OperationOptions,
  QuarterValue,
  SortDirection,
  SortSpec,
  // Financial categories
  StatementType,
  TaxDetail,
  TaxMetadata,
  TenantContext,
  // Account types
  TotalAccountOp,
} from './core.js';
export type {
  AccountingEngineConfig,
  AuditConfig,
  JournalSchemaOptions,
  ModelNames,
  MultiCurrencyConfig,
  // Engine config
  MultiTenantConfig,
  SchemaOptions,
  StrictnessConfig,
} from './engine.js';
export type { LedgerInternalOp } from './mongokit-augmentation.js';

export type {
  BalanceSheetParams,
  BalanceSheetReport,
  CashFlowReport,
  CashFlowSection,
  GeneralLedgerAccount,
  GeneralLedgerParams,
  GeneralLedgerReport,
  IncomeStatementParams,
  IncomeStatementReport,
  LedgerEntry,
  PeriodParams,
  ReportAccount,
  ReportCategory,
  ReportGroup,
  // Reports
  ReportMetadata,
  TrialBalanceParams,
  TrialBalanceReport,
  TrialBalanceRow,
} from './report.js';
