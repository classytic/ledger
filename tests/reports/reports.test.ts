import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { generateBalanceSheet } from '../../src/reports/balance-sheet.js';
import { generateCashFlow } from '../../src/reports/cash-flow.js';
import { closeFiscalPeriod, reopenFiscalPeriod } from '../../src/reports/fiscal-close.js';
import { generateGeneralLedger } from '../../src/reports/general-ledger.js';
import { generateIncomeStatement } from '../../src/reports/income-statement.js';
import { generateTrialBalance } from '../../src/reports/trial-balance.js';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createFiscalPeriodSchema } from '../../src/schemas/fiscal-period.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

// ── Test country pack ────────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'RPT',
  name: 'Report Test',
  defaultCurrency: 'TST',
  retainedEarningsAccountCode: '3660',
  accountTypes: [
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Asset',
      description: 'Cash',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'operating',
    },
    {
      code: '1200',
      name: 'Accounts Receivable',
      category: 'Balance Sheet-Asset',
      description: 'AR',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'operating',
    },
    {
      code: '2000',
      name: 'Accounts Payable',
      category: 'Balance Sheet-Liability',
      description: 'AP',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'operating',
    },
    {
      code: '3000',
      name: 'Share Capital',
      category: 'Balance Sheet-Equity',
      description: 'Equity',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '4000',
      name: 'Sales Revenue',
      category: 'Income Statement-Income',
      description: 'Revenue',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '5000',
      name: 'Cost of Sales',
      category: 'Income Statement-Expense',
      description: 'COGS',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '6000',
      name: 'Rent Expense',
      category: 'Income Statement-Expense',
      description: 'Rent',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '1500',
      name: 'Equipment',
      category: 'Balance Sheet-Asset',
      description: 'Equipment',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'Investing' as any,
    },
    {
      code: '2500',
      name: 'Loan Payable',
      category: 'Balance Sheet-Liability',
      description: 'Loan',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'Financing' as any,
    },
    {
      code: '3660',
      name: 'Retained Earnings',
      category: 'Balance Sheet-Equity',
      description: 'Retained Earnings',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
  ],
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

const config: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
};

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;

// Account ObjectIds
let cashId: mongoose.Types.ObjectId;
let arId: mongoose.Types.ObjectId;
let apId: mongoose.Types.ObjectId;
let equityId: mongoose.Types.ObjectId;
let revenueId: mongoose.Types.ObjectId;
let cogsId: mongoose.Types.ObjectId;
let rentId: mongoose.Types.ObjectId;
let equipId: mongoose.Types.ObjectId;
let loanId: mongoose.Types.ObjectId;
let retainedId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Register models
  const acctSchema = createAccountSchema(config);
  if (mongoose.models.RptAccount) delete mongoose.models.RptAccount;
  AccountModel = mongoose.model('RptAccount', acctSchema);

  const jeSchema = createJournalEntrySchema(config, 'RptAccount');
  if (mongoose.models.RptJE) delete mongoose.models.RptJE;
  JEModel = mongoose.model('RptJE', jeSchema);

  await AccountModel.createIndexes();
  await JEModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Clear all data
  await AccountModel.deleteMany({});
  await JEModel.deleteMany({});

  // Seed accounts
  const cash = await AccountModel.create({ accountTypeCode: '1000' });
  const ar = await AccountModel.create({ accountTypeCode: '1200' });
  const ap = await AccountModel.create({ accountTypeCode: '2000' });
  const eq = await AccountModel.create({ accountTypeCode: '3000' });
  const rev = await AccountModel.create({ accountTypeCode: '4000' });
  const cogs = await AccountModel.create({ accountTypeCode: '5000' });
  const rent = await AccountModel.create({ accountTypeCode: '6000' });
  const equip = await AccountModel.create({ accountTypeCode: '1500' });
  const loan = await AccountModel.create({ accountTypeCode: '2500' });
  const retained = await AccountModel.create({ accountTypeCode: '3660' });

  cashId = cash._id;
  arId = ar._id;
  apId = ap._id;
  equityId = eq._id;
  revenueId = rev._id;
  cogsId = cogs._id;
  rentId = rent._id;
  equipId = equip._id;
  loanId = loan._id;
  retainedId = retained._id;
});

/** Helper: create a posted journal entry */
async function postEntry(
  date: string,
  items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>,
) {
  return JEModel.create({
    journalType: 'GENERAL',
    state: 'posted',
    date: new Date(date),
    journalItems: items,
    totalDebit: items.reduce((s, i) => s + i.debit, 0),
    totalCredit: items.reduce((s, i) => s + i.credit, 0),
  });
}

// ── Trial Balance ────────────────────────────────────────────────────────────

describe('Trial Balance', () => {
  it('returns correct initial, current, and ending balances', async () => {
    // Prior period entry (before March)
    await postEntry('2025-01-15', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: equityId, debit: 0, credit: 100000 },
    ]);

    // Current period entry (March)
    await postEntry('2025-03-10', [
      { account: cashId, debit: 50000, credit: 0 },
      { account: revenueId, debit: 0, credit: 50000 },
    ]);

    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.period.startDate.getMonth()).toBe(2); // March

    // Cash should have initial 100000 debit, current 50000 debit
    const cashRow = report.rows.find((r) => String((r.account as any)._id) === String(cashId));
    expect(cashRow).toBeDefined();
    expect(cashRow?.initial.debit).toBe(100000);
    expect(cashRow?.current.debit).toBe(50000);
    expect(cashRow?.ending.debit).toBe(150000);
  });

  it('returns empty rows when no posted entries exist', async () => {
    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.rows).toHaveLength(0);
  });
});

// ── Balance Sheet ────────────────────────────────────────────────────────────

describe('Balance Sheet', () => {
  it('produces a balanced report (assets = liabilities + equity)', async () => {
    // Equity investment
    await postEntry('2025-01-01', [
      { account: cashId, debit: 500000, credit: 0 },
      { account: equityId, debit: 0, credit: 500000 },
    ]);

    // Purchase on credit
    await postEntry('2025-02-01', [
      { account: arId, debit: 100000, credit: 0 },
      { account: revenueId, debit: 0, credit: 100000 },
    ]);

    // Expense
    await postEntry('2025-02-15', [
      { account: rentId, debit: 20000, credit: 0 },
      { account: cashId, debit: 0, credit: 20000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.summary.isBalanced).toBe(true);
    expect(report.summary.totalAssets).toBe(580000); // 480000 cash + 100000 AR
    expect(report.summary.difference).toBe(0);
  });

  it('includes net income in equity', async () => {
    await postEntry('2025-01-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: equityId, debit: 0, credit: 100000 },
    ]);

    await postEntry('2025-02-01', [
      { account: cashId, debit: 50000, credit: 0 },
      { account: revenueId, debit: 0, credit: 50000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    // Net income (50000 revenue) should be in equity
    expect(report.equity.total).toBe(150000); // 100000 share capital + 50000 net income
    expect(report.summary.isBalanced).toBe(true);
  });
});

// ── Income Statement ─────────────────────────────────────────────────────────

describe('Income Statement', () => {
  it('calculates revenue, expenses, and net income correctly', async () => {
    // Revenue
    await postEntry('2025-03-05', [
      { account: cashId, debit: 200000, credit: 0 },
      { account: revenueId, debit: 0, credit: 200000 },
    ]);

    // COGS
    await postEntry('2025-03-10', [
      { account: cogsId, debit: 80000, credit: 0 },
      { account: cashId, debit: 0, credit: 80000 },
    ]);

    // Rent
    await postEntry('2025-03-15', [
      { account: rentId, debit: 30000, credit: 0 },
      { account: cashId, debit: 0, credit: 30000 },
    ]);

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.revenue.total).toBe(200000);
    expect(report.costOfSales).toBe(80000);
    expect(report.grossProfit).toBe(120000);
    expect(report.expenses.total).toBe(110000); // 80000 COGS + 30000 rent
    expect(report.netIncome).toBe(90000); // 200000 - 110000
  });

  it('returns zero net income when no entries exist in period', async () => {
    // Entry outside the reporting period
    await postEntry('2025-01-05', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: revenueId, debit: 0, credit: 100000 },
    ]);

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.revenue.total).toBe(0);
    expect(report.netIncome).toBe(0);
  });
});

// ── General Ledger ───────────────────────────────────────────────────────────

describe('General Ledger', () => {
  it('shows entries with running balance for an account', async () => {
    // Prior period
    await postEntry('2025-01-10', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: equityId, debit: 0, credit: 100000 },
    ]);

    // Current period entries
    await postEntry('2025-03-05', [
      { account: cashId, debit: 50000, credit: 0 },
      { account: revenueId, debit: 0, credit: 50000 },
    ]);

    await postEntry('2025-03-20', [
      { account: rentId, debit: 20000, credit: 0 },
      { account: cashId, debit: 0, credit: 20000 },
    ]);

    const report = await generateGeneralLedger(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03', accountId: String(cashId) },
    );

    expect(report.accounts).toHaveLength(1);

    const cashLedger = report.accounts[0];
    expect(cashLedger.openingBalance).toBe(100000); // prior period debit
    expect(cashLedger.entries).toHaveLength(2);

    // First entry: +50000 debit
    expect(cashLedger.entries[0].debit).toBe(50000);
    expect(cashLedger.entries[0].runningBalance).toBe(150000);

    // Second entry: -20000 credit
    expect(cashLedger.entries[1].credit).toBe(20000);
    expect(cashLedger.entries[1].runningBalance).toBe(130000);

    expect(cashLedger.closingBalance).toBe(130000);
  });

  it('returns all accounts when no accountId filter', async () => {
    await postEntry('2025-03-05', [
      { account: cashId, debit: 10000, credit: 0 },
      { account: revenueId, debit: 0, credit: 10000 },
    ]);

    const report = await generateGeneralLedger(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    // Should include all posting accounts (7 total, no groups/totals)
    expect(report.accounts.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Cash Flow Statement ─────────────────────────────────────────────────────

describe('Cash Flow Statement', () => {
  it('categorizes cash flows into Operating, Investing, Financing', async () => {
    // Operating: cash received from customer
    await postEntry('2025-03-01', [
      { account: cashId, debit: 200000, credit: 0 },
      { account: arId, debit: 0, credit: 200000 },
    ]);

    // Investing: buy equipment
    await postEntry('2025-03-05', [
      { account: equipId, debit: 80000, credit: 0 },
      { account: cashId, debit: 0, credit: 80000 },
    ]);

    // Financing: take a loan
    await postEntry('2025-03-10', [
      { account: cashId, debit: 300000, credit: 0 },
      { account: loanId, debit: 0, credit: 300000 },
    ]);

    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    // Operating: Cash +2000 debit, AR -2000 credit → net movement from operating accounts
    expect(report.operating.accounts.length).toBeGreaterThan(0);

    // Investing: Equipment +800 debit
    expect(report.investing.total).not.toBe(0);
    expect(report.investing.accounts.length).toBe(1);

    // Financing: Loan +3000 credit
    expect(report.financing.total).not.toBe(0);
    expect(report.financing.accounts.length).toBe(1);

    // Net cash flow should sum all three
    expect(report.netCashFlow).toBe(
      report.operating.total + report.investing.total + report.financing.total,
    );
  });

  it('returns zero flows when no entries in period', async () => {
    await postEntry('2025-01-05', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: equityId, debit: 0, credit: 100000 },
    ]);

    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.operating.total).toBe(0);
    expect(report.investing.total).toBe(0);
    expect(report.financing.total).toBe(0);
    expect(report.netCashFlow).toBe(0);
  });

  it('includes metadata with period info', async () => {
    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03', businessName: 'Test Corp' },
    );

    expect(report.metadata.businessName).toBe('Test Corp');
    expect(report.metadata.periodStart).toBeDefined();
    expect(report.metadata.periodEnd).toBeDefined();
  });
});

// ── Multi-Tenant Report Isolation ───────────────────────────────────────────

describe('Multi-Tenant Report Isolation', () => {
  let MtAccountModel: mongoose.Model<any>;
  let MtJEModel: mongoose.Model<any>;
  let org1: mongoose.Types.ObjectId;
  let org2: mongoose.Types.ObjectId;

  let org1Cash: mongoose.Types.ObjectId;
  let org1Revenue: mongoose.Types.ObjectId;
  let org1Rent: mongoose.Types.ObjectId;
  let org1Equity: mongoose.Types.ObjectId;

  let org2Cash: mongoose.Types.ObjectId;
  let org2Revenue: mongoose.Types.ObjectId;
  let org2Equity: mongoose.Types.ObjectId;

  const mtConfig: AccountingEngineConfig = {
    country: testPack,
    currency: 'TST',
    multiTenant: { orgField: 'business', orgRef: 'Business' },
  };

  beforeAll(async () => {
    if (mongoose.models.MtAccount) delete mongoose.models.MtAccount;
    if (mongoose.models.MtJE) delete mongoose.models.MtJE;

    const mtAcctSchema = createAccountSchema(mtConfig);
    MtAccountModel = mongoose.model('MtAccount', mtAcctSchema);

    const mtJESchema = createJournalEntrySchema(mtConfig, 'MtAccount');
    MtJEModel = mongoose.model('MtJE', mtJESchema);

    await MtAccountModel.createIndexes();
    await MtJEModel.createIndexes();
  });

  beforeEach(async () => {
    await MtAccountModel.deleteMany({});
    await MtJEModel.deleteMany({});

    org1 = new mongoose.Types.ObjectId();
    org2 = new mongoose.Types.ObjectId();

    // Seed accounts for org1
    const o1cash = await MtAccountModel.create({ accountTypeCode: '1000', business: org1 });
    const o1rev = await MtAccountModel.create({ accountTypeCode: '4000', business: org1 });
    const o1rent = await MtAccountModel.create({ accountTypeCode: '6000', business: org1 });
    const o1eq = await MtAccountModel.create({ accountTypeCode: '3000', business: org1 });

    org1Cash = o1cash._id;
    org1Revenue = o1rev._id;
    org1Rent = o1rent._id;
    org1Equity = o1eq._id;

    // Seed accounts for org2
    const o2cash = await MtAccountModel.create({ accountTypeCode: '1000', business: org2 });
    const o2rev = await MtAccountModel.create({ accountTypeCode: '4000', business: org2 });
    const o2eq = await MtAccountModel.create({ accountTypeCode: '3000', business: org2 });

    org2Cash = o2cash._id;
    org2Revenue = o2rev._id;
    org2Equity = o2eq._id;

    // Post entries for org1: 100000 equity investment + 50000 revenue + 20000 expense
    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-01-01'),
      business: org1,
      journalItems: [
        { account: org1Cash, debit: 100000, credit: 0 },
        { account: org1Equity, debit: 0, credit: 100000 },
      ],
      totalDebit: 100000,
      totalCredit: 100000,
    });
    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-05'),
      business: org1,
      journalItems: [
        { account: org1Cash, debit: 50000, credit: 0 },
        { account: org1Revenue, debit: 0, credit: 50000 },
      ],
      totalDebit: 50000,
      totalCredit: 50000,
    });
    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-10'),
      business: org1,
      journalItems: [
        { account: org1Rent, debit: 20000, credit: 0 },
        { account: org1Cash, debit: 0, credit: 20000 },
      ],
      totalDebit: 20000,
      totalCredit: 20000,
    });

    // Post entries for org2: 300000 equity + 80000 revenue
    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-01-01'),
      business: org2,
      journalItems: [
        { account: org2Cash, debit: 300000, credit: 0 },
        { account: org2Equity, debit: 0, credit: 300000 },
      ],
      totalDebit: 300000,
      totalCredit: 300000,
    });
    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-15'),
      business: org2,
      journalItems: [
        { account: org2Cash, debit: 80000, credit: 0 },
        { account: org2Revenue, debit: 0, credit: 80000 },
      ],
      totalDebit: 80000,
      totalCredit: 80000,
    });
  });

  it('trial balance isolates data by organization', async () => {
    const report1 = await generateTrialBalance(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org1, dateOption: 'month', dateValue: '2025-03' },
    );
    const report2 = await generateTrialBalance(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org2, dateOption: 'month', dateValue: '2025-03' },
    );

    // Org1: Cash initial 100000
    const cash1 = report1.rows.find((r) => String((r.account as any)._id) === String(org1Cash));
    expect(cash1).toBeDefined();
    expect(cash1?.initial.debit).toBe(100000);

    // Org2: Cash initial 300000
    const cash2 = report2.rows.find((r) => String((r.account as any)._id) === String(org2Cash));
    expect(cash2).toBeDefined();
    expect(cash2?.initial.debit).toBe(300000);

    // Org1 should NOT see org2 accounts
    const cross = report1.rows.find((r) => String((r.account as any)._id) === String(org2Cash));
    expect(cross).toBeUndefined();
  });

  it('balance sheet isolates data by organization', async () => {
    const bs1 = await generateBalanceSheet(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org1, dateOption: 'month', dateValue: '2025-03' },
    );
    const bs2 = await generateBalanceSheet(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org2, dateOption: 'month', dateValue: '2025-03' },
    );

    // Org1: assets = 130000 (100000 + 50000 - 20000)
    expect(bs1.summary.totalAssets).toBe(130000);
    expect(bs1.summary.isBalanced).toBe(true);

    // Org2: assets = 380000 (300000 + 80000)
    expect(bs2.summary.totalAssets).toBe(380000);
    expect(bs2.summary.isBalanced).toBe(true);

    expect(bs1.summary.totalAssets).not.toBe(bs2.summary.totalAssets);
  });

  it('income statement isolates data by organization', async () => {
    const is1 = await generateIncomeStatement(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org1, dateOption: 'month', dateValue: '2025-03' },
    );
    const is2 = await generateIncomeStatement(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org2, dateOption: 'month', dateValue: '2025-03' },
    );

    // Org1: revenue 50000, rent 20000, net income 30000
    expect(is1.revenue.total).toBe(50000);
    expect(is1.netIncome).toBe(30000);

    // Org2: revenue 80000, no expenses, net income 80000
    expect(is2.revenue.total).toBe(80000);
    expect(is2.netIncome).toBe(80000);
  });

  it('general ledger isolates data by organization', async () => {
    const gl1 = await generateGeneralLedger(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      {
        organizationId: org1,
        dateOption: 'month',
        dateValue: '2025-03',
        accountId: String(org1Cash),
      },
    );
    const gl2 = await generateGeneralLedger(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      {
        organizationId: org2,
        dateOption: 'month',
        dateValue: '2025-03',
        accountId: String(org2Cash),
      },
    );

    // Org1 cash: opening 100000, 2 entries, closing 130000
    expect(gl1.accounts).toHaveLength(1);
    expect(gl1.accounts[0].openingBalance).toBe(100000);
    expect(gl1.accounts[0].entries).toHaveLength(2);
    expect(gl1.accounts[0].closingBalance).toBe(130000);

    // Org2 cash: opening 300000, 1 entry, closing 380000
    expect(gl2.accounts).toHaveLength(1);
    expect(gl2.accounts[0].openingBalance).toBe(300000);
    expect(gl2.accounts[0].entries).toHaveLength(1);
    expect(gl2.accounts[0].closingBalance).toBe(380000);
  });

  it('cash flow isolates data by organization', async () => {
    const cf1 = await generateCashFlow(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org1, dateOption: 'month', dateValue: '2025-03' },
    );
    const cf2 = await generateCashFlow(
      {
        AccountModel: MtAccountModel,
        JournalEntryModel: MtJEModel,
        country: testPack,
        orgField: 'business',
      },
      { organizationId: org2, dateOption: 'month', dateValue: '2025-03' },
    );

    // Different orgs should have different net cash flows
    expect(cf1.netCashFlow).not.toBe(cf2.netCashFlow);
  });
});

// ── Fiscal Year Closing ─────────────────────────────────────────────────────

describe('Fiscal Year Closing', () => {
  let FPModel: mongoose.Model<any>;

  beforeAll(async () => {
    if (mongoose.models.RptFP) delete mongoose.models.RptFP;
    const fpSchema = createFiscalPeriodSchema(config);
    FPModel = mongoose.model('RptFP', fpSchema);
    await FPModel.createIndexes();
  });

  beforeEach(async () => {
    await FPModel.deleteMany({});
  });

  it('closes a period with revenue and expenses', async () => {
    // Create a fiscal period
    const period = await FPModel.create({
      name: 'FY2025 Q1',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    // Revenue: 200000 cents
    await postEntry('2025-02-01', [
      { account: cashId, debit: 200000, credit: 0 },
      { account: revenueId, debit: 0, credit: 200000 },
    ]);

    // Expense: 80000 cents
    await postEntry('2025-03-01', [
      { account: rentId, debit: 80000, credit: 0 },
      { account: cashId, debit: 0, credit: 80000 },
    ]);

    const result = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id },
    );

    // Net income = 200000 revenue - 80000 expense = 120000
    expect(result.netIncome).toBe(120000);
    expect(result.accountsClosed).toBe(2); // revenue + rent
    expect(result.closingEntryId).not.toBeNull();
    expect(result.closedAt).toBeInstanceOf(Date);

    // Verify period is marked closed
    const updatedPeriod = (await FPModel.findById(period._id).lean()) as Record<string, unknown>;
    expect(updatedPeriod.closed).toBe(true);

    // Verify closing journal entry was created
    const closingEntry = (await JEModel.findById(result.closingEntryId).lean()) as Record<
      string,
      unknown
    >;
    expect(closingEntry.journalType).toBe('YEAR_END');
    expect(closingEntry.state).toBe('posted');

    // The closing entry should balance
    expect(closingEntry.totalDebit).toBe(closingEntry.totalCredit);

    // Retained earnings should receive the net income
    const items = closingEntry.journalItems as Array<Record<string, unknown>>;
    const reLine = items.find((i) => String(i.account) === String(retainedId));
    expect(reLine).toBeDefined();
    expect(reLine?.credit).toBe(120000);
  });

  it('throws when period is already closed', async () => {
    const period = await FPModel.create({
      name: 'FY2025 Q2',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2025-06-30'),
      closed: true,
    });

    await expect(
      closeFiscalPeriod(
        { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
        { periodId: period._id },
      ),
    ).rejects.toThrow('already closed');
  });

  it('throws when retained earnings account is missing', async () => {
    const period = await FPModel.create({
      name: 'FY2025 Q3',
      startDate: new Date('2025-07-01'),
      endDate: new Date('2025-09-30'),
    });

    await expect(
      closeFiscalPeriod(
        {
          AccountModel,
          JournalEntryModel: JEModel,
          FiscalPeriodModel: FPModel,
          country: testPack,
          retainedEarningsAccountCode: '9999',
        },
        { periodId: period._id },
      ),
    ).rejects.toThrow('Retained earnings account');
  });

  it('handles period with no income/expense activity', async () => {
    const period = await FPModel.create({
      name: 'FY2024 Q4',
      startDate: new Date('2024-10-01'),
      endDate: new Date('2024-12-31'),
    });

    const result = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id },
    );

    expect(result.netIncome).toBe(0);
    expect(result.closingEntryId).toBeNull(); // No entry needed
    expect(result.accountsClosed).toBe(0);

    // Period still gets marked closed
    const updatedPeriod = (await FPModel.findById(period._id).lean()) as Record<string, unknown>;
    expect(updatedPeriod.closed).toBe(true);
  });

  it('stores closingEntryId on the period document', async () => {
    const period = await FPModel.create({
      name: 'FY2025 Store ID',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    await postEntry('2025-02-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: revenueId, debit: 0, credit: 100000 },
    ]);

    const result = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id },
    );

    const updatedPeriod = (await FPModel.findById(period._id).lean()) as Record<string, unknown>;
    expect(String(updatedPeriod.closingEntryId)).toBe(String(result.closingEntryId));
  });
});

// ── Fiscal Period Reopen ──────────────────────────────────────────────────────

describe('Fiscal Period Reopen', () => {
  let FPModel: mongoose.Model<any>;

  beforeAll(async () => {
    FPModel = mongoose.models.RptFP!;
  });

  beforeEach(async () => {
    await FPModel.deleteMany({});
  });

  it('reopens a closed period and deletes the closing entry', async () => {
    const period = await FPModel.create({
      name: 'Reopen Test',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    // Revenue + expense
    await postEntry('2025-02-01', [
      { account: cashId, debit: 200000, credit: 0 },
      { account: revenueId, debit: 0, credit: 200000 },
    ]);
    await postEntry('2025-03-01', [
      { account: rentId, debit: 50000, credit: 0 },
      { account: cashId, debit: 0, credit: 50000 },
    ]);

    // Close it
    const closeResult = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id, closedBy: 'admin@test.com' },
    );

    expect(closeResult.closingEntryId).not.toBeNull();

    // Reopen it
    const reopenResult = await reopenFiscalPeriod(
      { JournalEntryModel: JEModel, FiscalPeriodModel: FPModel },
      { periodId: period._id, reopenedBy: 'admin@test.com' },
    );

    expect(reopenResult.deletedEntryId).not.toBeNull();
    expect(String(reopenResult.deletedEntryId)).toBe(String(closeResult.closingEntryId));
    expect(reopenResult.reopenedAt).toBeInstanceOf(Date);

    // Period is now open
    const updatedPeriod = (await FPModel.findById(period._id).lean()) as Record<string, unknown>;
    expect(updatedPeriod.closed).toBe(false);
    expect(updatedPeriod.closedAt).toBeNull();
    expect(updatedPeriod.closingEntryId).toBeNull();
    expect(updatedPeriod.reopenedBy).toBe('admin@test.com');
    expect(updatedPeriod.reopenedAt).toBeInstanceOf(Date);

    // Closing entry is deleted from the journal
    const deletedEntry = await JEModel.findById(closeResult.closingEntryId);
    expect(deletedEntry).toBeNull();
  });

  it('throws when period is not closed', async () => {
    const period = await FPModel.create({
      name: 'Not Closed',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2025-06-30'),
      closed: false,
    });

    await expect(
      reopenFiscalPeriod(
        { JournalEntryModel: JEModel, FiscalPeriodModel: FPModel },
        { periodId: period._id },
      ),
    ).rejects.toThrow('is not closed');
  });

  it('blocks reopen when a later period is already closed', async () => {
    // Create two periods
    const earlier = await FPModel.create({
      name: 'Q1',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      closed: true,
      closedAt: new Date(),
    });
    await FPModel.create({
      name: 'Q2',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2025-06-30'),
      closed: true,
      closedAt: new Date(),
    });

    await expect(
      reopenFiscalPeriod(
        { JournalEntryModel: JEModel, FiscalPeriodModel: FPModel },
        { periodId: earlier._id },
      ),
    ).rejects.toThrow('later fiscal period is already closed');
  });

  it('allows reopen of the most recent closed period', async () => {
    // Q1 open, Q2 closed — reopening Q2 should work
    await FPModel.create({
      name: 'Open Q1',
      startDate: new Date('2024-01-01'),
      endDate: new Date('2024-03-31'),
      closed: false,
    });
    const q2 = await FPModel.create({
      name: 'Closed Q2',
      startDate: new Date('2024-04-01'),
      endDate: new Date('2024-06-30'),
      closed: true,
      closedAt: new Date(),
    });

    const result = await reopenFiscalPeriod(
      { JournalEntryModel: JEModel, FiscalPeriodModel: FPModel },
      { periodId: q2._id, reopenedBy: 'owner' },
    );

    expect(result.periodId).toEqual(q2._id);
    const updatedQ2 = (await FPModel.findById(q2._id).lean()) as Record<string, unknown>;
    expect(updatedQ2.closed).toBe(false);
  });

  it('reopens a period that had no closing entry (zero activity)', async () => {
    const period = await FPModel.create({
      name: 'Zero Activity',
      startDate: new Date('2023-01-01'),
      endDate: new Date('2023-03-31'),
    });

    // Close it (no IS activity → no closing entry)
    const closeResult = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id },
    );
    expect(closeResult.closingEntryId).toBeNull();

    // Reopen it
    const reopenResult = await reopenFiscalPeriod(
      { JournalEntryModel: JEModel, FiscalPeriodModel: FPModel },
      { periodId: period._id },
    );

    expect(reopenResult.deletedEntryId).toBeNull();
    const updatedPeriod = (await FPModel.findById(period._id).lean()) as Record<string, unknown>;
    expect(updatedPeriod.closed).toBe(false);
  });

  it('allows re-closing after reopen (full cycle)', async () => {
    const period = await FPModel.create({
      name: 'Full Cycle',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    await postEntry('2025-02-15', [
      { account: cashId, debit: 300000, credit: 0 },
      { account: revenueId, debit: 0, credit: 300000 },
    ]);

    // Close → reopen → close again
    const close1 = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id },
    );
    expect(close1.netIncome).toBe(300000);

    await reopenFiscalPeriod(
      { JournalEntryModel: JEModel, FiscalPeriodModel: FPModel },
      { periodId: period._id },
    );

    // Add more activity after reopen
    await postEntry('2025-03-20', [
      { account: rentId, debit: 40000, credit: 0 },
      { account: cashId, debit: 0, credit: 40000 },
    ]);

    // Close again — should recalculate with new data
    const close2 = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: testPack },
      { periodId: period._id },
    );
    expect(close2.netIncome).toBe(260000); // 300000 revenue - 40000 expense
    expect(close2.closingEntryId).not.toBeNull();
    expect(String(close2.closingEntryId)).not.toBe(String(close1.closingEntryId));
  });
});
