import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { createBudgetSchema } from '../../src/schemas/budget.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { generateBudgetVsActual } from '../../src/reports/budget-vs-actual.js';

// ── Test country pack ────────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'BVA', name: 'Budget Test', defaultCurrency: 'TST',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '4000', name: 'Sales Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '5000', name: 'Cost of Sales', category: 'Income Statement-Expense', description: 'COGS', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '6000', name: 'Rent Expense', category: 'Income Statement-Expense', description: 'Rent', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '7000', name: 'Utilities', category: 'Income Statement-Expense', description: 'Utilities', parentCode: null, isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
});

const config: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
};

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;
let BudgetModel: mongoose.Model<any>;

let cashId: mongoose.Types.ObjectId;
let revenueId: mongoose.Types.ObjectId;
let cogsId: mongoose.Types.ObjectId;
let rentId: mongoose.Types.ObjectId;
let utilitiesId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const acctSchema = createAccountSchema(config);
  if (mongoose.models['BVAAccount']) delete mongoose.models['BVAAccount'];
  AccountModel = mongoose.model('BVAAccount', acctSchema);

  const jeSchema = createJournalEntrySchema(config, 'BVAAccount');
  if (mongoose.models['BVAJE']) delete mongoose.models['BVAJE'];
  JEModel = mongoose.model('BVAJE', jeSchema);

  const budgetSchema = createBudgetSchema(config);
  if (mongoose.models['BVABudget']) delete mongoose.models['BVABudget'];
  BudgetModel = mongoose.model('BVABudget', budgetSchema);

  await AccountModel.createIndexes();
  await JEModel.createIndexes();
  await BudgetModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await JEModel.deleteMany({});
  await BudgetModel.deleteMany({});

  // Seed accounts
  const cash = await AccountModel.create({ accountTypeCode: '1000' });
  const revenue = await AccountModel.create({ accountTypeCode: '4000' });
  const cogs = await AccountModel.create({ accountTypeCode: '5000' });
  const rent = await AccountModel.create({ accountTypeCode: '6000' });
  const utilities = await AccountModel.create({ accountTypeCode: '7000' });

  cashId = cash._id;
  revenueId = revenue._id;
  cogsId = cogs._id;
  rentId = rent._id;
  utilitiesId = utilities._id;
});

/** Helper: create a posted journal entry */
async function postEntry(date: string, items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>) {
  return JEModel.create({
    journalType: 'GENERAL',
    state: 'posted',
    date: new Date(date),
    journalItems: items,
    totalDebit: items.reduce((s, i) => s + i.debit, 0),
    totalCredit: items.reduce((s, i) => s + i.credit, 0),
  });
}

/** Helper: create a budget record */
async function createBudget(account: mongoose.Types.ObjectId, periodStart: string, periodEnd: string, amount: number) {
  return BudgetModel.create({
    account,
    periodStart: new Date(periodStart),
    periodEnd: new Date(periodEnd),
    amount,
  });
}

const reportOpts = () => ({
  AccountModel,
  JournalEntryModel: JEModel,
  BudgetModel,
  country: testPack,
});

describe('Budget vs Actual Report', () => {
  it('computes correct variance for expense account', async () => {
    // Budget rent at 200000 cents ($2000)
    await createBudget(rentId, '2025-01-01', '2025-01-31', 200000);

    // Actual rent expense: $1800 (debit rent, credit cash)
    await postEntry('2025-01-15', [
      { account: rentId, debit: 180000, credit: 0 },
      { account: cashId, debit: 0, credit: 180000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.accountCode).toBe('6000');
    expect(row.budgetAmount).toBe(200000);
    expect(row.actualAmount).toBe(180000);
    expect(row.variance).toBe(-20000); // under budget
    expect(row.variancePercent).toBe(-10); // -10%
  });

  it('over-budget scenario (expense higher than budgeted)', async () => {
    await createBudget(rentId, '2025-01-01', '2025-01-31', 100000);

    await postEntry('2025-01-10', [
      { account: rentId, debit: 150000, credit: 0 },
      { account: cashId, debit: 0, credit: 150000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    const row = report.rows[0];
    expect(row.budgetAmount).toBe(100000);
    expect(row.actualAmount).toBe(150000);
    expect(row.variance).toBe(50000); // over budget
    expect(row.variancePercent).toBe(50); // +50%
  });

  it('under-budget scenario', async () => {
    await createBudget(cogsId, '2025-03-01', '2025-03-31', 500000);

    await postEntry('2025-03-15', [
      { account: cogsId, debit: 300000, credit: 0 },
      { account: cashId, debit: 0, credit: 300000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-03',
    });

    const row = report.rows[0];
    expect(row.budgetAmount).toBe(500000);
    expect(row.actualAmount).toBe(300000);
    expect(row.variance).toBe(-200000);
    expect(row.variancePercent).toBe(-40);
  });

  it('zero budget yields variancePercent = 0', async () => {
    await createBudget(rentId, '2025-01-01', '2025-01-31', 0);

    await postEntry('2025-01-15', [
      { account: rentId, debit: 50000, credit: 0 },
      { account: cashId, debit: 0, credit: 50000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    const row = report.rows[0];
    expect(row.budgetAmount).toBe(0);
    expect(row.actualAmount).toBe(50000);
    expect(row.variance).toBe(50000);
    expect(row.variancePercent).toBe(0);
  });

  it('multiple accounts with different budgets', async () => {
    await createBudget(rentId, '2025-01-01', '2025-01-31', 200000);
    await createBudget(cogsId, '2025-01-01', '2025-01-31', 300000);
    await createBudget(revenueId, '2025-01-01', '2025-01-31', 1000000);

    // Actual rent $1500
    await postEntry('2025-01-10', [
      { account: rentId, debit: 150000, credit: 0 },
      { account: cashId, debit: 0, credit: 150000 },
    ]);

    // Actual COGS $3500
    await postEntry('2025-01-15', [
      { account: cogsId, debit: 350000, credit: 0 },
      { account: cashId, debit: 0, credit: 350000 },
    ]);

    // Actual revenue $12000 (credit revenue, debit cash)
    await postEntry('2025-01-20', [
      { account: cashId, debit: 1200000, credit: 0 },
      { account: revenueId, debit: 0, credit: 1200000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    expect(report.rows).toHaveLength(3);

    // Sorted by account code: 4000, 5000, 6000
    expect(report.rows[0].accountCode).toBe('4000');
    expect(report.rows[1].accountCode).toBe('5000');
    expect(report.rows[2].accountCode).toBe('6000');

    // Revenue (income): actual = credits - debits = 1200000
    expect(report.rows[0].budgetAmount).toBe(1000000);
    expect(report.rows[0].actualAmount).toBe(1200000);
    expect(report.rows[0].variance).toBe(200000);

    // COGS (expense): actual = debits - credits = 350000
    expect(report.rows[1].budgetAmount).toBe(300000);
    expect(report.rows[1].actualAmount).toBe(350000);
    expect(report.rows[1].variance).toBe(50000);

    // Rent (expense): actual = 150000
    expect(report.rows[2].budgetAmount).toBe(200000);
    expect(report.rows[2].actualAmount).toBe(150000);
    expect(report.rows[2].variance).toBe(-50000);

    // Summary
    expect(report.summary.totalBudget).toBe(1500000);
    expect(report.summary.totalActual).toBe(1700000);
    expect(report.summary.totalVariance).toBe(200000);
  });

  it('account with actual but no budget is excluded from report', async () => {
    // Only budget for rent, but post entries for both rent and cogs
    await createBudget(rentId, '2025-01-01', '2025-01-31', 200000);

    await postEntry('2025-01-10', [
      { account: rentId, debit: 150000, credit: 0 },
      { account: cashId, debit: 0, credit: 150000 },
    ]);

    // COGS has actuals but no budget
    await postEntry('2025-01-15', [
      { account: cogsId, debit: 300000, credit: 0 },
      { account: cashId, debit: 0, credit: 300000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    // Only rent should appear (has budget)
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].accountCode).toBe('6000');
  });

  it('account with budget but no actual shows actual = 0', async () => {
    await createBudget(utilitiesId, '2025-02-01', '2025-02-28', 75000);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-02',
    });

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.accountCode).toBe('7000');
    expect(row.budgetAmount).toBe(75000);
    expect(row.actualAmount).toBe(0);
    expect(row.variance).toBe(-75000);
    expect(row.variancePercent).toBe(-100);
  });

  it('sorts results by account code', async () => {
    await createBudget(rentId, '2025-01-01', '2025-01-31', 100000);     // 6000
    await createBudget(cogsId, '2025-01-01', '2025-01-31', 200000);     // 5000
    await createBudget(revenueId, '2025-01-01', '2025-01-31', 500000);  // 4000
    await createBudget(utilitiesId, '2025-01-01', '2025-01-31', 50000); // 7000

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    expect(report.rows).toHaveLength(4);
    expect(report.rows[0].accountCode).toBe('4000');
    expect(report.rows[1].accountCode).toBe('5000');
    expect(report.rows[2].accountCode).toBe('6000');
    expect(report.rows[3].accountCode).toBe('7000');
  });

  it('income account: actual = credits - debits', async () => {
    await createBudget(revenueId, '2025-01-01', '2025-01-31', 500000);

    // Revenue: credit 600000
    await postEntry('2025-01-10', [
      { account: cashId, debit: 600000, credit: 0 },
      { account: revenueId, debit: 0, credit: 600000 },
    ]);

    // Revenue refund: debit 100000
    await postEntry('2025-01-20', [
      { account: revenueId, debit: 100000, credit: 0 },
      { account: cashId, debit: 0, credit: 100000 },
    ]);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-01',
    });

    const row = report.rows[0];
    // actual = credits(600000) - debits(100000) = 500000
    expect(row.actualAmount).toBe(500000);
    expect(row.variance).toBe(0);
  });

  it('report metadata includes period dates', async () => {
    await createBudget(rentId, '2025-06-01', '2025-06-30', 100000);

    const report = await generateBudgetVsActual(reportOpts(), {
      dateOption: 'month',
      dateValue: '2025-06',
    });

    expect(report.metadata.generatedAt).toBeDefined();
    expect(report.metadata.periodStart).toBeDefined();
    expect(report.metadata.periodEnd).toBeDefined();
  });
});
