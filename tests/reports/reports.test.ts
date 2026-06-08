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
      cashFlowCategory: null, // Cash accounts are the report TARGET, not a line item
    },
    {
      code: '1200',
      name: 'Accounts Receivable',
      category: 'Balance Sheet-Asset',
      description: 'AR',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'Operating',
    },
    {
      code: '2000',
      name: 'Accounts Payable',
      category: 'Balance Sheet-Liability',
      description: 'AP',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'Operating',
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
      cashFlowCategory: 'Investing',
    },
    {
      code: '2500',
      name: 'Loan Payable',
      category: 'Balance Sheet-Liability',
      description: 'Loan',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'Financing',
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

  // Seed accounts. `isCashAccount: true` flags the cash & cash-equivalents
  // pool — the boundary the CFS reports flow into and out of.
  const cash = await AccountModel.create({ accountTypeCode: '1000', isCashAccount: true });
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

    expect(report.columnarRows.length).toBeGreaterThan(0);
    expect(report.period.startDate.getMonth()).toBe(2); // March

    // Cash should have initial 100000 debit, current 50000 debit
    const cashRow = report.columnarRows.find(
      (r) => String((r.account as any)._id) === String(cashId),
    );
    expect(cashRow).toBeDefined();
    expect(cashRow?.initial.debit.total).toBe(100000);
    expect(cashRow?.current.debit.total).toBe(50000);
    expect(cashRow?.ending.debit.total).toBe(150000);
  });

  it('returns empty rows when no posted entries exist', async () => {
    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.columnarRows).toHaveLength(0);
  });

  it('rolls prior fiscal-year P&L into retained earnings so opening + ending columns balance', async () => {
    // Prior fiscal year (2024) PROFIT: revenue 30000. P&L resets at the
    // fiscal-year start (Jan 1), so without the roll-forward this 2024 credit
    // would be missing from the 2025 opening column → imbalance.
    await postEntry('2024-06-01', [
      { account: cashId, debit: 30000, credit: 0 },
      { account: revenueId, debit: 0, credit: 30000 },
    ]);
    // Current fiscal year (2025) activity.
    await postEntry('2025-03-10', [
      { account: cashId, debit: 50000, credit: 0 },
      { account: revenueId, debit: 0, credit: 50000 },
    ]);

    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const sum = (sel: (r: (typeof report.columnarRows)[number]) => number) =>
      report.columnarRows.reduce((s, r) => s + sel(r), 0);

    // Opening column ties out — prior-year profit closed into retained earnings.
    expect(sum((r) => r.initial.debit.total ?? 0)).toBe(sum((r) => r.initial.credit.total ?? 0));
    // Ending column ties out too.
    expect(sum((r) => r.ending.debit.total ?? 0)).toBe(sum((r) => r.ending.credit.total ?? 0));

    // The 2024 profit (30000) landed in retained earnings' OPENING credit.
    const reRow = report.columnarRows.find(
      (r) => String((r.account as { _id?: unknown })._id) === String(retainedId),
    );
    expect(reRow?.initial.credit.total).toBe(30000);
    // Current-year revenue stays in the P&L account (not rolled into RE).
    const revRow = report.columnarRows.find(
      (r) => String((r.account as { _id?: unknown })._id) === String(revenueId),
    );
    expect(revRow?.current.credit.total).toBe(50000);
  });

  it('does NOT inject retained earnings on a single-account drill (params.accountId)', async () => {
    await postEntry('2024-06-01', [
      { account: cashId, debit: 30000, credit: 0 },
      { account: revenueId, debit: 0, credit: 30000 },
    ]);
    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03', accountId: String(cashId) },
    );
    // Drilling a single (non-RE) account must not fabricate an RE row.
    const reRow = report.columnarRows.find(
      (r) => String((r.account as { _id?: unknown })._id) === String(retainedId),
    );
    expect(reRow).toBeUndefined();
  });

  it('rolls a prior fiscal-year LOSS into retained earnings as an opening DEBIT', async () => {
    // Prior fiscal year (2024) LOSS: rent expense 8000 funded by cash. A
    // debit-heavy prior P&L (priorNet > 0) must DEBIT retained earnings.
    await postEntry('2024-09-01', [
      { account: rentId, debit: 8000, credit: 0 },
      { account: cashId, debit: 0, credit: 8000 },
    ]);
    // A current-year entry so the report has live activity too.
    await postEntry('2025-02-15', [
      { account: cashId, debit: 1000, credit: 0 },
      { account: revenueId, debit: 0, credit: 1000 },
    ]);

    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );
    const sum = (sel: (r: (typeof report.columnarRows)[number]) => number) =>
      report.columnarRows.reduce((s, r) => s + sel(r), 0);

    // Both columns still tie out.
    expect(sum((r) => r.initial.debit.total ?? 0)).toBe(sum((r) => r.initial.credit.total ?? 0));
    expect(sum((r) => r.ending.debit.total ?? 0)).toBe(sum((r) => r.ending.credit.total ?? 0));

    // The 2024 loss (8000) landed in retained earnings' OPENING debit.
    const reRow = report.columnarRows.find(
      (r) => String((r.account as { _id?: unknown })._id) === String(retainedId),
    );
    expect(reRow?.initial.debit.total).toBe(8000);
    expect(reRow?.initial.credit.total).toBe(0);
  });

  it('accumulates MULTIPLE prior fiscal years (profit + loss) into one RE opening figure', async () => {
    // 2023 profit 20000, 2024 loss 5000 → net prior P&L = +15000 profit →
    // RE opening CREDIT 15000. Proves priorIs sums ALL pre-FY years, not just
    // the immediately prior one.
    await postEntry('2023-05-01', [
      { account: cashId, debit: 20000, credit: 0 },
      { account: revenueId, debit: 0, credit: 20000 },
    ]);
    await postEntry('2024-07-01', [
      { account: rentId, debit: 5000, credit: 0 },
      { account: cashId, debit: 0, credit: 5000 },
    ]);

    const report = await generateTrialBalance(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );
    const sum = (sel: (r: (typeof report.columnarRows)[number]) => number) =>
      report.columnarRows.reduce((s, r) => s + sel(r), 0);

    expect(sum((r) => r.initial.debit.total ?? 0)).toBe(sum((r) => r.initial.credit.total ?? 0));
    const reRow = report.columnarRows.find(
      (r) => String((r.account as { _id?: unknown })._id) === String(retainedId),
    );
    expect(reRow?.initial.credit.total).toBe(15000);
    expect(reRow?.initial.debit.total).toBe(0);
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

    expect(report.summaryByPeriod.isBalanced.total).toBe(true);
    expect(report.summaryByPeriod.totalAssets.total).toBe(580000); // 480000 cash + 100000 AR
    expect(report.summaryByPeriod.difference.total).toBe(0);
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
    expect(report.equitySection.totals.total).toBe(150000); // 100000 share capital + 50000 net income
    expect(report.summaryByPeriod.isBalanced.total).toBe(true);
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

    expect(report.revenueSection.totals.total).toBe(200000);
    expect(report.costOfSalesByPeriod.total).toBe(80000);
    expect(report.grossProfitByPeriod.total).toBe(120000);
    expect(report.expensesSection.totals.total).toBe(110000); // 80000 COGS + 30000 rent
    expect(report.netIncomeByPeriod.total).toBe(90000); // 200000 - 110000
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

    expect(report.revenueSection.totals.total).toBe(0);
    expect(report.netIncomeByPeriod.total).toBe(0);
  });

  it('comparative monthly uses the shared period envelope and clamps custom dates', async () => {
    await postEntry('2025-01-10', [
      { account: cashId, debit: 999999, credit: 0 },
      { account: revenueId, debit: 0, credit: 999999 },
    ]);
    await postEntry('2025-01-20', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: revenueId, debit: 0, credit: 100000 },
    ]);
    await postEntry('2025-02-05', [
      { account: rentId, debit: 20000, credit: 0 },
      { account: cashId, debit: 0, credit: 20000 },
    ]);

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      {
        dateOption: 'custom',
        dateValue: { startDate: '2025-01-15', endDate: '2025-02-10' },
        comparative: 'monthly',
      },
    );

    expect(report.periods.map((p) => p.key)).toEqual(['2025-01', '2025-02', 'total']);
    expect(report.periods[0].startDate).toBe('2025-01-15');
    expect(report.periods[1].endDate).toBe('2025-02-10');
    expect(report.revenueSection.totals['2025-01']).toBe(100000);
    expect(report.revenueSection.totals['2025-02']).toBe(0);
    expect(report.expensesSection.totals['2025-02']).toBe(20000);
    expect(report.netIncomeByPeriod.total).toBe(80000);
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
  it('builds an Indirect-Method statement with Net Income, ΔWC, Investing, Financing', async () => {
    // Operating: cash received from a customer (settles A/R)
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

    // Single-period report → one column keyed 'total'.
    expect(report.periods).toHaveLength(1);
    expect(report.periods[0].key).toBe('total');
    const k = 'total';

    // Operating section: Net Income line (always present) + ΔA/R from
    // settling the receivable. No P&L revenue/expense lines.
    const opSources = report.operating.lines.map((l) => l.source.kind);
    expect(opSources).toContain('netIncome');
    expect(opSources).toContain('workingCapital');
    expect(report.operating.lines.every((l) => l.source.kind !== 'directMovement')).toBe(true);

    // Investing: Equipment direct movement (purchase = use of cash → negative)
    expect(report.investing.totals[k]).toBe(-80000);
    expect(report.investing.lines).toHaveLength(1);
    expect(report.investing.lines[0].source.kind).toBe('directMovement');

    // Financing: Loan drawdown (credit movement = source of cash → positive)
    expect(report.financing.totals[k]).toBe(300000);
    expect(report.financing.lines).toHaveLength(1);
    expect(report.financing.lines[0].source.kind).toBe('directMovement');

    // Net = Operating + Investing + Financing + FX
    expect(report.netCashFlow[k]).toBe(
      report.operating.totals[k] +
        report.investing.totals[k] +
        report.financing.totals[k] +
        report.fxEffect[k],
    );

    // Cash reconciliation should tie to the actual cash account delta:
    // +200k − 80k + 300k = +420k. Within 1 cent tolerance.
    const recon = report.cashReconciliation[k];
    expect(recon.tieOutOk).toBe(true);
    expect(recon.closingCash - recon.openingCash).toBe(420000);
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

    const k = 'total';
    expect(report.operating.totals[k]).toBe(0);
    expect(report.operating.lines.some((l) => l.source.kind === 'netIncome')).toBe(true);
    expect(report.investing.totals[k]).toBe(0);
    expect(report.investing.lines).toHaveLength(0);
    expect(report.financing.totals[k]).toBe(0);
    expect(report.financing.lines).toHaveLength(0);
    expect(report.netCashFlow[k]).toBe(0);
  });

  it('does NOT list Income/Expense accounts as direct line items', async () => {
    await postEntry('2025-03-15', [
      { account: cashId, debit: 50000, credit: 0 },
      { account: revenueId, debit: 0, credit: 50000 },
    ]);

    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const allLines = [
      ...report.operating.lines,
      ...report.investing.lines,
      ...report.financing.lines,
    ];
    expect(allLines.some((l) => l.label.toLowerCase().includes('revenue'))).toBe(false);
    expect(allLines.some((l) => l.label.toLowerCase().includes('sales'))).toBe(false);

    const netIncomeLine = report.operating.lines.find((l) => l.source.kind === 'netIncome');
    expect(netIncomeLine?.amounts.total).toBe(50000);
  });

  it('comparative monthly: 12 columns + YTD total, all tie out', async () => {
    // Q1 activity: simulate distinct months so each column carries its own delta.
    await postEntry('2025-01-10', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: revenueId, debit: 0, credit: 100000 },
    ]);
    await postEntry('2025-02-15', [
      { account: cashId, debit: 200000, credit: 0 },
      { account: revenueId, debit: 0, credit: 200000 },
    ]);
    await postEntry('2025-03-20', [
      { account: equipId, debit: 50000, credit: 0 },
      { account: cashId, debit: 0, credit: 50000 },
    ]);

    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'year', dateValue: 2025, comparative: 'monthly' },
    );

    // 12 monthly columns + final YTD total.
    expect(report.periods).toHaveLength(13);
    expect(report.periods[0].key).toBe('2025-01');
    expect(report.periods[11].key).toBe('2025-12');
    expect(report.periods[12].key).toBe('total');
    expect(report.periods[12].isTotal).toBe(true);

    // Net Income line carries one amount per column.
    const netIncomeLine = report.operating.lines.find((l) => l.source.kind === 'netIncome');
    expect(netIncomeLine).toBeDefined();
    expect(netIncomeLine?.amounts['2025-01']).toBe(100000);
    expect(netIncomeLine?.amounts['2025-02']).toBe(200000);
    expect(netIncomeLine?.amounts['2025-03']).toBe(0);
    expect(netIncomeLine?.amounts.total).toBe(300000);

    // Per-column investing: Q1 buy, Q2-Q4 nothing.
    expect(report.investing.totals['2025-01']).toBe(0);
    expect(report.investing.totals['2025-03']).toBe(-50000);
    expect(report.investing.totals['2025-04']).toBe(0);
    expect(report.investing.totals.total).toBe(-50000);

    // Cash reconciliation per column ties out everywhere.
    for (const col of report.periods) {
      expect(report.cashReconciliation[col.key].tieOutOk).toBe(true);
    }

    // YTD total of net cash flow = sum of all 12 monthly columns.
    const monthlySum = report.periods
      .filter((p) => !p.isTotal)
      .reduce((s, p) => s + report.netCashFlow[p.key], 0);
    expect(report.netCashFlow.total).toBe(monthlySum);
  });

  it('comparative quarterly: 4 columns + YTD total', async () => {
    await postEntry('2025-02-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: loanId, debit: 0, credit: 100000 },
    ]);

    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'year', dateValue: 2025, comparative: 'quarterly' },
    );

    expect(report.periods).toHaveLength(5);
    expect(report.periods.map((p) => p.key)).toEqual([
      '2025-Q1',
      '2025-Q2',
      '2025-Q3',
      '2025-Q4',
      'total',
    ]);

    expect(report.financing.totals['2025-Q1']).toBe(100000);
    expect(report.financing.totals['2025-Q2']).toBe(0);
    expect(report.financing.totals.total).toBe(100000);
  });

  it('includes metadata with period info', async () => {
    const report = await generateCashFlow(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      { dateOption: 'month', dateValue: '2025-03', businessName: 'Test Corp' },
    );

    expect(report.metadata.businessName).toBe('Test Corp');
    expect(report.metadata.periodStart).toBeDefined();
    expect(report.metadata.periodEnd).toBeDefined();
    expect(report.metadata.comparative).toBeNull();
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
    multiTenant: { tenantField: 'business', ref: 'Business' },
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
    const cash1 = report1.columnarRows.find(
      (r) => String((r.account as any)._id) === String(org1Cash),
    );
    expect(cash1).toBeDefined();
    expect(cash1?.initial.debit.total).toBe(100000);

    // Org2: Cash initial 300000
    const cash2 = report2.columnarRows.find(
      (r) => String((r.account as any)._id) === String(org2Cash),
    );
    expect(cash2).toBeDefined();
    expect(cash2?.initial.debit.total).toBe(300000);

    // Org1 should NOT see org2 accounts
    const cross = report1.columnarRows.find(
      (r) => String((r.account as any)._id) === String(org2Cash),
    );
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
    expect(bs1.summaryByPeriod.totalAssets.total).toBe(130000);
    expect(bs1.summaryByPeriod.isBalanced.total).toBe(true);

    // Org2: assets = 380000 (300000 + 80000)
    expect(bs2.summaryByPeriod.totalAssets.total).toBe(380000);
    expect(bs2.summaryByPeriod.isBalanced.total).toBe(true);

    expect(bs1.summaryByPeriod.totalAssets.total).not.toBe(bs2.summaryByPeriod.totalAssets.total);
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
    expect(is1.revenueSection.totals.total).toBe(50000);
    expect(is1.netIncomeByPeriod.total).toBe(30000);

    // Org2: revenue 80000, no expenses, net income 80000
    expect(is2.revenueSection.totals.total).toBe(80000);
    expect(is2.netIncomeByPeriod.total).toBe(80000);
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
