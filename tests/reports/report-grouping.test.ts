/**
 * Report Grouping & Layout Tests
 *
 * Tests that the Income Statement, Balance Sheet, and reports in general
 * produce the correct hierarchical structure with proper group labels,
 * account placement, and financial calculation accuracy.
 *
 * Uses a realistic Canada-like country pack with parentCode hierarchy
 * to verify that accounts group under the correct section labels —
 * exactly as they would in production with @classytic/ledger-ca.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { generateIncomeStatement } from '../../src/reports/income-statement.js';
import { generateBalanceSheet } from '../../src/reports/balance-sheet.js';

// ── Realistic Canada-like pack with parentCode hierarchy ────────────────────

const canadaLikePack = defineCountryPack({
  code: 'CA', name: 'Canada Test', defaultCurrency: 'CAD',
  accountTypes: [
    // ── Group Labels (isGroup: true — for report section headings) ──────────
    { code: 'Assets', name: 'Assets', category: 'Balance Sheet-Asset', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Liability', name: 'Liabilities', category: 'Balance Sheet-Liability', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Current Assets', name: 'Current Assets', category: 'Balance Sheet-Asset', description: '', parentCode: 'Assets', isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Capital Assets', name: 'Capital Assets', category: 'Balance Sheet-Asset', description: '', parentCode: 'Assets', isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'CurrentLiabilities', name: 'Current Liabilities', category: 'Balance Sheet-Liability', description: '', parentCode: 'Liability', isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Shareholder Equity', name: 'Shareholder Equity', category: 'Balance Sheet-Equity', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Revenue', name: 'Revenue', category: 'Income Statement-Income', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Cost of Sales', name: 'Cost of Sales', category: 'Income Statement-Expense', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
    { code: 'Operating Expenses', name: 'Operating Expenses', category: 'Income Statement-Expense', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },

    // ── Balance Sheet Posting Accounts ──────────────────────────────────────
    { code: '1000', name: 'Cash and Deposits', category: 'Balance Sheet-Asset', description: '', parentCode: 'Current Assets', isTotal: false, cashFlowCategory: 'operating' },
    { code: '1060', name: 'Accounts Receivable', category: 'Balance Sheet-Asset', description: '', parentCode: 'Current Assets', isTotal: false, cashFlowCategory: 'operating' },
    { code: '1120', name: 'Inventories', category: 'Balance Sheet-Asset', description: '', parentCode: 'Current Assets', isTotal: false, cashFlowCategory: 'operating' },
    { code: '1600', name: 'Land', category: 'Balance Sheet-Asset', description: '', parentCode: 'Capital Assets', isTotal: false, cashFlowCategory: 'Investing' as any },
    { code: '1680', name: 'Equipment', category: 'Balance Sheet-Asset', description: '', parentCode: 'Capital Assets', isTotal: false, cashFlowCategory: 'Investing' as any },
    { code: '2620', name: 'Accounts Payable', category: 'Balance Sheet-Liability', description: '', parentCode: 'CurrentLiabilities', isTotal: false, cashFlowCategory: 'operating' },
    { code: '2680', name: 'Taxes Payable', category: 'Balance Sheet-Liability', description: '', parentCode: 'CurrentLiabilities', isTotal: false, cashFlowCategory: 'operating' },
    { code: '3500', name: 'Common Shares', category: 'Balance Sheet-Equity', description: '', parentCode: 'Shareholder Equity', isTotal: false, cashFlowCategory: null },
    { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: '', parentCode: 'Shareholder Equity', isTotal: false, cashFlowCategory: null },
    { code: '3660', name: 'Retained Earnings – Start', category: 'Balance Sheet-Equity', description: '', parentCode: 'Shareholder Equity', isTotal: false, cashFlowCategory: null },

    // ── Revenue Posting Accounts ────────────────────────────────────────────
    { code: '8000', name: 'Trade Sales of Goods and Services', category: 'Income Statement-Income', description: '', parentCode: 'Revenue', isTotal: false, cashFlowCategory: null },
    { code: '8090', name: 'Investment Revenue', category: 'Income Statement-Income', description: '', parentCode: 'Revenue', isTotal: false, cashFlowCategory: null },
    { code: '8120', name: 'Commission Revenue', category: 'Income Statement-Income', description: '', parentCode: 'Revenue', isTotal: false, cashFlowCategory: null },
    { code: '8230', name: 'Other Revenue', category: 'Income Statement-Income', description: '', parentCode: 'Revenue', isTotal: false, cashFlowCategory: null },

    // ── Cost of Sales Posting Accounts ──────────────────────────────────────
    { code: '8320', name: 'Purchases / Cost of Materials', category: 'Income Statement-Expense', description: '', parentCode: 'Cost of Sales', isTotal: false, cashFlowCategory: null },
    { code: '8340', name: 'Direct Wages', category: 'Income Statement-Expense', description: '', parentCode: 'Cost of Sales', isTotal: false, cashFlowCategory: null },
    { code: '8450', name: 'Other Direct Costs', category: 'Income Statement-Expense', description: '', parentCode: 'Cost of Sales', isTotal: false, cashFlowCategory: null },

    // ── Operating Expense Posting Accounts ──────────────────────────────────
    { code: '8710', name: 'Insurance', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },
    { code: '8860', name: 'Professional Fees', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },
    { code: '8910', name: 'Rent', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },
    { code: '9060', name: 'Salaries and Wages', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },
    { code: '9220', name: 'Utilities', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },

    // ── Uncategorized Catch-Alls ─────────────────────────────────────────────
    { code: 'Uncategorized Income', name: 'Uncategorized Income', category: 'Income Statement-Income', description: '', parentCode: 'Revenue', isTotal: false, cashFlowCategory: null },
    { code: 'Uncategorized Expense', name: 'Uncategorized Expense', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
});

const config: AccountingEngineConfig = { country: canadaLikePack, currency: 'CAD' };

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;

// Account IDs
let cashId: mongoose.Types.ObjectId;
let arId: mongoose.Types.ObjectId;
let inventoryId: mongoose.Types.ObjectId;
let landId: mongoose.Types.ObjectId;
let equipId: mongoose.Types.ObjectId;
let apId: mongoose.Types.ObjectId;
let taxPayId: mongoose.Types.ObjectId;
let sharesId: mongoose.Types.ObjectId;
let retainedId: mongoose.Types.ObjectId;
let salesId: mongoose.Types.ObjectId;
let investRevId: mongoose.Types.ObjectId;
let commissionId: mongoose.Types.ObjectId;
let otherRevId: mongoose.Types.ObjectId;
let purchasesId: mongoose.Types.ObjectId;
let directWagesId: mongoose.Types.ObjectId;
let otherDirectId: mongoose.Types.ObjectId;
let insuranceId: mongoose.Types.ObjectId;
let profFeesId: mongoose.Types.ObjectId;
let rentId: mongoose.Types.ObjectId;
let salariesId: mongoose.Types.ObjectId;
let utilitiesId: mongoose.Types.ObjectId;
let uncatIncomeId: mongoose.Types.ObjectId;
let uncatExpenseId: mongoose.Types.ObjectId;

async function postEntry(date: string, items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>) {
  return JEModel.create({
    journalType: 'GENERAL', state: 'posted', date: new Date(date),
    journalItems: items,
    totalDebit: items.reduce((s, i) => s + i.debit, 0),
    totalCredit: items.reduce((s, i) => s + i.credit, 0),
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  if (mongoose.models['GrpAccount']) delete mongoose.models['GrpAccount'];
  AccountModel = mongoose.model('GrpAccount', createAccountSchema(config));

  if (mongoose.models['GrpJE']) delete mongoose.models['GrpJE'];
  JEModel = mongoose.model('GrpJE', createJournalEntrySchema(config, 'GrpAccount'));

  await AccountModel.createIndexes();
  await JEModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await JEModel.deleteMany({});

  // Seed all accounts
  const seed = async (code: string) => (await AccountModel.create({ accountTypeCode: code }))._id;

  cashId = await seed('1000');
  arId = await seed('1060');
  inventoryId = await seed('1120');
  landId = await seed('1600');
  equipId = await seed('1680');
  apId = await seed('2620');
  taxPayId = await seed('2680');
  sharesId = await seed('3500');
  retainedId = await seed('3660');
  salesId = await seed('8000');
  investRevId = await seed('8090');
  commissionId = await seed('8120');
  otherRevId = await seed('8230');
  purchasesId = await seed('8320');
  directWagesId = await seed('8340');
  otherDirectId = await seed('8450');
  insuranceId = await seed('8710');
  profFeesId = await seed('8860');
  rentId = await seed('8910');
  salariesId = await seed('9060');
  utilitiesId = await seed('9220');
  uncatIncomeId = await seed('Uncategorized Income');
  uncatExpenseId = await seed('Uncategorized Expense');
});


// ═══════════════════════════════════════════════════════════════════════════════
// INCOME STATEMENT — GROUP STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Income Statement — Group Structure & Layout', () => {

  /**
   * Post a realistic month of business activity:
   *
   * REVENUE:
   *   Trade Sales           $50,000
   *   Investment Revenue      $2,000
   *   Commission Revenue      $3,000
   *   Uncategorized Income    $1,000
   *                        ────────
   *   Total Revenue         $56,000
   *
   * COST OF SALES:
   *   Purchases             $15,000
   *   Direct Wages           $8,000
   *   Other Direct Costs     $2,000
   *                        ────────
   *   Total COGS            $25,000
   *
   *   GROSS PROFIT          $31,000
   *
   * OPERATING EXPENSES:
   *   Salaries              $12,000
   *   Rent                   $5,000
   *   Insurance              $1,500
   *   Professional Fees      $2,000
   *   Utilities              $1,000
   *   Uncategorized Expense    $500
   *                        ────────
   *   Total OpEx            $22,000
   *
   *   OPERATING INCOME       $9,000
   *   NET INCOME             $9,000
   */
  async function postMonthActivity() {
    // Revenue entries
    await postEntry('2025-03-02', [
      { account: cashId, debit: 5000000, credit: 0 },
      { account: salesId, debit: 0, credit: 5000000 },
    ]);
    await postEntry('2025-03-05', [
      { account: cashId, debit: 200000, credit: 0 },
      { account: investRevId, debit: 0, credit: 200000 },
    ]);
    await postEntry('2025-03-08', [
      { account: arId, debit: 300000, credit: 0 },
      { account: commissionId, debit: 0, credit: 300000 },
    ]);
    await postEntry('2025-03-10', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: uncatIncomeId, debit: 0, credit: 100000 },
    ]);

    // Cost of Sales entries
    await postEntry('2025-03-03', [
      { account: purchasesId, debit: 1500000, credit: 0 },
      { account: apId, debit: 0, credit: 1500000 },
    ]);
    await postEntry('2025-03-07', [
      { account: directWagesId, debit: 800000, credit: 0 },
      { account: cashId, debit: 0, credit: 800000 },
    ]);
    await postEntry('2025-03-12', [
      { account: otherDirectId, debit: 200000, credit: 0 },
      { account: cashId, debit: 0, credit: 200000 },
    ]);

    // Operating Expense entries
    await postEntry('2025-03-15', [
      { account: salariesId, debit: 1200000, credit: 0 },
      { account: cashId, debit: 0, credit: 1200000 },
    ]);
    await postEntry('2025-03-16', [
      { account: rentId, debit: 500000, credit: 0 },
      { account: cashId, debit: 0, credit: 500000 },
    ]);
    await postEntry('2025-03-17', [
      { account: insuranceId, debit: 150000, credit: 0 },
      { account: cashId, debit: 0, credit: 150000 },
    ]);
    await postEntry('2025-03-18', [
      { account: profFeesId, debit: 200000, credit: 0 },
      { account: cashId, debit: 0, credit: 200000 },
    ]);
    await postEntry('2025-03-20', [
      { account: utilitiesId, debit: 100000, credit: 0 },
      { account: cashId, debit: 0, credit: 100000 },
    ]);
    await postEntry('2025-03-25', [
      { account: uncatExpenseId, debit: 50000, credit: 0 },
      { account: cashId, debit: 0, credit: 50000 },
    ]);
  }

  // ── Revenue Section ─────────────────────────────────────────────────────

  it('revenue section contains a single "Revenue" group with all revenue accounts', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.revenue.name).toBe('Revenue');
    expect(report.revenue.groups.length).toBe(1);
    expect(report.revenue.groups[0].name).toBe('Revenue');
  });

  it('revenue group contains all 4 revenue accounts with correct balances', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const revenueGroup = report.revenue.groups[0];
    const codes = revenueGroup.accounts.map(a => a.code);

    expect(codes).toContain('8000'); // Trade Sales
    expect(codes).toContain('8090'); // Investment Revenue
    expect(codes).toContain('8120'); // Commission Revenue
    expect(codes).toContain('Uncategorized Income');

    // Verify individual balances
    const findAcct = (code: string) => revenueGroup.accounts.find(a => a.code === code)!;
    expect(findAcct('8000').balance).toBe(5000000);   // $50,000
    expect(findAcct('8090').balance).toBe(200000);     // $2,000
    expect(findAcct('8120').balance).toBe(300000);     // $3,000
    expect(findAcct('Uncategorized Income').balance).toBe(100000); // $1,000
  });

  it('total revenue = $56,000', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.revenue.total).toBe(5600000);
  });

  // ── Cost of Sales Section ───────────────────────────────────────────────

  it('expenses section contains "Cost of Sales" group', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const cogsGroup = report.expenses.groups.find(g => g.name === 'Cost of Sales');
    expect(cogsGroup).toBeDefined();
    expect(cogsGroup!.accounts).toHaveLength(3);

    const codes = cogsGroup!.accounts.map(a => a.code);
    expect(codes).toContain('8320'); // Purchases
    expect(codes).toContain('8340'); // Direct Wages
    expect(codes).toContain('8450'); // Other Direct Costs
  });

  it('cost of sales total = $25,000', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.costOfSales).toBe(2500000);
  });

  it('gross profit = revenue - COGS = $31,000', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.grossProfit).toBe(3100000); // 5,600,000 - 2,500,000
  });

  // ── Operating Expenses Section ──────────────────────────────────────────

  it('expenses section contains "Operating Expenses" group', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const opexGroup = report.expenses.groups.find(g => g.name === 'Operating Expenses');
    expect(opexGroup).toBeDefined();
    expect(opexGroup!.accounts).toHaveLength(6); // 5 standard + 1 uncategorized

    const codes = opexGroup!.accounts.map(a => a.code);
    expect(codes).toContain('9060'); // Salaries
    expect(codes).toContain('8910'); // Rent
    expect(codes).toContain('8710'); // Insurance
    expect(codes).toContain('8860'); // Professional Fees
    expect(codes).toContain('9220'); // Utilities
    expect(codes).toContain('Uncategorized Expense');
  });

  it('operating expenses balances are correct', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const opexGroup = report.expenses.groups.find(g => g.name === 'Operating Expenses')!;
    const findAcct = (code: string) => opexGroup.accounts.find(a => a.code === code)!;

    expect(findAcct('9060').balance).toBe(1200000);  // Salaries $12,000
    expect(findAcct('8910').balance).toBe(500000);   // Rent $5,000
    expect(findAcct('8710').balance).toBe(150000);   // Insurance $1,500
    expect(findAcct('8860').balance).toBe(200000);   // Professional Fees $2,000
    expect(findAcct('9220').balance).toBe(100000);   // Utilities $1,000
    expect(findAcct('Uncategorized Expense').balance).toBe(50000); // $500
  });

  // ── Summary Calculations ────────────────────────────────────────────────

  it('operating income = gross profit - operating expenses = $9,000', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.operatingIncome).toBe(900000); // 3,100,000 - 2,200,000
  });

  it('net income = revenue - all expenses = $9,000', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.netIncome).toBe(900000); // 5,600,000 - 4,700,000
  });

  it('total expenses = COGS + Operating Expenses = $47,000', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.expenses.total).toBe(4700000);
  });

  // ── Layout: no data shifting between groups ─────────────────────────────

  it('expense groups are distinct — COGS and OpEx accounts never mixed', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const cogsGroup = report.expenses.groups.find(g => g.name === 'Cost of Sales')!;
    const opexGroup = report.expenses.groups.find(g => g.name === 'Operating Expenses')!;

    // COGS should only have 8xxx codes in the 8300-8500 range
    const cogsCodes = cogsGroup.accounts.map(a => a.code);
    expect(cogsCodes.every(c => ['8320', '8340', '8450'].includes(c))).toBe(true);

    // OpEx should not have any COGS codes
    const opexCodes = opexGroup.accounts.map(a => a.code);
    expect(opexCodes.every(c => !['8320', '8340', '8450'].includes(c))).toBe(true);
  });

  it('revenue accounts never appear in expense groups', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const allExpenseCodes = report.expenses.groups.flatMap(g => g.accounts.map(a => a.code));
    const allRevenueCodes = report.revenue.groups.flatMap(g => g.accounts.map(a => a.code));

    // No overlap
    const overlap = allExpenseCodes.filter(c => allRevenueCodes.includes(c));
    expect(overlap).toEqual([]);
  });

  it('every account appears in exactly one group', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const allAccounts = [
      ...report.revenue.groups.flatMap(g => g.accounts.map(a => a.code)),
      ...report.expenses.groups.flatMap(g => g.accounts.map(a => a.code)),
    ];

    // No duplicates
    const unique = new Set(allAccounts);
    expect(unique.size).toBe(allAccounts.length);
  });

  // ── Metadata ────────────────────────────────────────────────────────────

  it('metadata has correct period boundaries', async () => {
    await postMonthActivity();

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03', businessName: 'Maple Consulting Inc.' },
    );

    expect(report.metadata.businessName).toBe('Maple Consulting Inc.');
    expect(report.metadata.periodStart).toMatch(/^2025-0[23]/); // March (may show Feb 28 in UTC-offset zones)
    expect(report.metadata.periodEnd).toMatch(/^2025-03/);
  });

  // ── Draft entries excluded ──────────────────────────────────────────────

  it('draft entries are excluded from the report', async () => {
    await postMonthActivity();

    // Add a DRAFT entry that should not appear
    await JEModel.create({
      journalType: 'GENERAL', state: 'draft', date: new Date('2025-03-28'),
      journalItems: [
        { account: cashId, debit: 9999999, credit: 0 },
        { account: salesId, debit: 0, credit: 9999999 },
      ],
      totalDebit: 9999999, totalCredit: 9999999,
    });

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    // Revenue should still be $56,000, not $56,000 + $99,999.99
    expect(report.revenue.total).toBe(5600000);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE SHEET — GROUP STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Balance Sheet — Group Structure & Layout', () => {

  async function postBalanceSheetData() {
    // Equity investment: $100,000
    await postEntry('2025-01-01', [
      { account: cashId, debit: 10000000, credit: 0 },
      { account: sharesId, debit: 0, credit: 10000000 },
    ]);

    // Buy equipment: $30,000
    await postEntry('2025-01-15', [
      { account: equipId, debit: 3000000, credit: 0 },
      { account: cashId, debit: 0, credit: 3000000 },
    ]);

    // Buy land: $50,000
    await postEntry('2025-01-20', [
      { account: landId, debit: 5000000, credit: 0 },
      { account: cashId, debit: 0, credit: 5000000 },
    ]);

    // Revenue: $20,000
    await postEntry('2025-02-01', [
      { account: arId, debit: 2000000, credit: 0 },
      { account: salesId, debit: 0, credit: 2000000 },
    ]);

    // Purchase inventory: $5,000 on credit
    await postEntry('2025-02-05', [
      { account: inventoryId, debit: 500000, credit: 0 },
      { account: apId, debit: 0, credit: 500000 },
    ]);

    // Rent expense: $3,000
    await postEntry('2025-02-10', [
      { account: rentId, debit: 300000, credit: 0 },
      { account: cashId, debit: 0, credit: 300000 },
    ]);
  }

  it('assets section has Current Assets and Capital Assets groups', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const groupNames = report.assets.groups.map(g => g.name);
    expect(groupNames).toContain('Current Assets');
    expect(groupNames).toContain('Capital Assets');
  });

  it('Current Assets group contains Cash, AR, Inventory', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const currentAssets = report.assets.groups.find(g => g.name === 'Current Assets')!;
    const codes = currentAssets.accounts.map(a => a.code);
    expect(codes).toContain('1000'); // Cash
    expect(codes).toContain('1060'); // AR
    expect(codes).toContain('1120'); // Inventory
  });

  it('Capital Assets group contains Land, Equipment', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const capitalAssets = report.assets.groups.find(g => g.name === 'Capital Assets')!;
    const codes = capitalAssets.accounts.map(a => a.code);
    expect(codes).toContain('1600'); // Land
    expect(codes).toContain('1680'); // Equipment
  });

  it('liabilities group under Current Liabilities', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const currentLiab = report.liabilities.groups.find(g => g.name === 'Current Liabilities')!;
    expect(currentLiab).toBeDefined();
    const codes = currentLiab.accounts.map(a => a.code);
    expect(codes).toContain('2620'); // AP
  });

  it('balance sheet is balanced (A = L + E)', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    expect(report.summary.isBalanced).toBe(true);
    expect(report.summary.difference).toBe(0);
    expect(report.summary.totalAssets).toBe(
      report.summary.totalLiabilities + report.summary.totalEquity,
    );
  });

  it('asset balances are correct', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const currentAssets = report.assets.groups.find(g => g.name === 'Current Assets')!;
    const capitalAssets = report.assets.groups.find(g => g.name === 'Capital Assets')!;

    const findAcct = (group: any, code: string) => group.accounts.find((a: any) => a.code === code);

    // Cash: 10,000,000 - 3,000,000 - 5,000,000 - 300,000 = 1,700,000
    expect(findAcct(currentAssets, '1000').balance).toBe(1700000);
    // AR: 2,000,000
    expect(findAcct(currentAssets, '1060').balance).toBe(2000000);
    // Inventory: 500,000
    expect(findAcct(currentAssets, '1120').balance).toBe(500000);
    // Land: 5,000,000
    expect(findAcct(capitalAssets, '1600').balance).toBe(5000000);
    // Equipment: 3,000,000
    expect(findAcct(capitalAssets, '1680').balance).toBe(3000000);
  });

  it('no accounts cross between asset/liability/equity sections', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    const assetCodes = report.assets.groups.flatMap(g => g.accounts.map(a => a.code));
    const liabCodes = report.liabilities.groups.flatMap(g => g.accounts.map(a => a.code));
    const eqCodes = report.equity.groups.flatMap(g => g.accounts.map(a => a.code));

    // No overlap
    expect(assetCodes.filter(c => liabCodes.includes(c))).toEqual([]);
    expect(assetCodes.filter(c => eqCodes.includes(c))).toEqual([]);
    expect(liabCodes.filter(c => eqCodes.includes(c))).toEqual([]);
  });

  it('net income flows into equity', async () => {
    await postBalanceSheetData();

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: canadaLikePack },
      { dateOption: 'month', dateValue: '2025-03' },
    );

    // Revenue $20,000 - Rent $3,000 = $17,000 net income
    // Equity = $100,000 shares + $17,000 net income = $117,000
    expect(report.equity.total).toBe(11700000);
  });
});
