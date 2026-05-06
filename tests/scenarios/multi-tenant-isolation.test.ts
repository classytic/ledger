/**
 * Scenario: Multi-Tenant Isolation
 *
 * Two businesses — AlphaCorp and BetaLLC — share the same database.
 * Verifies that each tenant's data is completely isolated in
 * journal entries, reports, and account lookups.
 *
 * Beats Odoo's multi-company tests by proving report-level isolation
 * (not just record-level filtering).
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { testPack } from '../helpers/scenario-setup.js';
import { legacyBalanceSheet, legacyIncomeStatement, legacyTrialBalance } from '../helpers/legacy-report-view.js';

let mongod: MongoMemoryServer;
let engine: ReturnType<typeof createAccountingEngine>;
let Account: mongoose.Model<any>;
let JE: mongoose.Model<any>;
let reports: any;

const alphaOrg = new mongoose.Types.ObjectId();
const betaOrg = new mongoose.Types.ObjectId();
const alphaAccts: Record<string, mongoose.Types.ObjectId> = {};
const betaAccts: Record<string, mongoose.Types.ObjectId> = {};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const n of ['MtIso_Acct', 'MtIso_JE', 'MtIso_FP', 'MtIso_B', 'MtIso_R']) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  const config: AccountingEngineConfig = {
    mongoose: mongoose.connection,
    country: testPack,
    currency: 'USD',
    multiTenant: { tenantField: 'business', ref: 'Business' },
    retainedEarningsAccountCode: '3600',
    retainedEarningsDisplayCode: '3660',
    currentYearEarningsCode: '3680',
    modelNames: {
      account: 'MtIso_Acct',
      journalEntry: 'MtIso_JE',
      fiscalPeriod: 'MtIso_FP',
      budget: 'MtIso_B',
      reconciliation: 'MtIso_R',
    },
  };

  engine = createAccountingEngine(config);

  Account = engine.models.Account;
  JE = engine.models.JournalEntry;

  await Account.createIndexes();
  await JE.createIndexes();

  reports = engine.reports;

  // Seed accounts for both orgs
  for (const at of testPack.getPostingAccountTypes()) {
    const a = await Account.create({ accountTypeCode: at.code, business: alphaOrg });
    alphaAccts[at.code] = a._id;
    const b = await Account.create({ accountTypeCode: at.code, business: betaOrg });
    betaAccts[at.code] = b._id;
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function post(
  org: mongoose.Types.ObjectId,
  accts: Record<string, mongoose.Types.ObjectId>,
  date: string,
  items: Array<{ account: string; debit: number; credit: number }>,
) {
  const journalItems = items.map((i) => ({
    account: accts[i.account],
    debit: i.debit,
    credit: i.credit,
  }));
  return JE.create({
    journalType: 'GENERAL',
    state: 'posted',
    date: new Date(date),
    business: org,
    journalItems,
    totalDebit: journalItems.reduce((s, i) => s + i.debit, 0),
    totalCredit: journalItems.reduce((s, i) => s + i.credit, 0),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Both tenants post different amounts
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Tenant Operations', () => {
  it('AlphaCorp earns $100,000 revenue', async () => {
    await post(alphaOrg, alphaAccts, '2025-01-15', [
      { account: '1001', debit: 10_000_000, credit: 0 },
      { account: '4010', debit: 0, credit: 10_000_000 },
    ]);
  });

  it('BetaLLC earns $30,000 revenue', async () => {
    await post(betaOrg, betaAccts, '2025-01-20', [
      { account: '1001', debit: 3_000_000, credit: 0 },
      { account: '4010', debit: 0, credit: 3_000_000 },
    ]);
  });

  it('AlphaCorp pays $20,000 salaries', async () => {
    await post(alphaOrg, alphaAccts, '2025-01-31', [
      { account: '6020', debit: 2_000_000, credit: 0 },
      { account: '1001', debit: 0, credit: 2_000_000 },
    ]);
  });

  it('BetaLLC pays $5,000 rent', async () => {
    await post(betaOrg, betaAccts, '2025-01-31', [
      { account: '6010', debit: 500_000, credit: 0 },
      { account: '1001', debit: 0, credit: 500_000 },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Report Isolation — Each tenant sees only their own data
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Report Isolation', () => {
  it('AlphaCorp trial balance shows only Alpha data', async () => {
    const tb = await reports.trialBalance({
      dateOption: 'month',
      dateValue: '2025-01',
      organizationId: alphaOrg,
    });

    const totalDebit = legacyTrialBalance(tb).rows.reduce((sum: number, r: any) => sum + r.ending.debit, 0);
    const totalCredit = legacyTrialBalance(tb).rows.reduce((sum: number, r: any) => sum + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    // Alpha: Cash net (10M-2M)=8M debit + Salaries 2M debit = 10M
    // Credits: Revenue 10M = 10M  → balanced
    expect(totalDebit).toBe(10_000_000);
  });

  it('BetaLLC trial balance shows only Beta data', async () => {
    const tb = await reports.trialBalance({
      dateOption: 'month',
      dateValue: '2025-01',
      organizationId: betaOrg,
    });

    const totalDebit = legacyTrialBalance(tb).rows.reduce((sum: number, r: any) => sum + r.ending.debit, 0);
    const totalCredit = legacyTrialBalance(tb).rows.reduce((sum: number, r: any) => sum + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    // Beta: Cash net (3M-500K)=2.5M debit + Rent 500K debit = 3M
    // Credits: Revenue 3M = 3M → balanced
    expect(totalDebit).toBe(3_000_000);
  });

  it('AlphaCorp income statement shows $80K net income', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-01',
      organizationId: alphaOrg,
    });

    // Revenue $100K - Salaries $20K = $80K
    expect(legacyIncomeStatement(is).netIncome).toBe(8_000_000);
  });

  it('BetaLLC income statement shows $25K net income', async () => {
    const is = await reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-01',
      organizationId: betaOrg,
    });

    // Revenue $30K - Rent $5K = $25K
    expect(legacyIncomeStatement(is).netIncome).toBe(2_500_000);
  });

  it('AlphaCorp balance sheet isolated from Beta', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-01',
      organizationId: alphaOrg,
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    // Alpha total assets = Cash ($100K - $20K) = $80K = 8,000,000
    expect(legacyBalanceSheet(bs).summary.totalAssets).toBe(8_000_000);
  });

  it('BetaLLC balance sheet isolated from Alpha', async () => {
    const bs = await reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-01',
      organizationId: betaOrg,
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    // Beta total assets = Cash ($30K - $5K) = $25K = 2,500,000
    expect(legacyBalanceSheet(bs).summary.totalAssets).toBe(2_500_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Database-Level Isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Database-Level Isolation', () => {
  it('direct query with org filter returns only that org entries', async () => {
    const alphaEntries = await JE.countDocuments({ business: alphaOrg });
    const betaEntries = await JE.countDocuments({ business: betaOrg });
    const total = await JE.countDocuments({});

    expect(alphaEntries).toBe(2); // revenue + salaries
    expect(betaEntries).toBe(2); // revenue + rent
    expect(total).toBe(4);
  });

  it('accounts are scoped per org', async () => {
    const alphaAcctCount = await Account.countDocuments({ business: alphaOrg });
    const betaAcctCount = await Account.countDocuments({ business: betaOrg });

    expect(alphaAcctCount).toBe(betaAcctCount);
    expect(alphaAcctCount).toBe(testPack.getPostingAccountTypes().length);
  });
});
