/**
 * E2E Scenario Test: Maple Consulting Inc. — Canadian IT Consulting Firm
 *
 * Full year lifecycle (FY Jan–Dec 2025) of a Canadian small business.
 * Proves that @classytic/ledger can power a QuickBooks/Xero competitor.
 *
 * Covers:
 *  - GIFI-style chart of accounts seeding
 *  - Opening balance migration (from QuickBooks)
 *  - Monthly operational entries (revenue, expenses, payroll)
 *  - HST collection and input tax credits
 *  - Balance sheet, income statement, trial balance, general ledger, cash flow
 *  - Retained earnings treatment (3600 not in shareholder equity group)
 *  - Report metadata and data quality checks
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountingEngine } from '../../src/engine.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import type { AccountType } from '../../src/types/core.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Inline Canada-like Country Pack (self-contained — no ledger-ca dependency)
// ═══════════════════════════════════════════════════════════════════════════════

const MAPLE_ACCOUNT_TYPES: readonly AccountType[] = [
  // ── Asset Groups & Accounts ─────────────────────────────────────────────
  { code: '1000', name: 'Current Assets', category: 'Balance Sheet-Asset', description: 'Current Assets Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '1001', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash and bank accounts', parentCode: '1000', isTotal: false, cashFlowCategory: 'Operating' },
  { code: '1200', name: 'Accounts Receivable', category: 'Balance Sheet-Asset', description: 'Trade receivables', parentCode: '1000', isTotal: false, cashFlowCategory: 'Operating' },

  { code: '1400', name: 'Capital Assets', category: 'Balance Sheet-Asset', description: 'Capital Assets Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '1500', name: 'Equipment', category: 'Balance Sheet-Asset', description: 'Office and computer equipment', parentCode: '1400', isTotal: false, cashFlowCategory: 'Investing' },

  // ── Liability Groups & Accounts ─────────────────────────────────────────
  { code: '2000', name: 'Current Liabilities', category: 'Balance Sheet-Liability', description: 'Current Liabilities Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '2001', name: 'Accounts Payable', category: 'Balance Sheet-Liability', description: 'Trade payables', parentCode: '2000', isTotal: false, cashFlowCategory: 'Operating' },
  { code: '2300', name: 'HST Collected', category: 'Balance Sheet-Liability', description: 'HST collected on sales', parentCode: '2000', isTotal: false, cashFlowCategory: 'Operating' },
  { code: '2400', name: 'HST Paid (ITC)', category: 'Balance Sheet-Asset', description: 'HST input tax credits recoverable', parentCode: '1000', isTotal: false, cashFlowCategory: 'Operating' },

  // ── Equity Groups & Accounts ────────────────────────────────────────────
  { code: '3400', name: 'Shareholder Equity', category: 'Balance Sheet-Equity', description: 'Shareholder Equity Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '3500', name: 'Common Shares', category: 'Balance Sheet-Equity', description: 'Issued share capital', parentCode: '3400', isTotal: false, cashFlowCategory: 'Financing' },

  { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'Accumulated retained earnings', parentCode: null, isTotal: false, cashFlowCategory: null },

  // ── Revenue Group & Accounts ────────────────────────────────────────────
  { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '4020', name: 'Consulting Revenue', category: 'Income Statement-Income', description: 'IT consulting fees', parentCode: '4000', isTotal: false, cashFlowCategory: null },

  // ── COGS Group & Accounts ───────────────────────────────────────────────
  { code: '5000', name: 'Cost of Sales', category: 'Income Statement-Expense', description: 'Cost of Sales Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '5020', name: 'Subcontractor Costs', category: 'Income Statement-Expense', description: 'Subcontractor and freelancer costs', parentCode: '5000', isTotal: false, cashFlowCategory: null },

  // ── Operating Expense Group & Accounts ──────────────────────────────────
  { code: '6000', name: 'Operating Expenses', category: 'Income Statement-Expense', description: 'Operating Expenses Group', parentCode: null, isGroup: true, cashFlowCategory: null },
  { code: '6010', name: 'Rent', category: 'Income Statement-Expense', description: 'Office rent', parentCode: '6000', isTotal: false, cashFlowCategory: null },
  { code: '6100', name: 'Salaries', category: 'Income Statement-Expense', description: 'Employee salaries', parentCode: '6000', isTotal: false, cashFlowCategory: null },
  { code: '6200', name: 'Office Supplies', category: 'Income Statement-Expense', description: 'Office supplies and stationery', parentCode: '6000', isTotal: false, cashFlowCategory: null },
];

const maplePack = defineCountryPack({
  code: 'CA',
  name: 'Canada',
  defaultCurrency: 'CAD',
  accountTypes: MAPLE_ACCOUNT_TYPES,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: ['ON'],
  retainedEarningsAccountCode: '3600',
  retainedEarningsDisplayCode: '3660',
  currentYearEarningsCode: '3680',
  cogsGroupCode: 'Cost of Sales',
});

const config: AccountingEngineConfig = {
  country: maplePack,
  currency: 'CAD',
  retainedEarningsAccountCode: '3600',
  retainedEarningsDisplayCode: '3660',
  currentYearEarningsCode: '3680',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Test Infrastructure
// ═══════════════════════════════════════════════════════════════════════════════

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;
let engine: ReturnType<typeof createAccountingEngine>;
let reports: ReturnType<typeof engine.createReports>;

// Account ObjectId lookup
const acctIds: Record<string, mongoose.Types.ObjectId> = {};

/** Helper: post a journal entry with balanced items (all amounts in integer cents) */
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

// ═══════════════════════════════════════════════════════════════════════════════
// Global Setup / Teardown
// ═══════════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  engine = createAccountingEngine(config);

  // Register models with unique names to avoid collisions with other test files
  const acctSchema = engine.createAccountSchema();
  if (mongoose.models['MapleAccount']) delete mongoose.models['MapleAccount'];
  AccountModel = mongoose.model('MapleAccount', acctSchema);

  const jeSchema = engine.createJournalEntrySchema('MapleAccount');
  if (mongoose.models['MapleJE']) delete mongoose.models['MapleJE'];
  JEModel = mongoose.model('MapleJE', jeSchema);

  await AccountModel.createIndexes();
  await JEModel.createIndexes();

  reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Account Setup
// ═══════════════════════════════════════════════════════════════════════════════

describe('Account Setup', () => {
  it('seeds all posting accounts from the Canada-like pack', async () => {
    const postingTypes = maplePack.getPostingAccountTypes();

    for (const at of postingTypes) {
      const doc = await AccountModel.create({ accountTypeCode: at.code });
      acctIds[at.code] = doc._id;
    }

    const count = await AccountModel.countDocuments();
    expect(count).toBe(postingTypes.length);
  });

  it('has accounts across all five categories', () => {
    const postingTypes = maplePack.getPostingAccountTypes();
    const categories = new Set(postingTypes.map((a) => a.category));
    expect(categories.has('Balance Sheet-Asset')).toBe(true);
    expect(categories.has('Balance Sheet-Liability')).toBe(true);
    expect(categories.has('Balance Sheet-Equity')).toBe(true);
    expect(categories.has('Income Statement-Income')).toBe(true);
    expect(categories.has('Income Statement-Expense')).toBe(true);
  });

  it('has a retained earnings account at code 3600', () => {
    const re = maplePack.getAccountType('3600');
    expect(re).toBeDefined();
    expect(re!.name).toBe('Retained Earnings');
    expect(re!.category).toBe('Balance Sheet-Equity');
  });

  it('marks group accounts as non-posting', () => {
    expect(maplePack.isPostingAccount('1000')).toBe(false); // Current Assets group
    expect(maplePack.isPostingAccount('6000')).toBe(false); // Operating Expenses group
    expect(maplePack.isPostingAccount('1001')).toBe(true);  // Cash — posting
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Opening Balances — Migration from QuickBooks
// ═══════════════════════════════════════════════════════════════════════════════

describe('Opening Balances — Migration from QuickBooks', () => {
  it('posts an opening balance entry with Assets = Equity', async () => {
    // Migration: Cash $50,000 + Equipment $20,000 = Shares $10,000 + RE $60,000
    await postEntry('2025-01-01', [
      { account: '1001', debit: 5_000_000, credit: 0 },        // Cash $50,000
      { account: '1500', debit: 2_000_000, credit: 0 },        // Equipment $20,000
      { account: '3500', debit: 0, credit: 1_000_000 },        // Common Shares $10,000
      { account: '3600', debit: 0, credit: 6_000_000 },        // Retained Earnings $60,000
    ]);

    // Verify the entry was stored
    const entries = await JEModel.find({ state: 'posted' });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('trial balance is balanced after migration', async () => {
    const tb = await reports.trialBalance({
      dateOption: 'month',
      dateValue: '2025-01',
    });

    const totalDebit = tb.rows.reduce((s, r) => s + r.ending.debit, 0);
    const totalCredit = tb.rows.reduce((s, r) => s + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeGreaterThan(0);
  });

  it('balance sheet balances after migration (A = L + E)', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-01',
      businessName: 'Maple Consulting Inc.',
    });

    expect(bs.summary.isBalanced).toBe(true);
    expect(bs.summary.difference).toBe(0);
    expect(bs.summary.totalAssets).toBe(7_000_000); // $50k + $20k
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Monthly Operations — Q1 2025
// ═══════════════════════════════════════════════════════════════════════════════

describe('Monthly Operations — Q1 2025', () => {
  it('records January operations: revenue, rent, salary', async () => {
    // Revenue: $15,000 consulting
    await postEntry('2025-01-15', [
      { account: '1001', debit: 1_500_000, credit: 0 },
      { account: '4020', debit: 0, credit: 1_500_000 },
    ]);

    // Rent: $2,000
    await postEntry('2025-01-20', [
      { account: '6010', debit: 200_000, credit: 0 },
      { account: '1001', debit: 0, credit: 200_000 },
    ]);

    // Salary: $8,000
    await postEntry('2025-01-25', [
      { account: '6100', debit: 800_000, credit: 0 },
      { account: '1001', debit: 0, credit: 800_000 },
    ]);

    const janIS = await reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-01',
    });

    expect(janIS.revenue.total).toBe(1_500_000);
  });

  it('records February operations: revenue, office supplies, salary', async () => {
    // Revenue: $18,000
    await postEntry('2025-02-10', [
      { account: '1001', debit: 1_800_000, credit: 0 },
      { account: '4020', debit: 0, credit: 1_800_000 },
    ]);

    // Office Supplies: $500
    await postEntry('2025-02-15', [
      { account: '6200', debit: 50_000, credit: 0 },
      { account: '1001', debit: 0, credit: 50_000 },
    ]);

    // Salary: $8,000
    await postEntry('2025-02-25', [
      { account: '6100', debit: 800_000, credit: 0 },
      { account: '1001', debit: 0, credit: 800_000 },
    ]);

    const febIS = await reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-02',
    });

    expect(febIS.revenue.total).toBe(1_800_000);
  });

  it('records March operations: revenue, equipment purchase, salary', async () => {
    // Revenue: $12,000
    await postEntry('2025-03-05', [
      { account: '1001', debit: 1_200_000, credit: 0 },
      { account: '4020', debit: 0, credit: 1_200_000 },
    ]);

    // Equipment purchase: $5,000
    await postEntry('2025-03-10', [
      { account: '1500', debit: 500_000, credit: 0 },
      { account: '1001', debit: 0, credit: 500_000 },
    ]);

    // Salary: $8,000
    await postEntry('2025-03-25', [
      { account: '6100', debit: 800_000, credit: 0 },
      { account: '1001', debit: 0, credit: 800_000 },
    ]);

    const marIS = await reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-03',
    });

    expect(marIS.revenue.total).toBe(1_200_000);
  });

  it('Q1 income statement shows correct gross profit and net income', async () => {
    const q1IS = await reports.incomeStatement({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    // Q1 Revenue: $15k + $18k + $12k = $45,000
    const expectedRevenue = 4_500_000;
    expect(q1IS.revenue.total).toBe(expectedRevenue);

    // Q1 Gross Profit = Revenue - COGS (no COGS posted, so grossProfit = revenue)
    expect(q1IS.grossProfit).toBe(expectedRevenue);

    // Q1 Expenses: Rent $2k + Salaries $24k (3x $8k) + Supplies $500 = $26,500
    const expectedExpenses = 2_650_000;

    // Net income = Revenue - all expenses
    expect(q1IS.netIncome).toBe(expectedRevenue - expectedExpenses);
  });

  it('Q1 trial balance has all accounts with activity', async () => {
    const q1TB = await reports.trialBalance({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    expect(q1TB.rows.length).toBeGreaterThan(0);

    // Every row with activity should have non-zero ending balance
    const activeRows = q1TB.rows.filter(
      (r) => r.ending.debit > 0 || r.ending.credit > 0,
    );
    expect(activeRows.length).toBeGreaterThanOrEqual(5);

    // Trial balance must be balanced
    const totalDebit = q1TB.rows.reduce((s, r) => s + r.ending.debit, 0);
    const totalCredit = q1TB.rows.reduce((s, r) => s + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Tax Collection — HST
// ═══════════════════════════════════════════════════════════════════════════════

describe('Tax Collection — HST', () => {
  it('posts HST collected on Q1 revenue (13% on $45,000)', async () => {
    // HST Collected = 13% of $45,000 = $5,850
    // In practice, HST would be recorded per invoice. We batch for simplicity.
    await postEntry('2025-03-31', [
      { account: '1200', debit: 585_000, credit: 0 },    // AR for HST portion
      { account: '2300', debit: 0, credit: 585_000 },     // HST Collected liability
    ]);

    const hstCollectedAccount = await AccountModel.findOne({ accountTypeCode: '2300' });
    expect(hstCollectedAccount).toBeDefined();
  });

  it('posts HST paid on eligible expenses (ITC)', async () => {
    // ITC on eligible expenses: Rent $2k + Supplies $500 = $2,500 x 13% = $325
    // (Salaries are not subject to HST)
    await postEntry('2025-03-31', [
      { account: '2400', debit: 32_500, credit: 0 },      // HST Paid (ITC) asset
      { account: '2001', debit: 0, credit: 32_500 },      // AP for HST portion
    ]);

    const hstPaidAccount = await AccountModel.findOne({ accountTypeCode: '2400' });
    expect(hstPaidAccount).toBeDefined();
  });

  it('HST accounts have correct balances in trial balance', async () => {
    const tb = await reports.trialBalance({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    // HST Collected (2300) should have a credit balance of $5,850
    const hstCollectedRow = tb.rows.find(
      (r) => String((r.account as any)._id) === String(acctIds['2300']),
    );
    expect(hstCollectedRow).toBeDefined();
    expect(hstCollectedRow!.ending.credit).toBe(585_000);

    // HST Paid (2400) should have a debit balance of $325
    const hstPaidRow = tb.rows.find(
      (r) => String((r.account as any)._id) === String(acctIds['2400']),
    );
    expect(hstPaidRow).toBeDefined();
    expect(hstPaidRow!.ending.debit).toBe(32_500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Balance Sheet — Mid-Year
// ═══════════════════════════════════════════════════════════════════════════════

describe('Balance Sheet — Mid-Year', () => {
  // Post Q2 simplified entries before mid-year checks
  beforeAll(async () => {
    // Q2 monthly revenue: $15k/month x 3 = $45,000
    for (const month of ['04', '05', '06']) {
      await postEntry(`2025-${month}-15`, [
        { account: '1001', debit: 1_500_000, credit: 0 },
        { account: '4020', debit: 0, credit: 1_500_000 },
      ]);
      // Salary: $8,000/month
      await postEntry(`2025-${month}-25`, [
        { account: '6100', debit: 800_000, credit: 0 },
        { account: '1001', debit: 0, credit: 800_000 },
      ]);
    }
  });

  it('balance sheet as of June 2025 is balanced', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-06',
      businessName: 'Maple Consulting Inc.',
    });

    expect(bs.summary.isBalanced).toBe(true);
    expect(bs.summary.difference).toBe(0);
    expect(bs.summary.totalAssets).toBeGreaterThan(0);
    expect(bs.summary.totalLiabilities).toBeGreaterThanOrEqual(0);
    expect(bs.summary.totalEquity).toBeGreaterThan(0);
  });

  it('equity section includes retained earnings from migration', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-06',
      businessName: 'Maple Consulting Inc.',
    });

    // Total equity should include the $60k RE from migration + shares + current year income
    expect(bs.equity.total).toBeGreaterThan(6_000_000);
  });

  it('3600 (Retained Earnings) is NOT in Shareholder Equity group', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-06',
      businessName: 'Maple Consulting Inc.',
    });

    // Find the Shareholder Equity group in equity categories
    const shareholderGroup = bs.equity.groups.find(
      (g) => g.name === 'Shareholder Equity',
    );

    if (shareholderGroup) {
      // 3600 should NOT appear in the Shareholder Equity group —
      // it should be handled as part of the retained earnings computation
      const reInShareholderGroup = shareholderGroup.accounts.find(
        (a) => a.code === '3600',
      );
      expect(reInShareholderGroup).toBeUndefined();
    }
  });

  it('has correct metadata', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-06',
      businessName: 'Maple Consulting Inc.',
    });

    expect(bs.metadata).toBeDefined();
    expect(bs.metadata.businessName).toBe('Maple Consulting Inc.');
    expect(bs.metadata.asOfDate).toBeDefined();
    expect(bs.metadata.generatedAt).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Income Statement — Full Year
// ═══════════════════════════════════════════════════════════════════════════════

describe('Income Statement — Full Year', () => {
  // Post Q3 and Q4 simplified entries
  beforeAll(async () => {
    for (const month of ['07', '08', '09', '10', '11', '12']) {
      // Revenue: $14k/month
      await postEntry(`2025-${month}-10`, [
        { account: '1001', debit: 1_400_000, credit: 0 },
        { account: '4020', debit: 0, credit: 1_400_000 },
      ]);

      // Salary: $8,000/month
      await postEntry(`2025-${month}-25`, [
        { account: '6100', debit: 800_000, credit: 0 },
        { account: '1001', debit: 0, credit: 800_000 },
      ]);
    }

    // Subcontractor cost (COGS) in Q3: $10,000
    await postEntry('2025-09-15', [
      { account: '5020', debit: 1_000_000, credit: 0 },
      { account: '1001', debit: 0, credit: 1_000_000 },
    ]);
  });

  it('full year income statement is profitable (Revenue > Expenses)', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    expect(is.revenue.total).toBeGreaterThan(0);
    expect(is.netIncome).toBeGreaterThan(0);
    expect(is.revenue.total).toBeGreaterThan(is.expenses.total);
  });

  it('full year revenue matches sum of all monthly revenue', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    // Q1: $45k + Q2: $45k + Q3-Q4: $14k x 6 = $84k = Total $174,000
    const expectedRevenue = 17_400_000;
    expect(is.revenue.total).toBe(expectedRevenue);
  });

  it('COGS is separated from operating expenses', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    // costOfSales should capture the $10k subcontractor cost
    expect(is.costOfSales).toBe(1_000_000);

    // grossProfit = revenue - COGS
    expect(is.grossProfit).toBe(is.revenue.total - is.costOfSales);
  });

  it('expense groups are present and contain correct accounts', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    // The expenses category should have groups
    expect(is.expenses.groups.length).toBeGreaterThan(0);

    // All accounts within groups should have codes
    for (const group of is.expenses.groups) {
      for (const account of group.accounts) {
        expect(account.code).toBeDefined();
        expect(account.code.length).toBeGreaterThan(0);
      }
    }
  });

  it('has correct metadata with period dates', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    expect(is.metadata).toBeDefined();
    expect(is.metadata.businessName).toBe('Maple Consulting Inc.');
    expect(is.metadata.periodStart).toBeDefined();
    expect(is.metadata.periodEnd).toBeDefined();
    expect(is.metadata.generatedAt).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. General Ledger — Cash Account
// ═══════════════════════════════════════════════════════════════════════════════

describe('General Ledger — Cash Account', () => {
  it('shows correct opening balance for a mid-year period', async () => {
    const gl = await reports.generalLedger({
      dateOption: 'quarter',
      dateValue: { quarter: 2, year: 2025 },
      accountId: String(acctIds['1001']),
    });

    expect(gl.accounts).toHaveLength(1);
    const cashLedger = gl.accounts[0];

    // Opening balance = all transactions before Q2 (prior to April 1)
    expect(cashLedger.openingBalance).toBeGreaterThan(0);
  });

  it('running balance is consistent after each transaction', async () => {
    const gl = await reports.generalLedger({
      dateOption: 'year',
      dateValue: 2025,
      accountId: String(acctIds['1001']),
    });

    const cashLedger = gl.accounts[0];

    // Verify running balance progression
    let balance = cashLedger.openingBalance;
    for (const entry of cashLedger.entries) {
      balance = balance + entry.debit - entry.credit;
      expect(entry.runningBalance).toBe(balance);
    }
  });

  it('closing balance = opening + sum(debits) - sum(credits)', async () => {
    const gl = await reports.generalLedger({
      dateOption: 'year',
      dateValue: 2025,
      accountId: String(acctIds['1001']),
    });

    const cashLedger = gl.accounts[0];
    const totalDebits = cashLedger.entries.reduce((s, e) => s + e.debit, 0);
    const totalCredits = cashLedger.entries.reduce((s, e) => s + e.credit, 0);

    expect(cashLedger.closingBalance).toBe(
      cashLedger.openingBalance + totalDebits - totalCredits,
    );
  });

  it('has multiple transactions reflecting business activity', async () => {
    const gl = await reports.generalLedger({
      dateOption: 'year',
      dateValue: 2025,
      accountId: String(acctIds['1001']),
    });

    const cashLedger = gl.accounts[0];
    // Should have many entries: opening balance, monthly revenue, rent, salaries, equipment...
    expect(cashLedger.entries.length).toBeGreaterThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Cash Flow Statement
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cash Flow Statement', () => {
  it('generates cash flow for full year 2025', async () => {
    const cf = await reports.cashFlow({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    expect(cf).toBeDefined();
    expect(cf.operating).toBeDefined();
    expect(cf.investing).toBeDefined();
    expect(cf.financing).toBeDefined();
  });

  it('has Operating, Investing, and Financing sections', async () => {
    const cf = await reports.cashFlow({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    // Operating should have activity (revenue, expenses)
    expect(cf.operating.accounts.length).toBeGreaterThan(0);

    // Net cash flow = operating + investing + financing
    expect(cf.netCashFlow).toBe(
      cf.operating.total + cf.investing.total + cf.financing.total,
    );
  });

  it('equipment purchase appears in Investing activities', async () => {
    const cf = await reports.cashFlow({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    // Equipment (1500) has cashFlowCategory 'Investing'
    const equipmentEntry = cf.investing.accounts.find(
      (a) => a.code === '1500',
    );
    expect(equipmentEntry).toBeDefined();
    // Equipment was purchased (debited), so investing shows outflow
    expect(equipmentEntry!.amount).not.toBe(0);
  });

  it('has correct metadata', async () => {
    const cf = await reports.cashFlow({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    expect(cf.metadata).toBeDefined();
    expect(cf.metadata.businessName).toBe('Maple Consulting Inc.');
    expect(cf.metadata.periodStart).toBeDefined();
    expect(cf.metadata.periodEnd).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Report Data Quality
// ═══════════════════════════════════════════════════════════════════════════════

describe('Report Data Quality', () => {
  it('all reports have metadata with generatedAt timestamp', async () => {
    const [bs, is, cf] = await Promise.all([
      reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2025,
        businessName: 'Maple Consulting Inc.',
      }),
      reports.incomeStatement({
        dateOption: 'year',
        dateValue: 2025,
        businessName: 'Maple Consulting Inc.',
      }),
      reports.cashFlow({
        dateOption: 'year',
        dateValue: 2025,
        businessName: 'Maple Consulting Inc.',
      }),
    ]);

    for (const report of [bs, is, cf]) {
      expect(report.metadata).toBeDefined();
      expect(report.metadata.generatedAt).toBeDefined();
      expect(report.metadata.businessName).toBe('Maple Consulting Inc.');
    }
  });

  it('balance sheet accounts are sorted by code within groups', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    for (const category of [bs.assets, bs.liabilities, bs.equity]) {
      for (const group of category.groups) {
        const codes = group.accounts.map((a) => a.code);
        const sorted = [...codes].sort();
        expect(codes).toEqual(sorted);
      }
    }
  });

  it('balance sheet is balanced at year-end', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'year',
      dateValue: 2025,
      businessName: 'Maple Consulting Inc.',
    });

    expect(bs.summary.isBalanced).toBe(true);
    expect(bs.summary.difference).toBe(0);
    expect(bs.summary.totalAssets).toBe(bs.summary.liabilitiesAndEquity);
  });

  it('income statement net income matches balance sheet current year earnings', async () => {
    const [bs, is] = await Promise.all([
      reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2025,
        businessName: 'Maple Consulting Inc.',
      }),
      reports.incomeStatement({
        dateOption: 'year',
        dateValue: 2025,
        businessName: 'Maple Consulting Inc.',
      }),
    ]);

    // The balance sheet equity section includes current year net income.
    // Total equity = shares + RE (opening) + current year net income.
    // We verify indirectly: if BS is balanced and IS net income is correct,
    // then equity must absorb the correct net income.
    const sharesBalance = 1_000_000; // $10k from migration
    const openingRE = 6_000_000;    // $60k from migration

    // Total equity should be shares + opening RE + current year net income
    expect(bs.equity.total).toBe(sharesBalance + openingRE + is.netIncome);
  });

  it('trial balance totals are balanced for the full year', async () => {
    const tb = await reports.trialBalance({
      dateOption: 'year',
      dateValue: 2025,
    });

    const totalDebit = tb.rows.reduce((s, r) => s + r.ending.debit, 0);
    const totalCredit = tb.rows.reduce((s, r) => s + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeGreaterThan(0);
  });

  it('general ledger cash closing balance matches balance sheet cash', async () => {
    const [gl, bs] = await Promise.all([
      reports.generalLedger({
        dateOption: 'year',
        dateValue: 2025,
        accountId: String(acctIds['1001']),
      }),
      reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2025,
        businessName: 'Maple Consulting Inc.',
      }),
    ]);

    const cashClosing = gl.accounts[0].closingBalance;

    // Find cash in the balance sheet
    let bsCashBalance = 0;
    for (const group of bs.assets.groups) {
      const cashAcct = group.accounts.find((a) => a.code === '1001');
      if (cashAcct) {
        bsCashBalance = cashAcct.balance;
        break;
      }
    }

    expect(cashClosing).toBe(bsCashBalance);
  });
});
