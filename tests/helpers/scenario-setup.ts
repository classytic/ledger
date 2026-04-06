/**
 * Shared Scenario Test Helpers
 *
 * Provides reusable setup for integration/scenario tests:
 * - In-memory MongoDB + engine creation
 * - Account seeding from a country pack
 * - Fluent entry builder for readable test code
 *
 * DX-first: tests using these helpers read like accounting narratives.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { defineCountryPack } from '../../src/country/index.js';
import { type AccountingEngine, createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

// ── Standard Test Chart of Accounts ───────────────────────────────────────

export const TEST_ACCOUNT_TYPES: readonly AccountType[] = [
  // Assets
  {
    code: '1000',
    name: 'Current Assets',
    category: 'Balance Sheet-Asset',
    description: 'Current Assets',
    parentCode: null,
    isGroup: true,
    cashFlowCategory: null,
  },
  {
    code: '1001',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: '1000',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1200',
    name: 'Accounts Receivable',
    category: 'Balance Sheet-Asset',
    description: 'AR',
    parentCode: '1000',
    isTotal: false,
    cashFlowCategory: 'Operating',
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

  // Liabilities
  {
    code: '2000',
    name: 'Current Liabilities',
    category: 'Balance Sheet-Liability',
    description: 'Current Liabilities',
    parentCode: null,
    isGroup: true,
    cashFlowCategory: null,
  },
  {
    code: '2001',
    name: 'Accounts Payable',
    category: 'Balance Sheet-Liability',
    description: 'AP',
    parentCode: '2000',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2300',
    name: 'Tax Payable',
    category: 'Balance Sheet-Liability',
    description: 'Tax',
    parentCode: '2000',
    isTotal: false,
    cashFlowCategory: 'Operating',
  },

  // Equity
  {
    code: '3000',
    name: 'Equity',
    category: 'Balance Sheet-Equity',
    description: 'Equity',
    parentCode: null,
    isGroup: true,
    cashFlowCategory: null,
  },
  {
    code: '3100',
    name: 'Share Capital',
    category: 'Balance Sheet-Equity',
    description: 'Shares',
    parentCode: '3000',
    isTotal: false,
    cashFlowCategory: 'Financing',
  },
  {
    code: '3600',
    name: 'Retained Earnings',
    category: 'Balance Sheet-Equity',
    description: 'RE',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },

  // Revenue
  {
    code: '4000',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: 'Revenue',
    parentCode: null,
    isGroup: true,
    cashFlowCategory: null,
  },
  {
    code: '4010',
    name: 'Service Revenue',
    category: 'Income Statement-Income',
    description: 'Service Revenue',
    parentCode: '4000',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '4020',
    name: 'Product Sales',
    category: 'Income Statement-Income',
    description: 'Product Sales',
    parentCode: '4000',
    isTotal: false,
    cashFlowCategory: null,
  },

  // Expenses
  {
    code: '5000',
    name: 'Cost of Sales',
    category: 'Income Statement-Expense',
    description: 'COGS',
    parentCode: null,
    isGroup: true,
    cashFlowCategory: null,
  },
  {
    code: '5010',
    name: 'COGS',
    category: 'Income Statement-Expense',
    description: 'COGS',
    parentCode: '5000',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6000',
    name: 'Operating Expenses',
    category: 'Income Statement-Expense',
    description: 'OpEx',
    parentCode: null,
    isGroup: true,
    cashFlowCategory: null,
  },
  {
    code: '6010',
    name: 'Rent',
    category: 'Income Statement-Expense',
    description: 'Rent',
    parentCode: '6000',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6020',
    name: 'Salaries',
    category: 'Income Statement-Expense',
    description: 'Salaries',
    parentCode: '6000',
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6030',
    name: 'Utilities',
    category: 'Income Statement-Expense',
    description: 'Utilities',
    parentCode: '6000',
    isTotal: false,
    cashFlowCategory: null,
  },
];

export const testPack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'USD',
  accountTypes: TEST_ACCOUNT_TYPES,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  retainedEarningsAccountCode: '3600',
  retainedEarningsDisplayCode: '3660',
  currentYearEarningsCode: '3680',
  cogsGroupCode: 'Cost of Sales',
});

// ── Scenario Engine ───────────────────────────────────────────────────────

export interface ScenarioEngine {
  mongod: MongoMemoryServer;
  engine: AccountingEngine;
  Account: mongoose.Model<any>;
  JE: mongoose.Model<any>;
  FP: mongoose.Model<any>;
  reports: AccountingEngine['reports'];
  acctIds: Record<string, mongoose.Types.ObjectId>;
}

let _counter = 0;

/**
 * Boot a fresh in-memory accounting engine with seeded accounts.
 * Call in beforeAll(). Returns everything needed for scenario tests.
 */
export async function setupScenario(
  configOverrides: Partial<Omit<AccountingEngineConfig, 'mongoose' | 'country' | 'currency'>> = {},
  modelPrefix = `Scn${++_counter}`,
): Promise<ScenarioEngine> {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Clear any pre-registered models with this prefix
  for (const n of [
    `${modelPrefix}Acct`,
    `${modelPrefix}JE`,
    `${modelPrefix}FP`,
    `${modelPrefix}Budget`,
    `${modelPrefix}Recon`,
  ]) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  const engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: testPack,
    currency: 'USD',
    retainedEarningsAccountCode: '3600',
    retainedEarningsDisplayCode: '3660',
    currentYearEarningsCode: '3680',
    modelNames: {
      account: `${modelPrefix}Acct`,
      journalEntry: `${modelPrefix}JE`,
      fiscalPeriod: `${modelPrefix}FP`,
      budget: `${modelPrefix}Budget`,
      reconciliation: `${modelPrefix}Recon`,
    },
    ...configOverrides,
  });

  await engine.models.Account.createIndexes();
  await engine.models.JournalEntry.createIndexes();

  // Seed all posting accounts
  const acctIds: Record<string, mongoose.Types.ObjectId> = {};
  for (const at of testPack.getPostingAccountTypes()) {
    const doc = await engine.models.Account.create({ accountTypeCode: at.code });
    acctIds[at.code] = doc._id as mongoose.Types.ObjectId;
  }

  return {
    mongod,
    engine,
    Account: engine.models.Account,
    JE: engine.models.JournalEntry,
    FP: engine.models.FiscalPeriod,
    reports: engine.reports,
    acctIds,
  };
}

export async function teardownScenario(s: ScenarioEngine) {
  await mongoose.disconnect();
  await s.mongod.stop();
}

// ── Fluent Entry Builder ──────────────────────────────────────────────────

type LineItem = { account: string; debit: number; credit: number };

/**
 * Post a balanced journal entry. Amounts in integer cents.
 *
 * @example
 * await postEntry(s, '2025-01-15', 'SALES', [
 *   { account: '1001', debit: 10000, credit: 0 },
 *   { account: '4010', debit: 0, credit: 10000 },
 * ]);
 */
export async function postEntry(
  s: ScenarioEngine,
  date: string,
  journalType: string,
  items: LineItem[],
  label?: string,
) {
  const journalItems = items.map((i) => ({
    account: s.acctIds[i.account],
    debit: i.debit,
    credit: i.credit,
  }));
  return s.JE.create({
    journalType,
    state: 'posted',
    date: new Date(date),
    label,
    journalItems,
    totalDebit: journalItems.reduce((sum, i) => sum + i.debit, 0),
    totalCredit: journalItems.reduce((sum, i) => sum + i.credit, 0),
  });
}

/**
 * Create a draft journal entry (not yet posted).
 */
export async function draftEntry(
  s: ScenarioEngine,
  date: string,
  journalType: string,
  items: LineItem[],
  label?: string,
) {
  const journalItems = items.map((i) => ({
    account: s.acctIds[i.account],
    debit: i.debit,
    credit: i.credit,
  }));
  return s.JE.create({
    journalType,
    state: 'draft',
    date: new Date(date),
    label,
    journalItems,
  });
}

// ── Assertion Helpers ─────────────────────────────────────────────────────

/**
 * Assert that total debits === total credits across ALL posted entries.
 * The fundamental conservation law of double-entry bookkeeping.
 */
export async function assertConservation(s: ScenarioEngine) {
  const result = await s.JE.aggregate([
    { $match: { state: 'posted' } },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: '$totalDebit' },
        totalCredit: { $sum: '$totalCredit' },
      },
    },
  ]);
  if (result.length === 0) return; // no entries yet
  const { totalDebit, totalCredit } = result[0];
  if (totalDebit !== totalCredit) {
    throw new Error(
      `Conservation violation: totalDebit=${totalDebit}, totalCredit=${totalCredit}, ` +
        `difference=${totalDebit - totalCredit}`,
    );
  }
}
