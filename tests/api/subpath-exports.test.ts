/**
 * Subpath Exports Verification
 *
 * Verifies that every subpath defined in package.json exports
 * resolves correctly and exposes the expected symbols.
 *
 * If a subpath barrel file (e.g. src/constants/index.ts) forgets
 * to re-export something, this test catches it.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';

// ── @classytic/ledger/constants ───────────────────────────────────────────

import {
  // Categories
  CATEGORIES,
  CATEGORY_KEYS,
  isValidCategory,
  getCategoryMainType,
  getCategoryStatementType,
  isBalanceSheet,
  isIncomeStatement,
  getNormalBalance,
  categoryKey,
  extractMainType,
  extractStatementType,

  // Journals
  JOURNAL_TYPES,
  JOURNAL_CODES,
  getJournalTypeCodes,
  isValidJournalType,
  getJournalType,
  registerJournalType,
  getCustomJournalTypes,

  // Currencies
  CURRENCIES,
  getCurrency,
  isValidCurrency,
  getMinorUnit,
} from '../../src/constants/index.js';

// ── @classytic/ledger/schemas ─────────────────────────────────────────────

import {
  createAccountSchema,
  createJournalEntrySchema,
  createFiscalPeriodSchema,
  createBudgetSchema,
  createReconciliationSchema,
} from '../../src/schemas/index.js';

// ── @classytic/ledger/reports ─────────────────────────────────────────────

import {
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
  generateBudgetVsActual,
  generateRevaluation,
} from '../../src/reports/index.js';

import type {
  TrialBalanceOptions,
  BalanceSheetOptions,
  IncomeStatementOptions,
  GeneralLedgerOptions,
  CashFlowOptions,
  FiscalCloseOptions,
  FiscalCloseResult,
  FiscalReopenResult,
  DimensionBreakdownOptions,
  DimensionBreakdownParams,
  DimensionBreakdownRow,
  DimensionBreakdownReport,
  AgedBucketConfig,
  AgedBalanceOptions,
  AgedBalanceParams,
  AgedBalanceRow,
  AgedBalanceReport,
  BudgetVsActualOptions,
  BudgetVsActualParams,
  BudgetVsActualRow,
  BudgetVsActualReport,
  RevaluationOptions,
  RevaluationParams,
  RevaluationReport,
} from '../../src/reports/index.js';

// ── @classytic/ledger/plugins ─────────────────────────────────────────────

import {
  doubleEntryPlugin,
  fiscalLockPlugin,
  dateLockPlugin,
  idempotencyPlugin,
  taxHookPlugin,
} from '../../src/plugins/index.js';

import type {
  DoubleEntryPluginOptions,
  FiscalLockPluginOptions,
  DateLockPluginOptions,
  IdempotencyPluginOptions,
  TaxHookPluginOptions,
} from '../../src/plugins/index.js';

// ── @classytic/ledger/repositories ────────────────────────────────────────

import {
  wireJournalEntryMethods,
  wireAccountMethods,
  wireReconciliationMethods,
} from '../../src/repositories/index.js';

// ── @classytic/ledger/country ─────────────────────────────────────────────

import { defineCountryPack } from '../../src/country/index.js';
import type {
  CountryPack,
  CountryPackInput,
  TaxCode,
  TaxCodesByRegion,
  TaxReportLine,
  TaxReportTemplate,
} from '../../src/country/index.js';

// ── @classytic/ledger/exports ─────────────────────────────────────────────

import {
  escapeCell,
  serializeCsv,
  buildCsv,
  getHeaders,
  extractRow,
  extractAllRows,
  exportToCsv,
  flattenJournalEntry,
  flattenJournalEntries,
  quickbooksFieldMap,
  universalFieldMap,
} from '../../src/exports/index.js';

import type {
  PopulatedAccount,
  PopulatedJournalItem,
  PopulatedJournalEntry,
  FlatJournalRow,
  ExportField,
  ExportFieldMap,
  CsvOptions,
} from '../../src/exports/index.js';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Subpath: constants', () => {
  it('exports all category symbols (11)', () => {
    const symbols = [
      CATEGORIES, CATEGORY_KEYS, isValidCategory, getCategoryMainType,
      getCategoryStatementType, isBalanceSheet, isIncomeStatement,
      getNormalBalance, categoryKey, extractMainType, extractStatementType,
    ];
    for (const s of symbols) expect(s).toBeDefined();
  });

  it('exports all journal symbols (7)', () => {
    const symbols = [
      JOURNAL_TYPES, JOURNAL_CODES, getJournalTypeCodes,
      isValidJournalType, getJournalType, registerJournalType,
      getCustomJournalTypes,
    ];
    for (const s of symbols) expect(s).toBeDefined();
  });

  it('exports all currency symbols (4)', () => {
    const symbols = [CURRENCIES, getCurrency, isValidCurrency, getMinorUnit];
    for (const s of symbols) expect(s).toBeDefined();
  });
});

describe('Subpath: schemas', () => {
  it('exports all 5 schema factories', () => {
    const factories = [
      createAccountSchema, createJournalEntrySchema,
      createFiscalPeriodSchema, createBudgetSchema,
      createReconciliationSchema,
    ];
    for (const f of factories) {
      expect(f).toBeDefined();
      expect(typeof f).toBe('function');
    }
  });
});

describe('Subpath: reports', () => {
  it('exports all 12 report functions/constants', () => {
    const fns = [
      generateTrialBalance, generateBalanceSheet, generateIncomeStatement,
      generateGeneralLedger, generateCashFlow, closeFiscalPeriod,
      reopenFiscalPeriod, generateDimensionBreakdown, generateAgedBalance,
      generateBudgetVsActual, generateRevaluation, DEFAULT_BUCKETS,
    ];
    for (const f of fns) expect(f).toBeDefined();
  });

  it('report option types compile', () => {
    expectTypeOf<TrialBalanceOptions>().toBeObject();
    expectTypeOf<BalanceSheetOptions>().toBeObject();
    expectTypeOf<IncomeStatementOptions>().toBeObject();
    expectTypeOf<GeneralLedgerOptions>().toBeObject();
    expectTypeOf<CashFlowOptions>().toBeObject();
    expectTypeOf<FiscalCloseOptions>().toBeObject();
    expectTypeOf<DimensionBreakdownReport>().toBeObject();
    expectTypeOf<AgedBalanceReport>().toBeObject();
    expectTypeOf<BudgetVsActualReport>().toBeObject();
    expectTypeOf<RevaluationReport>().toBeObject();
  });
});

describe('Subpath: plugins', () => {
  it('exports all 5 plugins', () => {
    const plugins = [
      doubleEntryPlugin, fiscalLockPlugin, dateLockPlugin,
      idempotencyPlugin, taxHookPlugin,
    ];
    for (const p of plugins) {
      expect(p).toBeDefined();
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('apply');
    }
  });

  it('plugin option types compile', () => {
    expectTypeOf<DoubleEntryPluginOptions>().toBeObject();
    expectTypeOf<FiscalLockPluginOptions>().toBeObject();
    expectTypeOf<DateLockPluginOptions>().toBeObject();
    expectTypeOf<IdempotencyPluginOptions>().toBeObject();
    expectTypeOf<TaxHookPluginOptions>().toBeObject();
  });
});

describe('Subpath: repositories', () => {
  it('exports all 3 wire functions', () => {
    for (const fn of [wireJournalEntryMethods, wireAccountMethods, wireReconciliationMethods]) {
      expect(typeof fn).toBe('function');
    }
  });
});

describe('Subpath: country', () => {
  it('exports defineCountryPack factory', () => {
    expect(typeof defineCountryPack).toBe('function');
  });

  it('country types compile', () => {
    expectTypeOf<CountryPack>().toHaveProperty('code').toBeString();
    expectTypeOf<CountryPackInput>().toBeObject();
    expectTypeOf<TaxCode>().toBeObject();
  });
});

describe('Subpath: exports', () => {
  it('exports all CSV/flatten functions (11)', () => {
    const fns = [
      escapeCell, serializeCsv, buildCsv, getHeaders,
      extractRow, extractAllRows, exportToCsv,
      flattenJournalEntry, flattenJournalEntries,
    ];
    for (const fn of fns) expect(typeof fn).toBe('function');
  });

  it('exports field map objects', () => {
    expect(quickbooksFieldMap).toBeDefined();
    expect(universalFieldMap).toBeDefined();
  });

  it('export types compile', () => {
    expectTypeOf<PopulatedJournalEntry>().toBeObject();
    expectTypeOf<FlatJournalRow>().toBeObject();
    expectTypeOf<ExportFieldMap>().toBeObject();
  });
});
