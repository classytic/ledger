/**
 * E2E Test: Textbook Accounting Problems
 *
 * Real-world problems from O-Level, A-Level, and introductory university
 * accounting courses. Each describe block is a self-contained textbook
 * problem with a KNOWN correct answer.
 *
 * Proves that @classytic/ledger can power educational apps: accounting
 * tutoring platforms, exam prep tools, and university lab software.
 *
 * All monetary values are in integer cents (e.g., $10,000 = 1_000_000).
 *
 * Run with: npx vitest run tests/e2e/textbook-accounting-problems.test.ts
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { legacyBalanceSheet, legacyIncomeStatement, legacyTrialBalance } from '../helpers/legacy-report-view.js';

// =============================================================================
// Generic Textbook Country Pack (no country-specific rules)
// =============================================================================

const TEXTBOOK_ACCOUNT_TYPES: readonly AccountType[] = [
  // Groups
  {
    code: 'Current Assets',
    name: 'Current Assets',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: 'Non-Current Assets',
    name: 'Non-Current Assets',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: 'Current Liabilities',
    name: 'Current Liabilities',
    category: 'Balance Sheet-Liability',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: 'Equity',
    name: 'Equity',
    category: 'Balance Sheet-Equity',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: 'Revenue',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: 'Cost of Goods Sold',
    name: 'Cost of Goods Sold',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: 'Operating Expenses',
    name: 'Operating Expenses',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: null,
    isGroup: true,
    isTotal: false,
    cashFlowCategory: null,
  },

  // Posting accounts
  {
    code: '1000',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Current Assets',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1100',
    name: 'Accounts Receivable',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Current Assets',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1200',
    name: 'Inventory',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Current Assets',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1300',
    name: 'Prepaid Insurance',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Current Assets',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1400',
    name: 'Supplies',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Current Assets',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1500',
    name: 'Equipment',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Non-Current Assets',
    isTotal: false,
    cashFlowCategory: 'Investing',
  },
  {
    code: '1510',
    name: 'Accumulated Depreciation',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Non-Current Assets',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '1600',
    name: 'Land',
    category: 'Balance Sheet-Asset',
    description: '',
    parentCode: 'Non-Current Assets',
    isTotal: false,
    cashFlowCategory: 'Investing',
  },
  {
    code: '2000',
    name: 'Accounts Payable',
    category: 'Balance Sheet-Liability',
    description: '',
    parentCode: 'Current Liabilities',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2100',
    name: 'Wages Payable',
    category: 'Balance Sheet-Liability',
    description: '',
    parentCode: 'Current Liabilities',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2200',
    name: 'Unearned Revenue',
    category: 'Balance Sheet-Liability',
    description: '',
    parentCode: 'Current Liabilities',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2300',
    name: 'Notes Payable',
    category: 'Balance Sheet-Liability',
    description: '',
    parentCode: 'Current Liabilities',
    isTotal: false,
    cashFlowCategory: 'Financing',
  },
  {
    code: '3000',
    name: 'Owner Capital',
    category: 'Balance Sheet-Equity',
    description: '',
    parentCode: 'Equity',
    isTotal: false,
    cashFlowCategory: 'Financing',
  },
  {
    code: '3100',
    name: 'Owner Drawings',
    category: 'Balance Sheet-Equity',
    description: '',
    parentCode: 'Equity',
    isTotal: false,
    cashFlowCategory: 'Financing',
  },
  {
    code: '3200',
    name: 'Retained Earnings',
    category: 'Balance Sheet-Equity',
    description: '',
    parentCode: 'Equity',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '4000',
    name: 'Sales Revenue',
    category: 'Income Statement-Income',
    description: '',
    parentCode: 'Revenue',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '4100',
    name: 'Service Revenue',
    category: 'Income Statement-Income',
    description: '',
    parentCode: 'Revenue',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Cost of Goods Sold',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6000',
    name: 'Wages Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6100',
    name: 'Rent Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6200',
    name: 'Utilities Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6300',
    name: 'Insurance Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6400',
    name: 'Supplies Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6500',
    name: 'Depreciation Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6600',
    name: 'Interest Expense',
    category: 'Income Statement-Expense',
    description: '',
    parentCode: 'Operating Expenses',
    isTotal: false,
    cashFlowCategory: null,
  },
];

const textbookPack = defineCountryPack({
  code: 'TB',
  name: 'Textbook',
  defaultCurrency: 'USD',
  retainedEarningsAccountCode: '3200',
  cogsGroupCode: 'Cost of Goods Sold',
  accountTypes: TEXTBOOK_ACCOUNT_TYPES,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

const baseConfig: Omit<AccountingEngineConfig, 'mongoose' | 'modelNames'> = {
  country: textbookPack,
  currency: 'USD',
  retainedEarningsAccountCode: '3200',
};

// =============================================================================
// Test Infrastructure
// =============================================================================

let mongod: MongoMemoryServer;

/** Unique model name counter to avoid mongoose collision across describe blocks */
let modelCounter = 0;

/** Create fresh models and reports for each problem (full isolation) */
function createFreshModels() {
  modelCounter++;
  const suffix = `TB${modelCounter}`;
  const names = {
    account: `TxtBk_Acct_${suffix}`,
    journalEntry: `TxtBk_JE_${suffix}`,
    fiscalPeriod: `TxtBk_FP_${suffix}`,
    budget: `TxtBk_B_${suffix}`,
    reconciliation: `TxtBk_R_${suffix}`,
  };
  for (const n of Object.values(names)) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  const engine = createAccountingEngine({
    ...baseConfig,
    mongoose: mongoose.connection,
    modelNames: names,
  });

  const AccountModel = engine.models.Account as mongoose.Model<any>;
  const JEModel = engine.models.JournalEntry as mongoose.Model<any>;
  const reports = engine.reports;

  const acctIds: Record<string, mongoose.Types.ObjectId> = {};

  /** Seed all posting accounts and populate the ID lookup */
  async function seedAccounts() {
    const postingTypes = textbookPack.getPostingAccountTypes();
    for (const at of postingTypes) {
      const doc = await AccountModel.create({ accountTypeCode: at.code });
      acctIds[at.code] = doc._id;
    }
  }

  /** Post a journal entry (amounts in integer cents) */
  async function postEntry(
    date: string,
    items: Array<{ account: string; debit: number; credit: number }>,
  ) {
    const journalItems = items.map((item) => ({
      account: acctIds[item.account],
      debit: item.debit,
      credit: item.credit,
    }));
    return JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date(date),
      journalItems,
      totalDebit: journalItems.reduce((s, i) => s + i.debit, 0),
      totalCredit: journalItems.reduce((s, i) => s + i.credit, 0),
    });
  }

  return { AccountModel, JEModel, reports, acctIds, seedAccounts, postEntry };
}

// =============================================================================
// Global Setup / Teardown
// =============================================================================

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// =============================================================================
// Problem 1: O-Level — The Accounting Equation
// =============================================================================

describe('O-Level: The Accounting Equation', () => {
  /**
   * "On January 1, Sam starts a business with $10,000 cash."
   * Seven journal entries through January. Expected final balances:
   *   Cash = $8,300 | AR = $1,000 | Supplies = $500
   *   Total Assets = $9,800 | Total Revenue = $3,000 | Total Expenses = $2,700
   *   Net Income = $300 | Owner Equity = $9,800
   *   Assets = Liabilities + Equity
   */

  let ctx: ReturnType<typeof createFreshModels>;

  beforeAll(async () => {
    ctx = createFreshModels();
    await ctx.seedAccounts();

    // Jan 1: Owner invests $10,000 cash
    await ctx.postEntry('2024-01-01', [
      { account: '1000', debit: 1_000_000, credit: 0 },
      { account: '3000', debit: 0, credit: 1_000_000 },
    ]);

    // Jan 5: Buys supplies for $500 cash
    await ctx.postEntry('2024-01-05', [
      { account: '1400', debit: 50_000, credit: 0 },
      { account: '1000', debit: 0, credit: 50_000 },
    ]);

    // Jan 10: Provides service on credit $3,000
    await ctx.postEntry('2024-01-10', [
      { account: '1100', debit: 300_000, credit: 0 },
      { account: '4100', debit: 0, credit: 300_000 },
    ]);

    // Jan 15: Pays rent $1,200
    await ctx.postEntry('2024-01-15', [
      { account: '6100', debit: 120_000, credit: 0 },
      { account: '1000', debit: 0, credit: 120_000 },
    ]);

    // Jan 20: Receives $2,000 from customer
    await ctx.postEntry('2024-01-20', [
      { account: '1000', debit: 200_000, credit: 0 },
      { account: '1100', debit: 0, credit: 200_000 },
    ]);

    // Jan 25: Pays wages $1,500
    await ctx.postEntry('2024-01-25', [
      { account: '6000', debit: 150_000, credit: 0 },
      { account: '1000', debit: 0, credit: 150_000 },
    ]);

    // Jan 31: Owner withdraws $500
    await ctx.postEntry('2024-01-31', [
      { account: '3100', debit: 50_000, credit: 0 },
      { account: '1000', debit: 0, credit: 50_000 },
    ]);
  });

  it('trial balance totals match (debits = credits)', async () => {
    const tb = await ctx.reports.trialBalance({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    const totalDebit = legacyTrialBalance(tb).rows.reduce((s, r) => s + r.ending.debit, 0);
    const totalCredit = legacyTrialBalance(tb).rows.reduce((s, r) => s + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeGreaterThan(0);
  });

  it('income statement shows net income of $300', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    // Revenue: $3,000
    expect(legacyIncomeStatement(is).revenue.total).toBe(300_000);
    // Operating expenses: Rent $1,200 + Wages $1,500 = $2,700
    expect(legacyIncomeStatement(is).expenses.total).toBe(270_000);
    // Net income: $3,000 - $2,700 = $300
    expect(legacyIncomeStatement(is).netIncome).toBe(30_000);
  });

  it('balance sheet is balanced (Assets = Liabilities + Equity)', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs).summary.difference).toBe(0);

    // Total Assets: Cash $8,300 + AR $1,000 + Supplies $500 = $9,800
    expect(legacyBalanceSheet(bs).summary.totalAssets).toBe(980_000);

    // Liabilities = $0
    expect(legacyBalanceSheet(bs).summary.totalLiabilities).toBe(0);

    // Equity = $9,800 (Capital $10,000 - Drawings $500 + Net Income $300)
    expect(legacyBalanceSheet(bs).summary.totalEquity).toBe(980_000);
  });

  it('cash account shows correct balance via general ledger', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-01',
      accountId: String(ctx.acctIds['1000']),
    });

    // Cash: 10,000 - 500 - 1,200 + 2,000 - 1,500 - 500 = $8,300
    expect(gl.accounts.length).toBe(1);
    expect(gl.accounts[0].closingBalance).toBe(830_000);
  });

  it('accounts receivable shows correct balance', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-01',
      accountId: String(ctx.acctIds['1100']),
    });

    // AR: $3,000 - $2,000 = $1,000
    expect(gl.accounts.length).toBe(1);
    expect(gl.accounts[0].closingBalance).toBe(100_000);
  });

  it('verifies the accounting equation: A = L + E', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    const totalAssets = legacyBalanceSheet(bs).summary.totalAssets;
    const totalLiabilitiesAndEquity = legacyBalanceSheet(bs).summary.totalLiabilities + legacyBalanceSheet(bs).summary.totalEquity;
    expect(totalAssets).toBe(totalLiabilitiesAndEquity);
    expect(totalAssets).toBe(980_000); // $9,800
  });
});

// =============================================================================
// Problem 2: A-Level — Adjusting Entries
// =============================================================================

describe('A-Level: Adjusting Entries', () => {
  /**
   * "At December 31, the following adjustments are needed for ABC Company."
   *
   * Tests the five classic adjusting entry types:
   *   a. Prepaid expense expiration (insurance)
   *   b. Unearned revenue earned
   *   c. Depreciation
   *   d. Accrued expense (wages payable)
   *   e. Supplies consumed
   */

  let ctx: ReturnType<typeof createFreshModels>;

  beforeAll(async () => {
    ctx = createFreshModels();
    await ctx.seedAccounts();

    // Dec 1: Opening — Cash $50,000, Capital $50,000
    await ctx.postEntry('2024-12-01', [
      { account: '1000', debit: 5_000_000, credit: 0 },
      { account: '3000', debit: 0, credit: 5_000_000 },
    ]);

    // Dec 1: Prepaid insurance $2,400 for 12 months
    await ctx.postEntry('2024-12-01', [
      { account: '1300', debit: 240_000, credit: 0 },
      { account: '1000', debit: 0, credit: 240_000 },
    ]);

    // Dec 1: Received $6,000 advance for 3 months of service
    await ctx.postEntry('2024-12-01', [
      { account: '1000', debit: 600_000, credit: 0 },
      { account: '2200', debit: 0, credit: 600_000 },
    ]);

    // Dec 1: Bought equipment $12,000
    await ctx.postEntry('2024-12-01', [
      { account: '1500', debit: 1_200_000, credit: 0 },
      { account: '1000', debit: 0, credit: 1_200_000 },
    ]);

    // Dec 1: Bought supplies $800
    await ctx.postEntry('2024-12-01', [
      { account: '1400', debit: 80_000, credit: 0 },
      { account: '1000', debit: 0, credit: 80_000 },
    ]);

    // Dec 15: Revenue earned $8,000
    await ctx.postEntry('2024-12-15', [
      { account: '1100', debit: 800_000, credit: 0 },
      { account: '4100', debit: 0, credit: 800_000 },
    ]);

    // Dec 20: Paid wages $3,000
    await ctx.postEntry('2024-12-20', [
      { account: '6000', debit: 300_000, credit: 0 },
      { account: '1000', debit: 0, credit: 300_000 },
    ]);

    // === Adjusting entries on Dec 31 ===

    // (a) Insurance expired: 1/12 of $2,400 = $200
    await ctx.postEntry('2024-12-31', [
      { account: '6300', debit: 20_000, credit: 0 },
      { account: '1300', debit: 0, credit: 20_000 },
    ]);

    // (b) Unearned revenue earned: 1/3 of $6,000 = $2,000
    await ctx.postEntry('2024-12-31', [
      { account: '2200', debit: 200_000, credit: 0 },
      { account: '4100', debit: 0, credit: 200_000 },
    ]);

    // (c) Depreciation: $12,000 / 5 years / 12 months = $200/month
    await ctx.postEntry('2024-12-31', [
      { account: '6500', debit: 20_000, credit: 0 },
      { account: '1510', debit: 0, credit: 20_000 },
    ]);

    // (d) Accrued wages: $500 owed but not yet paid
    await ctx.postEntry('2024-12-31', [
      { account: '6000', debit: 50_000, credit: 0 },
      { account: '2100', debit: 0, credit: 50_000 },
    ]);

    // (e) Supplies used: Had $800, $300 remain, so $500 used
    await ctx.postEntry('2024-12-31', [
      { account: '6400', debit: 50_000, credit: 0 },
      { account: '1400', debit: 0, credit: 50_000 },
    ]);
  });

  it('prepaid insurance balance after adjustment is $2,200', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-12',
      accountId: String(ctx.acctIds['1300']),
    });

    // $2,400 - $200 = $2,200
    expect(gl.accounts[0].closingBalance).toBe(220_000);
  });

  it('unearned revenue balance after adjustment is $4,000', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-12',
      accountId: String(ctx.acctIds['2200']),
    });

    // $6,000 - $2,000 = $4,000 (liability — credit balance, shown negative for liabilities in GL)
    // Liability: credit-positive. GL closing balance = credits - debits = 600000 - 200000 = 400000
    // But computeEndingBalance for liabilities: credit - debit (shown as positive).
    // The GL reports closing balance using category-aware computation.
    expect(Math.abs(gl.accounts[0].closingBalance)).toBe(400_000);
  });

  it('accumulated depreciation is $200 (contra-asset)', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-12',
      accountId: String(ctx.acctIds['1510']),
    });

    // Accumulated Depreciation is an asset account with credit balance.
    // As an asset: debit - credit = 0 - 20000 = -20000
    expect(gl.accounts[0].closingBalance).toBe(-20_000);
  });

  it('equipment net book value is $11,800', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2024-12',
    });

    // Find Non-Current Assets group
    const ncaGroup = legacyBalanceSheet(bs).assets.groups.find((g) => g.name === 'Non-Current Assets');
    expect(ncaGroup).toBeDefined();

    // Equipment $12,000 + Accum Depr -$200 = $11,800
    expect(ncaGroup?.total).toBe(1_180_000);
  });

  it('wages payable after accrual is $500', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-12',
      accountId: String(ctx.acctIds['2100']),
    });

    expect(Math.abs(gl.accounts[0].closingBalance)).toBe(50_000);
  });

  it('service revenue total is $10,000 ($8,000 + $2,000 earned)', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-12',
    });

    // Service Revenue: $8,000 (Dec 15) + $2,000 (adjusting) = $10,000
    expect(legacyIncomeStatement(is).revenue.total).toBe(1_000_000);
  });

  it('total expenses = $4,400', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-12',
    });

    // Wages $3,000 + $500 accrued = $3,500
    // Insurance $200
    // Depreciation $200
    // Supplies $500
    // Total = $4,400
    expect(legacyIncomeStatement(is).expenses.total).toBe(440_000);
  });

  it('net income is $5,600', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-12',
    });

    // $10,000 revenue - $4,400 expenses = $5,600
    expect(legacyIncomeStatement(is).netIncome).toBe(560_000);
  });

  it('balance sheet balances after all adjustments', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2024-12',
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs).summary.difference).toBe(0);
  });

  it('supplies balance after adjustment is $300', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-12',
      accountId: String(ctx.acctIds['1400']),
    });

    // $800 - $500 used = $300
    expect(gl.accounts[0].closingBalance).toBe(30_000);
  });
});

// =============================================================================
// Problem 3: University — Merchandising Business (Perpetual Inventory)
// =============================================================================

describe('University: Merchandising Business — Perpetual Inventory', () => {
  /**
   * "QuickMart sells electronics. Use perpetual inventory method."
   *
   * Tests COGS separation from operating expenses, gross profit
   * calculation, and inventory tracking.
   */

  let ctx: ReturnType<typeof createFreshModels>;

  beforeAll(async () => {
    ctx = createFreshModels();
    await ctx.seedAccounts();

    // Jan 1: Owner invests $100,000
    await ctx.postEntry('2024-01-01', [
      { account: '1000', debit: 10_000_000, credit: 0 },
      { account: '3000', debit: 0, credit: 10_000_000 },
    ]);

    // Jan 3: Purchases inventory $30,000 on credit
    await ctx.postEntry('2024-01-03', [
      { account: '1200', debit: 3_000_000, credit: 0 },
      { account: '2000', debit: 0, credit: 3_000_000 },
    ]);

    // Jan 8: Sells goods for $20,000 cash (cost $12,000)
    await ctx.postEntry('2024-01-08', [
      { account: '1000', debit: 2_000_000, credit: 0 },
      { account: '4000', debit: 0, credit: 2_000_000 },
    ]);
    await ctx.postEntry('2024-01-08', [
      { account: '5000', debit: 1_200_000, credit: 0 },
      { account: '1200', debit: 0, credit: 1_200_000 },
    ]);

    // Jan 12: Sells goods for $15,000 on credit (cost $9,000)
    await ctx.postEntry('2024-01-12', [
      { account: '1100', debit: 1_500_000, credit: 0 },
      { account: '4000', debit: 0, credit: 1_500_000 },
    ]);
    await ctx.postEntry('2024-01-12', [
      { account: '5000', debit: 900_000, credit: 0 },
      { account: '1200', debit: 0, credit: 900_000 },
    ]);

    // Jan 18: Pays supplier $20,000
    await ctx.postEntry('2024-01-18', [
      { account: '2000', debit: 2_000_000, credit: 0 },
      { account: '1000', debit: 0, credit: 2_000_000 },
    ]);

    // Jan 22: Collects $10,000 from customer
    await ctx.postEntry('2024-01-22', [
      { account: '1000', debit: 1_000_000, credit: 0 },
      { account: '1100', debit: 0, credit: 1_000_000 },
    ]);

    // Jan 25: Pays rent $3,000 and utilities $500
    await ctx.postEntry('2024-01-25', [
      { account: '6100', debit: 300_000, credit: 0 },
      { account: '6200', debit: 50_000, credit: 0 },
      { account: '1000', debit: 0, credit: 350_000 },
    ]);

    // Jan 28: Purchases more inventory $15,000 cash
    await ctx.postEntry('2024-01-28', [
      { account: '1200', debit: 1_500_000, credit: 0 },
      { account: '1000', debit: 0, credit: 1_500_000 },
    ]);

    // Jan 31: Pays wages $4,000
    await ctx.postEntry('2024-01-31', [
      { account: '6000', debit: 400_000, credit: 0 },
      { account: '1000', debit: 0, credit: 400_000 },
    ]);
  });

  it('sales revenue is $35,000', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    expect(legacyIncomeStatement(is).revenue.total).toBe(3_500_000);
  });

  it('cost of goods sold is $21,000', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    expect(legacyIncomeStatement(is).costOfSales).toBe(2_100_000);
  });

  it('gross profit is $14,000 (revenue - COGS)', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    expect(legacyIncomeStatement(is).grossProfit).toBe(1_400_000);
  });

  it('operating expenses total $7,500', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    // Rent $3,000 + Utilities $500 + Wages $4,000 = $7,500
    const opEx = legacyIncomeStatement(is).expenses.groups
      .filter((g) => g.name !== 'Cost of Goods Sold')
      .reduce((s, g) => s + g.total, 0);
    expect(opEx).toBe(750_000);
  });

  it('net income is $6,500', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    // $35,000 - $21,000 - $7,500 = $6,500
    expect(legacyIncomeStatement(is).netIncome).toBe(650_000);
  });

  it('inventory balance is $24,000', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-01',
      accountId: String(ctx.acctIds['1200']),
    });

    // $30,000 - $12,000 - $9,000 + $15,000 = $24,000
    expect(gl.accounts[0].closingBalance).toBe(2_400_000);
  });

  it('cash balance is $87,500', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-01',
      accountId: String(ctx.acctIds['1000']),
    });

    // $100,000 + $20,000 + $10,000 - $20,000 - $3,500 - $15,000 - $4,000 = $87,500
    expect(gl.accounts[0].closingBalance).toBe(8_750_000);
  });

  it('accounts receivable is $5,000', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-01',
      accountId: String(ctx.acctIds['1100']),
    });

    // $15,000 - $10,000 = $5,000
    expect(gl.accounts[0].closingBalance).toBe(500_000);
  });

  it('accounts payable is $10,000', async () => {
    const gl = await ctx.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2024-01',
      accountId: String(ctx.acctIds['2000']),
    });

    // $30,000 - $20,000 = $10,000 (liability — credit balance)
    expect(Math.abs(gl.accounts[0].closingBalance)).toBe(1_000_000);
  });

  it('balance sheet balances (Assets = Liabilities + Equity)', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs).summary.difference).toBe(0);

    // Total Assets: Cash $87,500 + AR $5,000 + Inventory $24,000 = $116,500
    expect(legacyBalanceSheet(bs).summary.totalAssets).toBe(11_650_000);

    // Liabilities: AP $10,000
    expect(legacyBalanceSheet(bs).summary.totalLiabilities).toBe(1_000_000);

    // Equity: Capital $100,000 + Net Income $6,500 = $106,500
    expect(legacyBalanceSheet(bs).summary.totalEquity).toBe(10_650_000);
  });

  it('COGS is separated from operating expenses on income statement', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2024-01',
    });

    // COGS should appear as a separate group from Operating Expenses
    const cogsGroup = legacyIncomeStatement(is).expenses.groups.find((g) => g.name === 'Cost of Goods Sold');
    const opExGroup = legacyIncomeStatement(is).expenses.groups.find((g) => g.name === 'Operating Expenses');

    expect(cogsGroup).toBeDefined();
    expect(opExGroup).toBeDefined();
    expect(cogsGroup?.total).toBe(2_100_000);
    expect(opExGroup?.total).toBe(750_000);
  });
});

// =============================================================================
// Problem 4: Multi-Period — Year-End Close and Carryforward
// =============================================================================

describe('Multi-Period: Year-End Close and Carryforward', () => {
  /**
   * "A business operates for 2 years. Verify retained earnings carry forward."
   *
   * Year 1 (2024): Revenue $80,000, Expenses $60,000 => Net Income $20,000
   * Year 2 (2025): Revenue $100,000, Expenses $70,000 => Net Income $30,000
   *
   * Total RE across both years = $50,000
   */

  let ctx: ReturnType<typeof createFreshModels>;

  beforeAll(async () => {
    ctx = createFreshModels();
    await ctx.seedAccounts();

    // Owner invests $50,000
    await ctx.postEntry('2024-01-01', [
      { account: '1000', debit: 5_000_000, credit: 0 },
      { account: '3000', debit: 0, credit: 5_000_000 },
    ]);

    // === Year 1 (2024) ===

    // Revenue $80,000 (spread across year)
    await ctx.postEntry('2024-03-15', [
      { account: '1000', debit: 4_000_000, credit: 0 },
      { account: '4100', debit: 0, credit: 4_000_000 },
    ]);
    await ctx.postEntry('2024-09-15', [
      { account: '1000', debit: 4_000_000, credit: 0 },
      { account: '4100', debit: 0, credit: 4_000_000 },
    ]);

    // Expenses $60,000 (spread across year)
    await ctx.postEntry('2024-06-30', [
      { account: '6100', debit: 3_000_000, credit: 0 },
      { account: '1000', debit: 0, credit: 3_000_000 },
    ]);
    await ctx.postEntry('2024-12-31', [
      { account: '6000', debit: 3_000_000, credit: 0 },
      { account: '1000', debit: 0, credit: 3_000_000 },
    ]);

    // === Year 2 (2025) ===

    // Revenue $100,000
    await ctx.postEntry('2025-04-15', [
      { account: '1000', debit: 5_000_000, credit: 0 },
      { account: '4100', debit: 0, credit: 5_000_000 },
    ]);
    await ctx.postEntry('2025-10-15', [
      { account: '1000', debit: 5_000_000, credit: 0 },
      { account: '4100', debit: 0, credit: 5_000_000 },
    ]);

    // Expenses $70,000
    await ctx.postEntry('2025-06-30', [
      { account: '6100', debit: 3_500_000, credit: 0 },
      { account: '1000', debit: 0, credit: 3_500_000 },
    ]);
    await ctx.postEntry('2025-12-31', [
      { account: '6000', debit: 3_500_000, credit: 0 },
      { account: '1000', debit: 0, credit: 3_500_000 },
    ]);
  });

  it('Year 1 income statement shows net income of $20,000', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2024,
    });

    expect(legacyIncomeStatement(is).revenue.total).toBe(8_000_000); // $80,000
    expect(legacyIncomeStatement(is).expenses.total).toBe(6_000_000); // $60,000
    expect(legacyIncomeStatement(is).netIncome).toBe(2_000_000); // $20,000
  });

  it('Year 1 balance sheet is balanced', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'year',
      dateValue: 2024,
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs).summary.difference).toBe(0);

    // Total Equity = Capital $50,000 + Net Income $20,000 = $70,000
    expect(legacyBalanceSheet(bs).summary.totalEquity).toBe(7_000_000);
  });

  it('Year 2 income statement shows net income of $30,000', async () => {
    const is = await ctx.reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2025,
    });

    expect(legacyIncomeStatement(is).revenue.total).toBe(10_000_000); // $100,000
    expect(legacyIncomeStatement(is).expenses.total).toBe(7_000_000); // $70,000
    expect(legacyIncomeStatement(is).netIncome).toBe(3_000_000); // $30,000
  });

  it('Year 2 balance sheet carries forward retained earnings from Year 1', async () => {
    const bs = await ctx.reports.balanceSheet({
      dateOption: 'year',
      dateValue: 2025,
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs).summary.difference).toBe(0);

    // Find the Retained Earnings group in equity
    const reGroup = legacyBalanceSheet(bs).equity.groups.find((g) => g.name === 'Retained Earnings');
    expect(reGroup).toBeDefined();

    // Previous Years Retained Earnings = $20,000 (Year 1 net income, carried forward)
    const priorRE = reGroup?.accounts.find((a) => a.name.includes('Previous'));
    expect(priorRE).toBeDefined();
    expect(priorRE?.balance).toBe(2_000_000); // $20,000 from Year 1

    // Current Year Net Income = $30,000
    const currentYearNI = reGroup?.accounts.find((a) => a.name.includes('Current Year'));
    expect(currentYearNI).toBeDefined();
    expect(currentYearNI?.balance).toBe(3_000_000); // $30,000 from Year 2

    // Total Equity = Capital $50,000 + RE $20,000 + NI $30,000 = $100,000
    expect(legacyBalanceSheet(bs).summary.totalEquity).toBe(10_000_000);
  });

  it('balance sheet stays balanced across both years', async () => {
    const bs2024 = await ctx.reports.balanceSheet({
      dateOption: 'year',
      dateValue: 2024,
    });
    const bs2025 = await ctx.reports.balanceSheet({
      dateOption: 'year',
      dateValue: 2025,
    });

    expect(legacyBalanceSheet(bs2024).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs2025).summary.isBalanced).toBe(true);

    // Year 2 total assets should be higher due to accumulated profits
    // Year 1: Cash = $50,000 + $80,000 - $60,000 = $70,000
    expect(legacyBalanceSheet(bs2024).summary.totalAssets).toBe(7_000_000);

    // Year 2: Cash = $70,000 + $100,000 - $70,000 = $100,000
    expect(legacyBalanceSheet(bs2025).summary.totalAssets).toBe(10_000_000);
  });
});

// =============================================================================
// Problem 5: Accounting Concepts Validation
// =============================================================================

describe('Accounting Concepts Validation', () => {
  /**
   * Quick checks proving fundamental accounting concepts work:
   * 1. Double-Entry: Every entry has equal debits and credits
   * 2. Accrual Basis: Revenue recognized when earned (not when cash received)
   * 3. Matching Principle: Expenses matched to revenue period
   * 4. Going Concern: Book value reported on balance sheet
   * 5. Materiality: Small amounts ($0.01) recorded correctly
   */

  describe('Double-Entry: Trial balance always balanced', () => {
    let ctx: ReturnType<typeof createFreshModels>;

    beforeAll(async () => {
      ctx = createFreshModels();
      await ctx.seedAccounts();

      // Post multiple varied entries
      await ctx.postEntry('2024-06-01', [
        { account: '1000', debit: 5_000_000, credit: 0 },
        { account: '3000', debit: 0, credit: 5_000_000 },
      ]);
      await ctx.postEntry('2024-06-15', [
        { account: '1100', debit: 1_000_000, credit: 0 },
        { account: '4100', debit: 0, credit: 1_000_000 },
      ]);
      await ctx.postEntry('2024-06-20', [
        { account: '6100', debit: 200_000, credit: 0 },
        { account: '6000', debit: 300_000, credit: 0 },
        { account: '1000', debit: 0, credit: 500_000 },
      ]);
      await ctx.postEntry('2024-06-25', [
        { account: '1000', debit: 500_000, credit: 0 },
        { account: '1100', debit: 0, credit: 500_000 },
      ]);
    });

    it('trial balance debits equal credits after all entries', async () => {
      const tb = await ctx.reports.trialBalance({
        dateOption: 'month',
        dateValue: '2024-06',
      });

      const totalDebit = legacyTrialBalance(tb).rows.reduce((s, r) => s + r.ending.debit, 0);
      const totalCredit = legacyTrialBalance(tb).rows.reduce((s, r) => s + r.ending.credit, 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBeGreaterThan(0);
    });

    it('balance sheet balances after compound entries', async () => {
      const bs = await ctx.reports.balanceSheet({
        dateOption: 'month',
        dateValue: '2024-06',
      });

      expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    });
  });

  describe('Accrual Basis: Revenue recognized when earned', () => {
    let ctx: ReturnType<typeof createFreshModels>;

    beforeAll(async () => {
      ctx = createFreshModels();
      await ctx.seedAccounts();

      // Capital investment
      await ctx.postEntry('2024-01-01', [
        { account: '1000', debit: 1_000_000, credit: 0 },
        { account: '3000', debit: 0, credit: 1_000_000 },
      ]);

      // Jan: Perform service on credit (no cash received) — revenue earned
      await ctx.postEntry('2024-01-15', [
        { account: '1100', debit: 500_000, credit: 0 },
        { account: '4100', debit: 0, credit: 500_000 },
      ]);

      // Feb: Cash received for January service
      await ctx.postEntry('2024-02-10', [
        { account: '1000', debit: 500_000, credit: 0 },
        { account: '1100', debit: 0, credit: 500_000 },
      ]);
    });

    it('revenue appears in January (when earned), not February (when cash received)', async () => {
      const janIS = await ctx.reports.incomeStatement({
        dateOption: 'month',
        dateValue: '2024-01',
      });

      const febIS = await ctx.reports.incomeStatement({
        dateOption: 'month',
        dateValue: '2024-02',
      });

      // Revenue recognized in January (accrual basis)
      expect(legacyIncomeStatement(janIS).revenue.total).toBe(500_000);
      expect(legacyIncomeStatement(janIS).netIncome).toBe(500_000);

      // No new revenue in February (just cash collection)
      expect(legacyIncomeStatement(febIS).revenue.total).toBe(0);
      expect(legacyIncomeStatement(febIS).netIncome).toBe(0);
    });

    it('cash increases in February but revenue does not', async () => {
      // Jan cash: $10,000 (no cash from service yet)
      const janGL = await ctx.reports.generalLedger({
        dateOption: 'month',
        dateValue: '2024-01',
        accountId: String(ctx.acctIds['1000']),
      });
      expect(janGL.accounts[0].closingBalance).toBe(1_000_000); // $10,000

      // Feb cash: $10,000 + $5,000 = $15,000
      const febGL = await ctx.reports.generalLedger({
        dateOption: 'month',
        dateValue: '2024-02',
        accountId: String(ctx.acctIds['1000']),
      });
      expect(febGL.accounts[0].closingBalance).toBe(1_500_000); // $15,000
    });
  });

  describe('Matching Principle: Expenses matched to revenue period', () => {
    let ctx: ReturnType<typeof createFreshModels>;

    beforeAll(async () => {
      ctx = createFreshModels();
      await ctx.seedAccounts();

      // Capital
      await ctx.postEntry('2024-01-01', [
        { account: '1000', debit: 2_000_000, credit: 0 },
        { account: '3000', debit: 0, credit: 2_000_000 },
      ]);

      // Jan 1: Prepaid insurance $1,200 for 12 months
      await ctx.postEntry('2024-01-01', [
        { account: '1300', debit: 120_000, credit: 0 },
        { account: '1000', debit: 0, credit: 120_000 },
      ]);

      // Jan 31: Recognize 1/12 of insurance = $100
      await ctx.postEntry('2024-01-31', [
        { account: '6300', debit: 10_000, credit: 0 },
        { account: '1300', debit: 0, credit: 10_000 },
      ]);

      // Feb 28: Recognize another 1/12 = $100
      await ctx.postEntry('2024-02-28', [
        { account: '6300', debit: 10_000, credit: 0 },
        { account: '1300', debit: 0, credit: 10_000 },
      ]);
    });

    it('insurance expense is $100 per month (not $1,200 in Jan)', async () => {
      const janIS = await ctx.reports.incomeStatement({
        dateOption: 'month',
        dateValue: '2024-01',
      });

      const febIS = await ctx.reports.incomeStatement({
        dateOption: 'month',
        dateValue: '2024-02',
      });

      // Each month gets exactly $100 of insurance expense
      expect(legacyIncomeStatement(janIS).expenses.total).toBe(10_000); // $100
      expect(legacyIncomeStatement(febIS).expenses.total).toBe(10_000); // $100
    });

    it('prepaid insurance decreases each month', async () => {
      const janGL = await ctx.reports.generalLedger({
        dateOption: 'month',
        dateValue: '2024-01',
        accountId: String(ctx.acctIds['1300']),
      });

      const febGL = await ctx.reports.generalLedger({
        dateOption: 'month',
        dateValue: '2024-02',
        accountId: String(ctx.acctIds['1300']),
      });

      // Jan: $1,200 - $100 = $1,100
      expect(janGL.accounts[0].closingBalance).toBe(110_000);
      // Feb: $1,100 - $100 = $1,000
      expect(febGL.accounts[0].closingBalance).toBe(100_000);
    });
  });

  describe('Going Concern: Assets at book value on balance sheet', () => {
    let ctx: ReturnType<typeof createFreshModels>;

    beforeAll(async () => {
      ctx = createFreshModels();
      await ctx.seedAccounts();

      // Capital
      await ctx.postEntry('2024-01-01', [
        { account: '1000', debit: 5_000_000, credit: 0 },
        { account: '3000', debit: 0, credit: 5_000_000 },
      ]);

      // Buy equipment for $10,000
      await ctx.postEntry('2024-01-01', [
        { account: '1500', debit: 1_000_000, credit: 0 },
        { account: '1000', debit: 0, credit: 1_000_000 },
      ]);

      // Depreciate $2,000 over the year
      await ctx.postEntry('2024-12-31', [
        { account: '6500', debit: 200_000, credit: 0 },
        { account: '1510', debit: 0, credit: 200_000 },
      ]);
    });

    it('equipment shown at book value (cost minus accumulated depreciation)', async () => {
      const bs = await ctx.reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2024,
      });

      // Non-Current Assets group: Equipment $10,000 - Accum Depr $2,000 = $8,000
      const ncaGroup = legacyBalanceSheet(bs).assets.groups.find((g) => g.name === 'Non-Current Assets');
      expect(ncaGroup).toBeDefined();
      expect(ncaGroup?.total).toBe(800_000); // $8,000 net book value

      // Verify Equipment and Accum Depr are shown separately
      const equipAcct = ncaGroup?.accounts.find((a) => a.code === '1500');
      const accumDepr = ncaGroup?.accounts.find((a) => a.code === '1510');
      expect(equipAcct).toBeDefined();
      expect(accumDepr).toBeDefined();
      expect(equipAcct?.balance).toBe(1_000_000); // $10,000 cost
      expect(accumDepr?.balance).toBe(-200_000); // -$2,000 contra
    });
  });

  describe('Materiality: Small amounts recorded correctly', () => {
    let ctx: ReturnType<typeof createFreshModels>;

    beforeAll(async () => {
      ctx = createFreshModels();
      await ctx.seedAccounts();

      // Capital: $0.01 (1 cent)
      await ctx.postEntry('2024-01-01', [
        { account: '1000', debit: 1, credit: 0 },
        { account: '3000', debit: 0, credit: 1 },
      ]);

      // Revenue: $0.01
      await ctx.postEntry('2024-01-15', [
        { account: '1000', debit: 1, credit: 0 },
        { account: '4100', debit: 0, credit: 1 },
      ]);

      // Expense: $0.01
      await ctx.postEntry('2024-01-20', [
        { account: '6100', debit: 1, credit: 0 },
        { account: '1000', debit: 0, credit: 1 },
      ]);
    });

    it('1-cent amounts are tracked without rounding errors', async () => {
      const tb = await ctx.reports.trialBalance({
        dateOption: 'month',
        dateValue: '2024-01',
      });

      const totalDebit = legacyTrialBalance(tb).rows.reduce((s, r) => s + r.ending.debit, 0);
      const totalCredit = legacyTrialBalance(tb).rows.reduce((s, r) => s + r.ending.credit, 0);
      expect(totalDebit).toBe(totalCredit);
    });

    it('balance sheet balances with 1-cent amounts', async () => {
      const bs = await ctx.reports.balanceSheet({
        dateOption: 'month',
        dateValue: '2024-01',
      });

      expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
      expect(legacyBalanceSheet(bs).summary.difference).toBe(0);
      // Cash: 1 + 1 - 1 = 1 cent
      expect(legacyBalanceSheet(bs).summary.totalAssets).toBe(1);
    });

    it('income statement correctly shows net income of $0.00', async () => {
      const is = await ctx.reports.incomeStatement({
        dateOption: 'month',
        dateValue: '2024-01',
      });

      // Revenue $0.01 - Expense $0.01 = $0.00
      expect(legacyIncomeStatement(is).revenue.total).toBe(1);
      expect(legacyIncomeStatement(is).expenses.total).toBe(1);
      expect(legacyIncomeStatement(is).netIncome).toBe(0);
    });
  });
});
