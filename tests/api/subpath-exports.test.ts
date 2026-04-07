/**
 * Subpath Exports Verification
 *
 * Verifies that every subpath defined in package.json exports
 * resolves correctly and exposes the expected symbols.
 *
 * If a subpath barrel file (e.g. src/constants/index.ts) forgets
 * to re-export something, this test catches it.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

// ── @classytic/ledger/constants ───────────────────────────────────────────

import {
  // Categories
  CATEGORIES,
  CATEGORY_KEYS,
  // Currencies
  CURRENCIES,
  categoryKey,
  extractMainType,
  extractStatementType,
  getCategoryMainType,
  getCategoryStatementType,
  getCurrency,
  getCustomJournalTypes,
  getJournalType,
  getJournalTypeCodes,
  getMinorUnit,
  getNormalBalance,
  isBalanceSheet,
  isIncomeStatement,
  isValidCategory,
  isValidCurrency,
  isValidJournalType,
  JOURNAL_CODES,
  // Journals
  JOURNAL_TYPES,
  registerJournalType,
} from '../../src/constants/index.js';

// ── @classytic/ledger/reports ─────────────────────────────────────────────

import type {
  AgedBalanceReport,
  BalanceSheetOptions,
  BudgetVsActualReport,
  CashFlowOptions,
  DimensionBreakdownReport,
  FiscalCloseOptions,
  GeneralLedgerOptions,
  IncomeStatementOptions,
  RevaluationReport,
  TrialBalanceOptions,
} from '../../src/reports/index.js';
import {
  closeFiscalPeriod,
  DEFAULT_BUCKETS,
  generateAgedBalance,
  generateBalanceSheet,
  generateBudgetVsActual,
  generateCashFlow,
  generateDimensionBreakdown,
  generateGeneralLedger,
  generateIncomeStatement,
  generateRevaluation,
  generateTrialBalance,
  reopenFiscalPeriod,
} from '../../src/reports/index.js';

// ── @classytic/ledger/plugins ─────────────────────────────────────────────

import type {
  CreateLockPluginOptions,
  DailyLockPluginOptions,
  DoubleEntryPluginOptions,
  FiscalLockPluginOptions,
  IdempotencyPluginOptions,
  LockHit,
  LockResolver,
  TaxHookPluginOptions,
  TaxLockPluginOptions,
} from '../../src/plugins/index.js';
import {
  createLockPlugin,
  dailyLockPlugin,
  doubleEntryPlugin,
  fiscalLockPlugin,
  idempotencyPlugin,
  periodResolver,
  taxHookPlugin,
  taxLockPlugin,
  watermarkResolver,
} from '../../src/plugins/index.js';

// ── @classytic/ledger/country ─────────────────────────────────────────────

import type { CountryPack, CountryPackInput, TaxCode } from '../../src/country/index.js';
import { defineCountryPack } from '../../src/country/index.js';

// ── @classytic/ledger/exports ─────────────────────────────────────────────

import type {
  ExportFieldMap,
  FlatJournalRow,
  PopulatedJournalEntry,
} from '../../src/exports/index.js';
import {
  buildCsv,
  escapeCell,
  exportToCsv,
  extractAllRows,
  extractRow,
  flattenJournalEntries,
  flattenJournalEntry,
  getHeaders,
  quickbooksFieldMap,
  serializeCsv,
  universalFieldMap,
} from '../../src/exports/index.js';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Subpath: constants', () => {
  it('exports all category symbols (11)', () => {
    const symbols = [
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
    ];
    for (const s of symbols) expect(s).toBeDefined();
  });

  it('exports all journal symbols (7)', () => {
    const symbols = [
      JOURNAL_TYPES,
      JOURNAL_CODES,
      getJournalTypeCodes,
      isValidJournalType,
      getJournalType,
      registerJournalType,
      getCustomJournalTypes,
    ];
    for (const s of symbols) expect(s).toBeDefined();
  });

  it('exports all currency symbols (4)', () => {
    const symbols = [CURRENCIES, getCurrency, isValidCurrency, getMinorUnit];
    for (const s of symbols) expect(s).toBeDefined();
  });
});

describe('Subpath: reports', () => {
  it('exports all 12 report functions/constants', () => {
    const fns = [
      generateTrialBalance,
      generateBalanceSheet,
      generateIncomeStatement,
      generateGeneralLedger,
      generateCashFlow,
      closeFiscalPeriod,
      reopenFiscalPeriod,
      generateDimensionBreakdown,
      generateAgedBalance,
      generateBudgetVsActual,
      generateRevaluation,
      DEFAULT_BUCKETS,
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
  it('exports the plugin factory surface (double-entry, idempotency, tax-hook, lock primitive + presets)', () => {
    const factories = [
      doubleEntryPlugin,
      idempotencyPlugin,
      taxHookPlugin,
      createLockPlugin,
      fiscalLockPlugin,
      taxLockPlugin,
      dailyLockPlugin,
      periodResolver,
      watermarkResolver,
    ];
    for (const f of factories) {
      expect(f).toBeDefined();
      expect(typeof f).toBe('function');
    }
  });

  it('plugin option types compile', () => {
    expectTypeOf<DoubleEntryPluginOptions>().toBeObject();
    expectTypeOf<IdempotencyPluginOptions>().toBeObject();
    expectTypeOf<TaxHookPluginOptions>().toBeObject();
    expectTypeOf<CreateLockPluginOptions>().toBeObject();
    expectTypeOf<FiscalLockPluginOptions>().toBeObject();
    expectTypeOf<TaxLockPluginOptions>().toBeObject();
    expectTypeOf<DailyLockPluginOptions>().toBeObject();
    expectTypeOf<LockHit>().toBeObject();
    expectTypeOf<LockResolver>().toBeFunction();
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
      escapeCell,
      serializeCsv,
      buildCsv,
      getHeaders,
      extractRow,
      extractAllRows,
      exportToCsv,
      flattenJournalEntry,
      flattenJournalEntries,
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
