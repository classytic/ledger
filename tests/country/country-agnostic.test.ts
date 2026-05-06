/**
 * Country-Agnostic Tests
 *
 * Validates that the ledger engine works with ANY country pack,
 * not just Canada. Uses a mock US-like pack with different codes,
 * group names, and no dot-notation tax accounts.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { generateBalanceSheet } from '../../src/reports/balance-sheet.js';
import { closeFiscalPeriod } from '../../src/reports/fiscal-close.js';
import { generateIncomeStatement } from '../../src/reports/income-statement.js';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createFiscalPeriodSchema } from '../../src/schemas/fiscal-period.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import type { AccountType } from '../../src/types/core.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { buildAccountTypeMap, isVirtualTaxAccount } from '../../src/utils/account-helpers.js';
import { legacyBalanceSheet, legacyIncomeStatement } from '../helpers/legacy-report-view.js';

// ── Mock US Country Pack ────────────────────────────────────────────────────

const mockUsPack = defineCountryPack({
  code: 'US',
  name: 'United States',
  defaultCurrency: 'USD',
  retainedEarningsAccountCode: '3200',
  currentYearEarningsCode: '3210',
  cogsGroupCode: 'Cost of Goods Sold',
  reportLabels: {
    revenue: 'Net Revenue',
  },
  accountTypes: [
    // Group labels
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
      code: 'Fixed Assets',
      name: 'Fixed Assets',
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
      code: 'Stockholders Equity',
      name: "Stockholders' Equity",
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

    // Tax aggregate (NO dot notation — US style)
    {
      code: '2100',
      name: 'Sales Tax Payable',
      category: 'Balance Sheet-Liability',
      description: '',
      parentCode: 'Current Liabilities',
      isTotal: true,
      isVirtualTotal: true,
      cashFlowCategory: null,
      totalAccountTypes: [
        { account: '2101', operation: '+' },
        { account: '2102', operation: '+' },
      ],
    },
    {
      code: '2101',
      name: 'State Sales Tax',
      category: 'Balance Sheet-Liability',
      description: '',
      parentCode: '2100',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '2102',
      name: 'City Sales Tax',
      category: 'Balance Sheet-Liability',
      description: '',
      parentCode: '2100',
      isTotal: false,
      cashFlowCategory: null,
    },

    // Posting accounts
    {
      code: '1000',
      name: 'Cash and Cash Equivalents',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Current Assets',
      isTotal: false,
      cashFlowCategory: 'Operating',
    },
    {
      code: '1200',
      name: 'Accounts Receivable',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Current Assets',
      isTotal: false,
      cashFlowCategory: 'Operating',
    },
    {
      code: '1500',
      name: 'Property, Plant & Equipment',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Fixed Assets',
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
      code: '3000',
      name: 'Common Stock',
      category: 'Balance Sheet-Equity',
      description: '',
      parentCode: 'Stockholders Equity',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '3200',
      name: 'Retained Earnings',
      category: 'Balance Sheet-Equity',
      description: '',
      parentCode: 'Stockholders Equity',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '3210',
      name: 'Current Year Earnings',
      category: 'Balance Sheet-Equity',
      description: '',
      parentCode: 'Stockholders Equity',
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
      name: 'Cost of Materials',
      category: 'Income Statement-Expense',
      description: '',
      parentCode: 'Cost of Goods Sold',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '5100',
      name: 'Direct Labor',
      category: 'Income Statement-Expense',
      description: '',
      parentCode: 'Cost of Goods Sold',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '6000',
      name: 'Rent Expense',
      category: 'Income Statement-Expense',
      description: '',
      parentCode: 'Operating Expenses',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '6100',
      name: 'Payroll Expense',
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
  ],
  taxCodes: {},
  taxCodesByRegion: {},
  regions: ['California', 'New York', 'Texas'],
});

const usConfig: AccountingEngineConfig = { country: mockUsPack, currency: 'USD' };

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;
let FPModel: mongoose.Model<any>;

let cashId: mongoose.Types.ObjectId;
let arId: mongoose.Types.ObjectId;
let ppeId: mongoose.Types.ObjectId;
let apId: mongoose.Types.ObjectId;
let stateTaxId: mongoose.Types.ObjectId;
let cityTaxId: mongoose.Types.ObjectId;
let stockId: mongoose.Types.ObjectId;
let retainedId: mongoose.Types.ObjectId;
let salesId: mongoose.Types.ObjectId;
let serviceId: mongoose.Types.ObjectId;
let materialsId: mongoose.Types.ObjectId;
let laborId: mongoose.Types.ObjectId;
let rentId: mongoose.Types.ObjectId;
let payrollId: mongoose.Types.ObjectId;
let utilitiesId: mongoose.Types.ObjectId;

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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  if (mongoose.models.UsAccount) delete mongoose.models.UsAccount;
  AccountModel = mongoose.model('UsAccount', createAccountSchema(usConfig));

  if (mongoose.models.UsJE) delete mongoose.models.UsJE;
  JEModel = mongoose.model('UsJE', createJournalEntrySchema(usConfig, 'UsAccount'));

  if (mongoose.models.UsFP) delete mongoose.models.UsFP;
  FPModel = mongoose.model('UsFP', createFiscalPeriodSchema(usConfig));

  await AccountModel.createIndexes();
  await JEModel.createIndexes();
  await FPModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await JEModel.deleteMany({});
  await FPModel.deleteMany({});

  const seed = async (code: string) => (await AccountModel.create({ accountTypeCode: code }))._id;

  cashId = await seed('1000');
  arId = await seed('1200');
  ppeId = await seed('1500');
  apId = await seed('2000');
  stateTaxId = await seed('2101');
  cityTaxId = await seed('2102');
  stockId = await seed('3000');
  retainedId = await seed('3200');
  salesId = await seed('4000');
  serviceId = await seed('4100');
  materialsId = await seed('5000');
  laborId = await seed('5100');
  rentId = await seed('6000');
  payrollId = await seed('6100');
  utilitiesId = await seed('6200');
});

// ═══════════════════════════════════════════════════════════════════════════════
// COUNTRY PACK BASICS
// ═══════════════════════════════════════════════════════════════════════════════

describe('US Country Pack — Basics', () => {
  it('has correct metadata', () => {
    expect(mockUsPack.code).toBe('US');
    expect(mockUsPack.defaultCurrency).toBe('USD');
    expect(mockUsPack.retainedEarningsAccountCode).toBe('3200');
    expect(mockUsPack.currentYearEarningsCode).toBe('3210');
    expect(mockUsPack.cogsGroupCode).toBe('Cost of Goods Sold');
  });

  it('report labels are customizable', () => {
    expect(mockUsPack.reportLabels?.revenue).toBe('Net Revenue');
    expect(mockUsPack.reportLabels?.assets).toBeUndefined(); // uses default
  });

  it('group labels are not postable', () => {
    expect(mockUsPack.isPostingAccount('Current Assets')).toBe(false);
    expect(mockUsPack.isPostingAccount('Revenue')).toBe(false);
    expect(mockUsPack.isPostingAccount('Cost of Goods Sold')).toBe(false);
  });

  it('posting accounts work', () => {
    expect(mockUsPack.isPostingAccount('1000')).toBe(true);
    expect(mockUsPack.isPostingAccount('4000')).toBe(true);
    expect(mockUsPack.isPostingAccount('5000')).toBe(true);
  });

  it('virtual total is not postable', () => {
    expect(mockUsPack.isPostingAccount('2100')).toBe(false); // Sales Tax Payable aggregate
  });

  it('every parentCode resolves', () => {
    const parentCodes = [
      ...new Set(mockUsPack.accountTypes.map((a) => a.parentCode).filter(Boolean)),
    ] as string[];
    for (const pc of parentCodes) {
      expect(mockUsPack.getAccountType(pc), `parentCode "${pc}" not found`).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isVirtualTaxAccount — STRUCTURAL CHECK (NO DOT DEPENDENCY)
// ═══════════════════════════════════════════════════════════════════════════════

describe('isVirtualTaxAccount — structural check', () => {
  const map = buildAccountTypeMap(mockUsPack.accountTypes);

  it('US tax sub-account (no dot) is detected via parent isVirtualTotal', () => {
    const stateTax = mockUsPack.getAccountType('2101')!;
    expect(isVirtualTaxAccount(stateTax, map)).toBe(true);

    const cityTax = mockUsPack.getAccountType('2102')!;
    expect(isVirtualTaxAccount(cityTax, map)).toBe(true);
  });

  it('regular accounts are NOT virtual tax accounts', () => {
    const cash = mockUsPack.getAccountType('1000')!;
    expect(isVirtualTaxAccount(cash, map)).toBe(false);

    const ap = mockUsPack.getAccountType('2000')!;
    expect(isVirtualTaxAccount(ap, map)).toBe(false);
  });

  it('the virtual total parent itself is NOT a virtual tax sub-account', () => {
    const salesTax = mockUsPack.getAccountType('2100')!;
    // 2100's parent is 'Current Liabilities' which is isGroup, not isVirtualTotal
    expect(isVirtualTaxAccount(salesTax, map)).toBe(false);
  });

  it('group labels are NOT virtual tax accounts', () => {
    const group = mockUsPack.getAccountType('Current Assets')!;
    expect(isVirtualTaxAccount(group, map)).toBe(false);
  });

  it('account with no parentCode is not virtual tax', () => {
    const topLevel: AccountType = {
      code: '9999',
      name: 'Top',
      category: 'Balance Sheet-Asset' as any,
      description: '',
      parentCode: null,
    };
    expect(isVirtualTaxAccount(topLevel, map)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCOME STATEMENT — US PACK
// ═══════════════════════════════════════════════════════════════════════════════

describe('Income Statement — US Pack', () => {
  async function postUsActivity() {
    // Revenue
    await postEntry('2025-03-01', [
      { account: cashId, debit: 8000000, credit: 0 },
      { account: salesId, debit: 0, credit: 8000000 },
    ]);
    await postEntry('2025-03-05', [
      { account: arId, debit: 2000000, credit: 0 },
      { account: serviceId, debit: 0, credit: 2000000 },
    ]);

    // COGS
    await postEntry('2025-03-03', [
      { account: materialsId, debit: 3000000, credit: 0 },
      { account: apId, debit: 0, credit: 3000000 },
    ]);
    await postEntry('2025-03-07', [
      { account: laborId, debit: 1500000, credit: 0 },
      { account: cashId, debit: 0, credit: 1500000 },
    ]);

    // Operating Expenses
    await postEntry('2025-03-10', [
      { account: rentId, debit: 500000, credit: 0 },
      { account: cashId, debit: 0, credit: 500000 },
    ]);
    await postEntry('2025-03-15', [
      { account: payrollId, debit: 2000000, credit: 0 },
      { account: cashId, debit: 0, credit: 2000000 },
    ]);
    await postEntry('2025-03-20', [
      { account: utilitiesId, debit: 200000, credit: 0 },
      { account: cashId, debit: 0, credit: 200000 },
    ]);
  }

  it('uses custom revenue label "Net Revenue"', async () => {
    await postUsActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(legacyIncomeStatement(report).revenue.name).toBe('Net Revenue');
  });

  it('detects "Cost of Goods Sold" as COGS (not "Cost of Sales")', async () => {
    await postUsActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const view = legacyIncomeStatement(report);
    const cogsGroup = view.expenses.groups.find((g) => g.name === 'Cost of Goods Sold');
    expect(cogsGroup).toBeDefined();
    expect(cogsGroup?.accounts).toHaveLength(2);
    expect(cogsGroup?.accounts.map((a) => a.code)).toContain('5000');
    expect(cogsGroup?.accounts.map((a) => a.code)).toContain('5100');
  });

  it('calculates correct financial structure', async () => {
    await postUsActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const view = legacyIncomeStatement(report);
    // Revenue: 8,000,000 + 2,000,000 = 10,000,000
    expect(view.revenue.total).toBe(10000000);

    // COGS: 3,000,000 + 1,500,000 = 4,500,000
    expect(view.costOfSales).toBe(4500000);

    // Gross Profit: 10,000,000 - 4,500,000 = 5,500,000
    expect(view.grossProfit).toBe(5500000);

    // OpEx: 500,000 + 2,000,000 + 200,000 = 2,700,000
    expect(view.operatingIncome).toBe(2800000); // 5,500,000 - 2,700,000

    // Net Income: 10,000,000 - 7,200,000 = 2,800,000
    expect(view.netIncome).toBe(2800000);
  });

  it('COGS and OpEx accounts never mix', async () => {
    await postUsActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const view = legacyIncomeStatement(report);
    const cogsCodes = view.expenses.groups
      .find((g) => g.name === 'Cost of Goods Sold')
      ?.accounts.map((a) => a.code);
    const opexCodes = view.expenses.groups
      .find((g) => g.name === 'Operating Expenses')
      ?.accounts.map((a) => a.code);

    expect(cogsCodes).toEqual(expect.arrayContaining(['5000', '5100']));
    expect(opexCodes).toEqual(expect.arrayContaining(['6000', '6100', '6200']));

    // No overlap
    const overlap = (cogsCodes ?? []).filter((c) => (opexCodes ?? []).includes(c));
    expect(overlap).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE SHEET — US PACK
// ═══════════════════════════════════════════════════════════════════════════════

describe('Balance Sheet — US Pack', () => {
  async function postUsBS() {
    // Stock investment $200K
    await postEntry('2025-01-01', [
      { account: cashId, debit: 20000000, credit: 0 },
      { account: stockId, debit: 0, credit: 20000000 },
    ]);

    // Buy PP&E $50K
    await postEntry('2025-01-15', [
      { account: ppeId, debit: 5000000, credit: 0 },
      { account: cashId, debit: 0, credit: 5000000 },
    ]);

    // Revenue $30K
    await postEntry('2025-02-01', [
      { account: cashId, debit: 3000000, credit: 0 },
      { account: salesId, debit: 0, credit: 3000000 },
    ]);

    // Expense $10K
    await postEntry('2025-02-15', [
      { account: rentId, debit: 1000000, credit: 0 },
      { account: cashId, debit: 0, credit: 1000000 },
    ]);
  }

  it('groups assets under "Current Assets" and "Fixed Assets"', async () => {
    await postUsBS();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const groupNames = legacyBalanceSheet(report).assets.groups.map((g) => g.name);
    expect(groupNames).toContain('Current Assets');
    expect(groupNames).toContain('Fixed Assets');
  });

  it('equity group uses US naming', async () => {
    await postUsBS();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const eqGroups = legacyBalanceSheet(report).equity.groups.map((g) => g.name);
    expect(eqGroups).toContain("Stockholders' Equity");
  });

  it('balance sheet balances (A = L + E)', async () => {
    await postUsBS();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const summary = legacyBalanceSheet(report).summary;
    expect(summary.isBalanced).toBe(true);
    expect(summary.difference).toBe(0);
  });

  it('net income flows into equity correctly', async () => {
    await postUsBS();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    // Net income = 30K revenue - 10K rent = 20K
    // Equity = 200K stock + 20K net income = 220K
    expect(legacyBalanceSheet(report).equity.total).toBe(22000000);
  });

  it('virtual tax sub-accounts (no dots) are hidden from display', async () => {
    // Post tax entries
    await postEntry('2025-02-01', [
      { account: cashId, debit: 20000000, credit: 0 },
      { account: stockId, debit: 0, credit: 20000000 },
    ]);
    await postEntry('2025-02-10', [
      { account: cashId, debit: 500000, credit: 0 },
      { account: stateTaxId, debit: 0, credit: 500000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: mockUsPack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const view = legacyBalanceSheet(report);
    // State tax (2101) should be hidden because its parent (2100) is isVirtualTotal
    const allCodes = view.liabilities.groups.flatMap((g) => g.accounts.map((a) => a.code));
    expect(allCodes).not.toContain('2101');

    // But the balance should still be counted
    expect(view.summary.isBalanced).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FISCAL CLOSE — US PACK (different RE code)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fiscal Close — US Pack', () => {
  it('uses US retained earnings code (3200) from country pack', async () => {
    const period = await FPModel.create({
      name: 'FY2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-12-31'),
    });

    // Revenue
    await postEntry('2025-06-01', [
      { account: cashId, debit: 5000000, credit: 0 },
      { account: salesId, debit: 0, credit: 5000000 },
    ]);

    // Expense
    await postEntry('2025-06-15', [
      { account: rentId, debit: 2000000, credit: 0 },
      { account: cashId, debit: 0, credit: 2000000 },
    ]);

    const result = await closeFiscalPeriod(
      { AccountModel, JournalEntryModel: JEModel, FiscalPeriodModel: FPModel, country: mockUsPack },
      { periodId: period._id },
    );

    // Net income = 5M - 2M = 3M
    expect(result.netIncome).toBe(3000000);
    expect(result.closingEntryId).not.toBeNull();

    // Closing entry should post to retained earnings (3200)
    const closingEntry = (await JEModel.findById(result.closingEntryId).lean()) as Record<
      string,
      unknown
    >;
    const items = closingEntry.journalItems as Array<Record<string, unknown>>;
    const reLine = items.find((i) => String(i.account) === String(retainedId));
    expect(reLine).toBeDefined();
    expect(reLine?.credit).toBe(3000000);
  });
});
