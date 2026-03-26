/**
 * Report Fixes Tests
 *
 * Tests for specific fixes in the income statement and balance sheet reports:
 * - resolveGroupName walks deep parent chains correctly
 * - resolveGroupName handles circular parentCode without infinite loop
 * - pruneGroups filters zero-balance accounts and empty groups
 * - Equity retained earnings are never pruned even when zero
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

// ═══════════════════════════════════════════════════════════════════════════════
// INCOME STATEMENT — resolveGroupName deep parent chains
// ═══════════════════════════════════════════════════════════════════════════════

describe('Income Statement — resolveGroupName deep parent chains', () => {
  /**
   * Country pack with a 3-level parent hierarchy:
   *   child (9100 Telephone) → parent (9000 Admin Expenses) → grandparent group (Operating Expenses)
   *
   * resolveGroupName should walk all the way up and return "Operating Expenses".
   */
  const deepPack = defineCountryPack({
    code: 'DP', name: 'Deep Parent Test', defaultCurrency: 'TST',
    accountTypes: [
      // Balance sheet accounts (needed for journal entries)
      { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
      { code: '3660', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },

      // Group labels
      { code: 'Revenue', name: 'Revenue', category: 'Income Statement-Income', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
      { code: 'Operating Expenses', name: 'Operating Expenses', category: 'Income Statement-Expense', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },

      // Intermediate non-group parent (NOT isGroup — just a regular parent)
      { code: '9000', name: 'Admin Expenses', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },

      // Child posting accounts — 3 levels deep
      { code: '9100', name: 'Telephone', category: 'Income Statement-Expense', description: '', parentCode: '9000', isTotal: false, cashFlowCategory: null },
      { code: '9200', name: 'Internet', category: 'Income Statement-Expense', description: '', parentCode: '9000', isTotal: false, cashFlowCategory: null },

      // Direct child of group — 2 levels deep
      { code: '9500', name: 'Depreciation', category: 'Income Statement-Expense', description: '', parentCode: 'Operating Expenses', isTotal: false, cashFlowCategory: null },

      // Revenue posting account
      { code: '8000', name: 'Sales', category: 'Income Statement-Income', description: '', parentCode: 'Revenue', isTotal: false, cashFlowCategory: null },
    ],
    taxCodes: {}, taxCodesByRegion: {}, regions: [],
  });

  const config: AccountingEngineConfig = { country: deepPack, currency: 'TST' };

  let mongod: MongoMemoryServer;
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;
  let cashId: mongoose.Types.ObjectId;
  let telephoneId: mongoose.Types.ObjectId;
  let internetId: mongoose.Types.ObjectId;
  let depreciationId: mongoose.Types.ObjectId;
  let salesId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    if (mongoose.models['DPAcct']) delete mongoose.models['DPAcct'];
    AccountModel = mongoose.model('DPAcct', createAccountSchema(config));

    if (mongoose.models['DPJE']) delete mongoose.models['DPJE'];
    JEModel = mongoose.model('DPJE', createJournalEntrySchema(config, 'DPAcct'));

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

    const seed = async (code: string) => (await AccountModel.create({ accountTypeCode: code }))._id;
    cashId = await seed('1000');
    telephoneId = await seed('9100');
    internetId = await seed('9200');
    depreciationId = await seed('9500');
    salesId = await seed('8000');
  });

  async function postEntry(date: string, items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>) {
    return JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date(date),
      journalItems: items,
      totalDebit: items.reduce((s, i) => s + i.debit, 0),
      totalCredit: items.reduce((s, i) => s + i.credit, 0),
    });
  }

  it('3-level deep accounts (child → parent → group) roll up to the group', async () => {
    // Telephone expense: $500
    await postEntry('2025-06-01', [
      { account: telephoneId, debit: 50000, credit: 0 },
      { account: cashId, debit: 0, credit: 50000 },
    ]);
    // Internet expense: $300
    await postEntry('2025-06-05', [
      { account: internetId, debit: 30000, credit: 0 },
      { account: cashId, debit: 0, credit: 30000 },
    ]);
    // Revenue to balance
    await postEntry('2025-06-10', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: salesId, debit: 0, credit: 100000 },
    ]);

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: deepPack },
      { dateOption: 'month', dateValue: '2025-06' },
    );

    // Telephone and Internet should be in "Operating Expenses" group, NOT "Admin Expenses"
    const opexGroup = report.expenses.groups.find(g => g.name === 'Operating Expenses');
    expect(opexGroup).toBeDefined();

    const codes = opexGroup!.accounts.map(a => a.code);
    expect(codes).toContain('9100'); // Telephone
    expect(codes).toContain('9200'); // Internet

    // There should NOT be a separate "Admin Expenses" group
    const adminGroup = report.expenses.groups.find(g => g.name === 'Admin Expenses');
    expect(adminGroup).toBeUndefined();
  });

  it('2-level deep accounts (child → group) also roll up to the group', async () => {
    // Depreciation expense: $200
    await postEntry('2025-06-15', [
      { account: depreciationId, debit: 20000, credit: 0 },
      { account: cashId, debit: 0, credit: 20000 },
    ]);
    // Revenue to balance
    await postEntry('2025-06-10', [
      { account: cashId, debit: 30000, credit: 0 },
      { account: salesId, debit: 0, credit: 30000 },
    ]);

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: deepPack },
      { dateOption: 'month', dateValue: '2025-06' },
    );

    const opexGroup = report.expenses.groups.find(g => g.name === 'Operating Expenses');
    expect(opexGroup).toBeDefined();

    const codes = opexGroup!.accounts.map(a => a.code);
    expect(codes).toContain('9500'); // Depreciation
  });

  it('all depth levels end up in the same group', async () => {
    // Post entries for all three expense accounts
    await postEntry('2025-06-01', [
      { account: telephoneId, debit: 50000, credit: 0 },
      { account: cashId, debit: 0, credit: 50000 },
    ]);
    await postEntry('2025-06-05', [
      { account: internetId, debit: 30000, credit: 0 },
      { account: cashId, debit: 0, credit: 30000 },
    ]);
    await postEntry('2025-06-10', [
      { account: depreciationId, debit: 20000, credit: 0 },
      { account: cashId, debit: 0, credit: 20000 },
    ]);
    // Revenue to balance
    await postEntry('2025-06-15', [
      { account: cashId, debit: 120000, credit: 0 },
      { account: salesId, debit: 0, credit: 120000 },
    ]);

    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: deepPack },
      { dateOption: 'month', dateValue: '2025-06' },
    );

    // Should have exactly one expense group
    expect(report.expenses.groups).toHaveLength(1);
    expect(report.expenses.groups[0].name).toBe('Operating Expenses');
    expect(report.expenses.groups[0].accounts).toHaveLength(3);
    expect(report.expenses.groups[0].total).toBe(100000); // 50k + 30k + 20k
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCOME STATEMENT — resolveGroupName circular safety
// ═══════════════════════════════════════════════════════════════════════════════

describe('Income Statement — resolveGroupName circular parentCode safety', () => {
  /**
   * Country pack where parentCode forms a cycle: A → B → A
   * resolveGroupName should not infinite loop — it should return
   * the account's own name as fallback.
   */
  const circularPack = defineCountryPack({
    code: 'CRC', name: 'Circular Test', defaultCurrency: 'TST',
    accountTypes: [
      { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
      { code: '3660', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },

      // Circular: A → B → A (neither is a group, so resolveGroupName walks endlessly without the visited check)
      { code: 'A', name: 'Category A', category: 'Income Statement-Expense', description: '', parentCode: 'B', isTotal: false, cashFlowCategory: null },
      { code: 'B', name: 'Category B', category: 'Income Statement-Expense', description: '', parentCode: 'A', isTotal: false, cashFlowCategory: null },

      // Posting account under A
      { code: '9000', name: 'Misc Expense', category: 'Income Statement-Expense', description: '', parentCode: 'A', isTotal: false, cashFlowCategory: null },

      // Revenue (needed for entries)
      { code: '8000', name: 'Sales', category: 'Income Statement-Income', description: '', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
    taxCodes: {}, taxCodesByRegion: {}, regions: [],
  });

  const config: AccountingEngineConfig = { country: circularPack, currency: 'TST' };

  let mongod: MongoMemoryServer;
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    if (mongoose.models['CRCAcct']) delete mongoose.models['CRCAcct'];
    AccountModel = mongoose.model('CRCAcct', createAccountSchema(config));

    if (mongoose.models['CRCJE']) delete mongoose.models['CRCJE'];
    JEModel = mongoose.model('CRCJE', createJournalEntrySchema(config, 'CRCAcct'));

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
  });

  it('does not infinite loop on circular parentCode — completes within timeout', async () => {
    const cash = await AccountModel.create({ accountTypeCode: '1000' });
    const expense = await AccountModel.create({ accountTypeCode: '9000' });
    const sales = await AccountModel.create({ accountTypeCode: '8000' });

    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-06-01'),
      journalItems: [
        { account: expense._id, debit: 10000, credit: 0 },
        { account: cash._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });

    // Revenue entry to make the statement non-empty
    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-06-01'),
      journalItems: [
        { account: cash._id, debit: 20000, credit: 0 },
        { account: sales._id, debit: 0, credit: 20000 },
      ],
      totalDebit: 20000, totalCredit: 20000,
    });

    // This should complete without hanging. The visited set breaks the cycle.
    const report = await generateIncomeStatement(
      { AccountModel, JournalEntryModel: JEModel, country: circularPack },
      { dateOption: 'month', dateValue: '2025-06' },
    );

    expect(report).toBeDefined();
    expect(report.expenses.groups.length).toBeGreaterThanOrEqual(1);

    // The expense should appear in some group (fallback name since no group is found)
    const allExpenseAccounts = report.expenses.groups.flatMap(g => g.accounts);
    const miscExpense = allExpenseAccounts.find(a => a.code === '9000');
    expect(miscExpense).toBeDefined();
    expect(miscExpense!.balance).toBe(10000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE SHEET — pruneGroups
// ═══════════════════════════════════════════════════════════════════════════════

describe('Balance Sheet — pruneGroups', () => {
  const prunePack = defineCountryPack({
    code: 'PRN', name: 'Prune Test', defaultCurrency: 'TST',
    accountTypes: [
      // Groups
      { code: 'Current Assets', name: 'Current Assets', category: 'Balance Sheet-Asset', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
      { code: 'Capital Assets', name: 'Capital Assets', category: 'Balance Sheet-Asset', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
      { code: 'Liabilities', name: 'Liabilities', category: 'Balance Sheet-Liability', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },
      { code: 'Equity', name: 'Equity', category: 'Balance Sheet-Equity', description: '', parentCode: null, isTotal: false, isGroup: true, cashFlowCategory: null },

      // Posting accounts
      { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: 'Current Assets', isTotal: false, cashFlowCategory: 'operating' },
      { code: '1100', name: 'Accounts Receivable', category: 'Balance Sheet-Asset', description: 'AR', parentCode: 'Current Assets', isTotal: false, cashFlowCategory: 'operating' },
      { code: '1500', name: 'Equipment', category: 'Balance Sheet-Asset', description: 'Equip', parentCode: 'Capital Assets', isTotal: false, cashFlowCategory: null },
      { code: '2000', name: 'Accounts Payable', category: 'Balance Sheet-Liability', description: 'AP', parentCode: 'Liabilities', isTotal: false, cashFlowCategory: 'operating' },
      { code: '3000', name: 'Share Capital', category: 'Balance Sheet-Equity', description: 'Shares', parentCode: 'Equity', isTotal: false, cashFlowCategory: null },
      { code: '3660', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: 'Equity', isTotal: false, cashFlowCategory: null },

      // Income statement (needed for retained earnings calc)
      { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '5000', name: 'Expenses', category: 'Income Statement-Expense', description: 'Expenses', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
    taxCodes: {}, taxCodesByRegion: {}, regions: [],
  });

  const config: AccountingEngineConfig = { country: prunePack, currency: 'TST' };

  let mongod: MongoMemoryServer;
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;
  let cashId: mongoose.Types.ObjectId;
  let arId: mongoose.Types.ObjectId;
  let equipId: mongoose.Types.ObjectId;
  let apId: mongoose.Types.ObjectId;
  let sharesId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    if (mongoose.models['PRNAcct']) delete mongoose.models['PRNAcct'];
    AccountModel = mongoose.model('PRNAcct', createAccountSchema(config));

    if (mongoose.models['PRNJE']) delete mongoose.models['PRNJE'];
    JEModel = mongoose.model('PRNJE', createJournalEntrySchema(config, 'PRNAcct'));

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

    const seed = async (code: string) => (await AccountModel.create({ accountTypeCode: code }))._id;
    cashId = await seed('1000');
    arId = await seed('1100');
    equipId = await seed('1500');
    apId = await seed('2000');
    sharesId = await seed('3000');
    await seed('3660');
  });

  async function postEntry(date: string, items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>) {
    return JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date(date),
      journalItems: items,
      totalDebit: items.reduce((s, i) => s + i.debit, 0),
      totalCredit: items.reduce((s, i) => s + i.credit, 0),
    });
  }

  it('zero-balance accounts are filtered from asset/liability groups', async () => {
    // Only fund Cash — AR and Equipment will have zero balance
    await postEntry('2025-01-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: sharesId, debit: 0, credit: 100000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: prunePack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    // Current Assets group should only contain Cash, not AR (zero balance)
    const currentAssets = report.assets.groups.find(g => g.name === 'Current Assets');
    expect(currentAssets).toBeDefined();
    const codes = currentAssets!.accounts.map(a => a.code);
    expect(codes).toContain('1000'); // Cash has balance
    expect(codes).not.toContain('1100'); // AR is zero — pruned
  });

  it('empty groups (all zero-balance accounts) are removed', async () => {
    // Only fund Cash — Equipment group will be entirely empty
    await postEntry('2025-01-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: sharesId, debit: 0, credit: 100000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: prunePack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    // Capital Assets group should be removed entirely (Equipment has zero balance)
    const capitalAssets = report.assets.groups.find(g => g.name === 'Capital Assets');
    expect(capitalAssets).toBeUndefined();
  });

  it('groups with non-zero total but some zero-balance accounts prune those accounts', async () => {
    // Fund Cash and AR, but not Equipment
    await postEntry('2025-01-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: sharesId, debit: 0, credit: 100000 },
    ]);
    await postEntry('2025-01-05', [
      { account: arId, debit: 50000, credit: 0 },
      { account: apId, debit: 0, credit: 50000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: prunePack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    // Current Assets should have Cash and AR, both non-zero
    const currentAssets = report.assets.groups.find(g => g.name === 'Current Assets')!;
    expect(currentAssets.accounts).toHaveLength(2);
    expect(currentAssets.accounts.map(a => a.code).sort()).toEqual(['1000', '1100']);
  });

  it('liabilities group with zero-balance AP is removed', async () => {
    // Only equity investment — no liabilities
    await postEntry('2025-01-01', [
      { account: cashId, debit: 100000, credit: 0 },
      { account: sharesId, debit: 0, credit: 100000 },
    ]);

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: prunePack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    // AP has zero balance, so Liabilities group should be empty/pruned
    expect(report.liabilities.groups.length).toBe(0);
    expect(report.liabilities.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE SHEET — Equity retained earnings not pruned
// ═══════════════════════════════════════════════════════════════════════════════

describe('Balance Sheet — equity retained earnings always shown', () => {
  const equityPack = defineCountryPack({
    code: 'EQ', name: 'Equity Test', defaultCurrency: 'TST',
    accountTypes: [
      { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
      { code: '3000', name: 'Share Capital', category: 'Balance Sheet-Equity', description: 'Shares', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '3660', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '5000', name: 'Expenses', category: 'Income Statement-Expense', description: 'Expenses', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
    taxCodes: {}, taxCodesByRegion: {}, regions: [],
  });

  const config: AccountingEngineConfig = { country: equityPack, currency: 'TST' };

  let mongod: MongoMemoryServer;
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    if (mongoose.models['EQAcct']) delete mongoose.models['EQAcct'];
    AccountModel = mongoose.model('EQAcct', createAccountSchema(config));

    if (mongoose.models['EQJE']) delete mongoose.models['EQJE'];
    JEModel = mongoose.model('EQJE', createJournalEntrySchema(config, 'EQAcct'));

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
  });

  it('retained earnings group is shown even when prior retained and net income are both zero', async () => {
    const cash = await AccountModel.create({ accountTypeCode: '1000' });
    const shares = await AccountModel.create({ accountTypeCode: '3000' });

    // Simple equity investment, no revenue or expenses
    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-01-01'),
      journalItems: [
        { account: cash._id, debit: 100000, credit: 0 },
        { account: shares._id, debit: 0, credit: 100000 },
      ],
      totalDebit: 100000, totalCredit: 100000,
    });

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: equityPack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    // Equity section should have a "Retained Earnings" group even with zero balances
    const reGroup = report.equity.groups.find(g => g.name === 'Retained Earnings');
    expect(reGroup).toBeDefined();

    // It should contain the prior-retained and current-year accounts
    const reCodes = reGroup!.accounts.map(a => a.code);
    expect(reCodes).toContain('3660'); // prior retained earnings code
    expect(reCodes).toContain('3680'); // current year net income code

    // Both should be zero
    const priorRE = reGroup!.accounts.find(a => a.code === '3660');
    const currentYearNI = reGroup!.accounts.find(a => a.code === '3680');
    expect(priorRE!.balance).toBe(0);
    expect(currentYearNI!.balance).toBe(0);
  });

  it('retained earnings group shows correct non-zero values', async () => {
    const cash = await AccountModel.create({ accountTypeCode: '1000' });
    const shares = await AccountModel.create({ accountTypeCode: '3000' });
    const revenue = await AccountModel.create({ accountTypeCode: '4000' });
    const expense = await AccountModel.create({ accountTypeCode: '5000' });

    // Equity investment
    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-01-01'),
      journalItems: [
        { account: cash._id, debit: 100000, credit: 0 },
        { account: shares._id, debit: 0, credit: 100000 },
      ],
      totalDebit: 100000, totalCredit: 100000,
    });

    // Revenue $500
    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-01-15'),
      journalItems: [
        { account: cash._id, debit: 50000, credit: 0 },
        { account: revenue._id, debit: 0, credit: 50000 },
      ],
      totalDebit: 50000, totalCredit: 50000,
    });

    // Expense $200
    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-01-20'),
      journalItems: [
        { account: expense._id, debit: 20000, credit: 0 },
        { account: cash._id, debit: 0, credit: 20000 },
      ],
      totalDebit: 20000, totalCredit: 20000,
    });

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: equityPack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    const reGroup = report.equity.groups.find(g => g.name === 'Retained Earnings')!;
    expect(reGroup).toBeDefined();

    // Net income = 50000 - 20000 = 30000
    const currentYearNI = reGroup.accounts.find(a => a.code === '3680');
    expect(currentYearNI).toBeDefined();
    expect(currentYearNI!.balance).toBe(30000);

    // Prior retained should be 0 (all entries in same fiscal year)
    const priorRE = reGroup.accounts.find(a => a.code === '3660');
    expect(priorRE!.balance).toBe(0);

    // Balance sheet should be balanced
    expect(report.summary.isBalanced).toBe(true);
  });

  it('equity groups are NOT pruned even when they contain zero-balance accounts', async () => {
    const cash = await AccountModel.create({ accountTypeCode: '1000' });
    const shares = await AccountModel.create({ accountTypeCode: '3000' });

    // Only equity investment — Share Capital has balance, Retained Earnings has zero
    await JEModel.create({
      journalType: 'GENERAL', state: 'posted', date: new Date('2025-01-01'),
      journalItems: [
        { account: cash._id, debit: 100000, credit: 0 },
        { account: shares._id, debit: 0, credit: 100000 },
      ],
      totalDebit: 100000, totalCredit: 100000,
    });

    const report = await generateBalanceSheet(
      { AccountModel, JournalEntryModel: JEModel, country: equityPack },
      { dateOption: 'month', dateValue: '2025-01' },
    );

    // Equity should NOT be pruned — it uses Object.values directly (no pruneGroups)
    // The Retained Earnings group should still be present
    expect(report.equity.groups.length).toBeGreaterThanOrEqual(1);

    const reGroup = report.equity.groups.find(g => g.name === 'Retained Earnings');
    expect(reGroup).toBeDefined();

    // Even though retained earnings are 0, the accounts should still be listed
    expect(reGroup!.accounts.length).toBeGreaterThanOrEqual(2);
  });
});
