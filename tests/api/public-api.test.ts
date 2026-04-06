/**
 * Public API Surface Test
 *
 * Verifies every runtime export from @classytic/ledger is importable,
 * defined, and has the correct type. Inspired by @classytic/flow's
 * index-verification pattern.
 *
 * If this test breaks, it means a public export was removed or renamed —
 * which is a breaking change for consumers.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';

// ── Import every runtime export from the root barrel ──────────────────────

import {
  // Engine
  AccountingEngine,
  createAccountingEngine,

  // Money
  Money,
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

  // Schemas
  createAccountSchema,
  createJournalEntrySchema,
  createFiscalPeriodSchema,

  // Plugins
  dateLockPlugin,
  doubleEntryPlugin,
  fiscalLockPlugin,
  idempotencyPlugin,

  // Reports
  generateTrialBalance,
  generateBalanceSheet,
  generateIncomeStatement,
  generateGeneralLedger,
  generateCashFlow,
  closeFiscalPeriod,
  reopenFiscalPeriod,
  generateDimensionBreakdown,
  generateAgedBalance,
  DEFAULT_BUCKETS,
  generateRevaluation,
  generateBudgetVsActual,
  computeRevaluation,
  buildRevaluationEntry,

  // Constants
  CATEGORIES,
  CATEGORY_KEYS,
  isValidCategory,
  getNormalBalance,
  isBalanceSheet,
  isIncomeStatement,
  JOURNAL_TYPES,
  JOURNAL_CODES,
  getJournalTypeCodes,
  isValidJournalType,
  getJournalType,
  registerJournalType,
  getCustomJournalTypes,
  CURRENCIES,
  getCurrency,
  isValidCurrency,
  getMinorUnit,

  // Country
  defineCountryPack,

  // Repositories
  wireJournalEntryMethods,
  wireAccountMethods,
  wireReconciliationMethods,

  // Utilities
  getDateRange,
  getFiscalYearStart,
  isVirtualTaxAccount,
  computeEndingBalance,
  calculateTotal,
  buildAccountTypeMap,
  AccountingError,
  Errors,
  defaultLogger,
  acquireSession,
  finalizeSession,
  buildItemFilters,
  buildDimensionFields,
  buildDimensionIndexes,

  // Exports
  exportToCsv,
  flattenJournalEntries,
  quickbooksFieldMap,
  universalFieldMap,
} from '../../src/index.js';

// ── Import type-only exports to verify they compile ───────────────────────

import type {
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
  AccountingEngineConfig,
  MultiTenantConfig,
  MultiCurrencyConfig,
  SchemaOptions,
  JournalSchemaOptions,
  AuditConfig,
  StrictnessConfig,
  SubledgerPostingInput,
  SubledgerJournalItem,
  PostingContract,
  PostingResult,
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
  BudgetVsActualOptions,
  BudgetVsActualParams,
  BudgetVsActualReport,
  BudgetVsActualRow,
  CountryPack,
  CountryPackInput,
  TaxCode,
  TaxCodesByRegion,
  TaxReportLine,
  TaxReportTemplate,
  JournalEntryRepository,
  AccountRepository,
  ReconciliationRepository,
  PostOptions,
  ReverseOptions,
  SeedOptions,
  SeedResult,
  BulkCreateInput,
  BulkCreateResult,
  ReverseResult,
  ReconcileParams,
  Logger,
  SessionResult,
  DimensionDefinition,
  AgedBucketConfig,
  AgedBalanceOptions,
  AgedBalanceParams,
  AgedBalanceRow,
  AgedBalanceReport,
  RevaluationOptions,
  RevaluationParams,
  RevaluationReport,
  RevaluationRate,
  AccountForeignBalance,
  RevaluationResult,
  DimensionBreakdownOptions,
  DimensionBreakdownParams,
  DimensionBreakdownRow,
  DimensionBreakdownReport,
  PopulatedJournalEntry,
  FlatJournalRow,
  ExportFieldMap,
  ExportField,
} from '../../src/index.js';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Public API — runtime exports', () => {
  describe('Engine', () => {
    it('exports AccountingEngine class', () => {
      expect(AccountingEngine).toBeDefined();
      expectTypeOf(AccountingEngine).toBeFunction();
    });

    it('exports createAccountingEngine factory', () => {
      expect(createAccountingEngine).toBeDefined();
      expectTypeOf(createAccountingEngine).toBeFunction();
    });
  });

  describe('Money', () => {
    const moneyFns = {
      Money, fromDecimal, toDecimal, add, subtract, multiply,
      percentage, splitTaxInclusive, splitTaxExclusive,
      allocate, format, formatPlain, parseCents,
    };

    it('exports all 13 money functions/classes', () => {
      for (const [name, fn] of Object.entries(moneyFns)) {
        expect(fn, `${name} should be defined`).toBeDefined();
      }
    });

    it('Money is a namespace object with helper methods', () => {
      expect(typeof Money).toBe('object');
      expect(Money).toHaveProperty('add');
      expect(Money).toHaveProperty('subtract');
      expect(Money).toHaveProperty('fromDecimal');
    });

    it('arithmetic functions return numbers', () => {
      expect(typeof add(100, 200)).toBe('number');
      expect(typeof subtract(300, 100)).toBe('number');
      expect(typeof multiply(100, 2)).toBe('number');
    });
  });

  describe('Schemas', () => {
    it('exports all schema factories as functions', () => {
      expectTypeOf(createAccountSchema).toBeFunction();
      expectTypeOf(createJournalEntrySchema).toBeFunction();
      expectTypeOf(createFiscalPeriodSchema).toBeFunction();
    });
  });

  describe('Plugins', () => {
    it('exports all 4 plugins as objects', () => {
      expect(dateLockPlugin).toBeDefined();
      expect(doubleEntryPlugin).toBeDefined();
      expect(fiscalLockPlugin).toBeDefined();
      expect(idempotencyPlugin).toBeDefined();
    });

    it('each plugin has a name and apply method', () => {
      for (const plugin of [dateLockPlugin, doubleEntryPlugin, fiscalLockPlugin, idempotencyPlugin]) {
        expect(plugin).toHaveProperty('name');
        expect(plugin).toHaveProperty('apply');
        expect(typeof plugin.apply).toBe('function');
      }
    });
  });

  describe('Reports', () => {
    const reportFns = {
      generateTrialBalance,
      generateBalanceSheet,
      generateIncomeStatement,
      generateGeneralLedger,
      generateCashFlow,
      closeFiscalPeriod,
      reopenFiscalPeriod,
      generateDimensionBreakdown,
      generateAgedBalance,
      generateRevaluation,
      generateBudgetVsActual,
      computeRevaluation,
      buildRevaluationEntry,
    };

    it('exports all 13 report functions', () => {
      for (const [name, fn] of Object.entries(reportFns)) {
        expect(fn, `${name} should be defined`).toBeDefined();
        expect(typeof fn, `${name} should be a function`).toBe('function');
      }
    });

    it('exports DEFAULT_BUCKETS constant', () => {
      expect(DEFAULT_BUCKETS).toBeDefined();
      expect(Array.isArray(DEFAULT_BUCKETS)).toBe(true);
    });
  });

  describe('Constants', () => {
    it('exports frozen CATEGORIES object', () => {
      expect(CATEGORIES).toBeDefined();
      expect(Object.isFrozen(CATEGORIES)).toBe(true);
    });

    it('exports frozen JOURNAL_TYPES with 15 built-in types', () => {
      expect(JOURNAL_TYPES).toBeDefined();
      expect(Object.isFrozen(JOURNAL_TYPES)).toBe(true);
      expect(Object.keys(JOURNAL_TYPES).length).toBe(15);
    });

    it('exports frozen CURRENCIES object', () => {
      expect(CURRENCIES).toBeDefined();
      expect(Object.isFrozen(CURRENCIES)).toBe(true);
    });

    it('exports all category helper functions', () => {
      expect(typeof isValidCategory).toBe('function');
      expect(typeof getNormalBalance).toBe('function');
      expect(typeof isBalanceSheet).toBe('function');
      expect(typeof isIncomeStatement).toBe('function');
    });

    it('exports all journal helper functions including registry', () => {
      expect(typeof getJournalTypeCodes).toBe('function');
      expect(typeof isValidJournalType).toBe('function');
      expect(typeof getJournalType).toBe('function');
      expect(typeof registerJournalType).toBe('function');
      expect(typeof getCustomJournalTypes).toBe('function');
    });

    it('exports all currency helper functions', () => {
      expect(typeof getCurrency).toBe('function');
      expect(typeof isValidCurrency).toBe('function');
      expect(typeof getMinorUnit).toBe('function');
    });
  });

  describe('Country', () => {
    it('exports defineCountryPack factory', () => {
      expect(typeof defineCountryPack).toBe('function');
    });
  });

  describe('Repositories', () => {
    it('exports all 3 wire functions', () => {
      expect(typeof wireJournalEntryMethods).toBe('function');
      expect(typeof wireAccountMethods).toBe('function');
      expect(typeof wireReconciliationMethods).toBe('function');
    });
  });

  describe('Utilities', () => {
    it('exports date utilities', () => {
      expect(typeof getDateRange).toBe('function');
      expect(typeof getFiscalYearStart).toBe('function');
    });

    it('exports account helpers', () => {
      expect(typeof isVirtualTaxAccount).toBe('function');
      expect(typeof computeEndingBalance).toBe('function');
      expect(typeof calculateTotal).toBe('function');
      expect(typeof buildAccountTypeMap).toBe('function');
    });

    it('exports error hierarchy', () => {
      expect(AccountingError).toBeDefined();
      expect(Errors).toBeDefined();
      expect(typeof Errors.validation).toBe('function');
      expect(typeof Errors.notFound).toBe('function');
      expect(typeof Errors.conflict).toBe('function');
      expect(typeof Errors.immutable).toBe('function');
      expect(typeof Errors.fiscal).toBe('function');
    });

    it('exports logger', () => {
      expect(defaultLogger).toBeDefined();
    });

    it('exports session helpers', () => {
      expect(typeof acquireSession).toBe('function');
      expect(typeof finalizeSession).toBe('function');
    });

    it('exports filter and dimension builders', () => {
      expect(typeof buildItemFilters).toBe('function');
      expect(typeof buildDimensionFields).toBe('function');
      expect(typeof buildDimensionIndexes).toBe('function');
    });
  });

  describe('Exports (CSV)', () => {
    it('exports CSV/flatten utilities', () => {
      expect(typeof exportToCsv).toBe('function');
      expect(typeof flattenJournalEntries).toBe('function');
    });

    it('exports field maps as objects', () => {
      expect(quickbooksFieldMap).toBeDefined();
      expect(universalFieldMap).toBeDefined();
    });
  });
});

describe('Public API — type exports compile', () => {
  it('core types are usable', () => {
    expectTypeOf<Cents>().toBeNumber();
    expectTypeOf<EntryState>().toMatchTypeOf<'draft' | 'posted' | 'archived'>();
    expectTypeOf<NormalBalance>().toMatchTypeOf<'debit' | 'credit'>();
  });

  it('JournalType interface has required shape', () => {
    expectTypeOf<JournalType>().toHaveProperty('code').toBeString();
    expectTypeOf<JournalType>().toHaveProperty('name').toBeString();
    expectTypeOf<JournalType>().toHaveProperty('description').toBeString();
  });

  it('AccountType interface has required shape', () => {
    expectTypeOf<AccountType>().toHaveProperty('code').toBeString();
    expectTypeOf<AccountType>().toHaveProperty('name').toBeString();
    expectTypeOf<AccountType>().toHaveProperty('category').toBeString();
  });

  it('Currency interface has required shape', () => {
    expectTypeOf<Currency>().toHaveProperty('code').toBeString();
    expectTypeOf<Currency>().toHaveProperty('name').toBeString();
    expectTypeOf<Currency>().toHaveProperty('symbol').toBeString();
    expectTypeOf<Currency>().toHaveProperty('minorUnit').toBeNumber();
  });

  it('AccountingEngineConfig is a valid config type', () => {
    expectTypeOf<AccountingEngineConfig>().toHaveProperty('country');
    expectTypeOf<AccountingEngineConfig>().toHaveProperty('currency');
  });

  it('CountryPack interface has required shape', () => {
    expectTypeOf<CountryPack>().toHaveProperty('code').toBeString();
    expectTypeOf<CountryPack>().toHaveProperty('name').toBeString();
    expectTypeOf<CountryPack>().toHaveProperty('defaultCurrency').toBeString();
  });

  it('report types are objects', () => {
    expectTypeOf<TrialBalanceReport>().toBeObject();
    expectTypeOf<BalanceSheetReport>().toBeObject();
    expectTypeOf<IncomeStatementReport>().toBeObject();
    expectTypeOf<GeneralLedgerReport>().toBeObject();
    expectTypeOf<CashFlowReport>().toBeObject();
  });

  it('repository types are objects', () => {
    expectTypeOf<PostOptions>().toBeObject();
    expectTypeOf<SeedResult>().toBeObject();
  });
});
