/**
 * Revaluation Report Integration Tests
 *
 * End-to-end tests using mongodb-memory-server to verify the full
 * revaluation pipeline: querying accounts, aggregating balances,
 * computing gains/losses, and creating journal entries.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { generateRevaluation } from '../../src/reports/revaluation.js';

// ── Test country pack ────────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'RV', name: 'Revaluation Test', defaultCurrency: 'CAD',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '1200', name: 'Accounts Receivable', category: 'Balance Sheet-Asset', description: 'AR', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '2000', name: 'Accounts Payable', category: 'Balance Sheet-Liability', description: 'AP', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '3000', name: 'Share Capital', category: 'Balance Sheet-Equity', description: 'Equity', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '4000', name: 'Sales Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '5000', name: 'Cost of Sales', category: 'Income Statement-Expense', description: 'COGS', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '7000', name: 'Unrealized FX Gain/Loss', category: 'Income Statement-Expense', description: 'FX', parentCode: null, isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
});

// ── Config with multi-currency enabled ───────────────────────────────────────

const config: AccountingEngineConfig = {
  country: testPack,
  currency: 'CAD',
  multiCurrency: { enabled: true, currencies: ['USD', 'EUR'] },
};

const multiTenantConfig: AccountingEngineConfig = {
  ...config,
  multiTenant: { orgField: 'business', orgRef: 'Business' },
};

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;
let MTAccountModel: mongoose.Model<any>;
let MTJEModel: mongoose.Model<any>;

// Account IDs
let cashId: mongoose.Types.ObjectId;
let arId: mongoose.Types.ObjectId;
let apId: mongoose.Types.ObjectId;
let equityId: mongoose.Types.ObjectId;
let revenueId: mongoose.Types.ObjectId;
let cogsId: mongoose.Types.ObjectId;
let fxGainLossId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Single-tenant models
  const acctSchema = createAccountSchema(config);
  if (mongoose.models['RvAccount']) delete mongoose.models['RvAccount'];
  AccountModel = mongoose.model('RvAccount', acctSchema);

  const jeSchema = createJournalEntrySchema(config, 'RvAccount');
  if (mongoose.models['RvJE']) delete mongoose.models['RvJE'];
  JEModel = mongoose.model('RvJE', jeSchema);

  // Multi-tenant models
  const mtAcctSchema = createAccountSchema(multiTenantConfig);
  if (mongoose.models['RvMTAccount']) delete mongoose.models['RvMTAccount'];
  MTAccountModel = mongoose.model('RvMTAccount', mtAcctSchema);

  const mtJeSchema = createJournalEntrySchema(multiTenantConfig, 'RvMTAccount');
  if (mongoose.models['RvMTJE']) delete mongoose.models['RvMTJE'];
  MTJEModel = mongoose.model('RvMTJE', mtJeSchema);

  await AccountModel.createIndexes();
  await JEModel.createIndexes();
  await MTAccountModel.createIndexes();
  await MTJEModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await JEModel.deleteMany({});
  await MTAccountModel.deleteMany({});
  await MTJEModel.deleteMany({});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed accounts: some with currency (foreign), some without */
async function seedAccounts() {
  const cash = await AccountModel.create({ accountTypeCode: '1000', accountNumber: '1001', name: 'USD Cash', currency: 'USD' });
  const ar = await AccountModel.create({ accountTypeCode: '1200', accountNumber: '1201', name: 'EUR Receivable', currency: 'EUR' });
  const ap = await AccountModel.create({ accountTypeCode: '2000', accountNumber: '2001', name: 'CAD Payable' }); // no currency = base
  const equity = await AccountModel.create({ accountTypeCode: '3000', accountNumber: '3001', name: 'Share Capital' });
  const revenue = await AccountModel.create({ accountTypeCode: '4000', accountNumber: '4001', name: 'Revenue', currency: 'USD' }); // P&L — should NOT be revalued
  const cogs = await AccountModel.create({ accountTypeCode: '5000', accountNumber: '5001', name: 'COGS' });
  const fxGL = await AccountModel.create({ accountTypeCode: '7000', accountNumber: '7001', name: 'Unrealized FX Gain/Loss' });

  cashId = cash._id;
  arId = ar._id;
  apId = ap._id;
  equityId = equity._id;
  revenueId = revenue._id;
  cogsId = cogs._id;
  fxGainLossId = fxGL._id;
}

/** Create a posted journal entry with multi-currency fields */
async function postEntry(
  date: string,
  items: Array<{
    account: mongoose.Types.ObjectId;
    debit: number;
    credit: number;
    originalDebit?: number;
    originalCredit?: number;
    currency?: string;
    exchangeRate?: number;
  }>,
  model = JEModel,
  extra: Record<string, unknown> = {},
) {
  return model.create({
    journalType: 'GENERAL',
    state: 'posted',
    date: new Date(date),
    journalItems: items,
    totalDebit: items.reduce((s, i) => s + i.debit, 0),
    totalCredit: items.reduce((s, i) => s + i.credit, 0),
    ...extra,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// REVALUATION REPORT
// ═════════════════════════════════════════════════════════════════════════════

describe('generateRevaluation', () => {
  it('shows gain when exchange rate increases', async () => {
    await seedAccounts();

    // Record: received 100 USD → 137 CAD at rate 1.37
    await postEntry('2026-03-15', [
      { account: cashId, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: equityId, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 13700, currency: 'CAD', exchangeRate: 1.0 },
    ]);

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.40 }],
        unrealizedGainLossAccountId: fxGainLossId,
      },
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0].gainLoss).toBe(300); // (10000 * 1.40) - 13700 = 300 gain
    expect(report.totalGainLoss).toBe(300);
    expect(report.metadata.baseCurrency).toBe('CAD');
  });

  it('shows loss when exchange rate decreases', async () => {
    await seedAccounts();

    await postEntry('2026-03-15', [
      { account: cashId, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: equityId, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 13700, currency: 'CAD', exchangeRate: 1.0 },
    ]);

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.30 }],
        unrealizedGainLossAccountId: fxGainLossId,
      },
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0].gainLoss).toBe(-700); // (10000 * 1.30) - 13700 = -700 loss
    expect(report.totalGainLoss).toBe(-700);
  });

  it('only revalues balance sheet accounts (not P&L)', async () => {
    await seedAccounts();

    // Post to USD Cash (balance sheet) and USD Revenue (income statement)
    await postEntry('2026-03-15', [
      { account: cashId, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: revenueId, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 10000, currency: 'USD', exchangeRate: 1.37 },
    ]);

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.50 }],
        unrealizedGainLossAccountId: fxGainLossId,
      },
    );

    // Only the cash account (BS) should appear, not revenue (P&L)
    expect(report.results).toHaveLength(1);
    expect(report.results[0].accountCode).toBe('1001');
  });

  it('creates a posted journal entry when generateEntry is true', async () => {
    await seedAccounts();

    await postEntry('2026-03-15', [
      { account: cashId, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: equityId, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 13700, currency: 'CAD', exchangeRate: 1.0 },
    ]);

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.40 }],
        unrealizedGainLossAccountId: fxGainLossId,
        generateEntry: true,
      },
    );

    expect(report.entryId).toBeDefined();

    // Verify the entry was saved
    const entry = await JEModel.findById(report.entryId).lean() as Record<string, unknown>;
    expect(entry).not.toBeNull();
    expect(entry.state).toBe('posted');
    expect(entry.label).toContain('revaluation');
  });

  it('generated entry is balanced (totalDebit === totalCredit)', async () => {
    await seedAccounts();

    // Two foreign-currency accounts
    await postEntry('2026-03-15', [
      { account: cashId, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: equityId, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 13700, currency: 'CAD', exchangeRate: 1.0 },
    ]);
    await postEntry('2026-03-20', [
      { account: arId, debit: 7500, credit: 0, originalDebit: 5000, originalCredit: 0, currency: 'EUR', exchangeRate: 1.50 },
      { account: equityId, debit: 0, credit: 7500, originalDebit: 0, originalCredit: 7500, currency: 'CAD', exchangeRate: 1.0 },
    ]);

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [
          { currency: 'USD', rate: 1.40 },
          { currency: 'EUR', rate: 1.55 },
        ],
        unrealizedGainLossAccountId: fxGainLossId,
        generateEntry: true,
      },
    );

    const entry = await JEModel.findById(report.entryId).lean() as Record<string, unknown>;
    expect(entry).not.toBeNull();
    expect(entry.totalDebit).toBe(entry.totalCredit);
    expect((entry.totalDebit as number)).toBeGreaterThan(0);
  });

  it('returns empty results when no foreign-currency accounts exist', async () => {
    // Seed only base-currency accounts
    await AccountModel.create({ accountTypeCode: '1000', accountNumber: '1001', name: 'CAD Cash' });

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.40 }],
        unrealizedGainLossAccountId: new mongoose.Types.ObjectId(),
      },
    );

    expect(report.results).toHaveLength(0);
    expect(report.totalGainLoss).toBe(0);
    expect(report.entryId).toBeUndefined();
  });

  it('does not create entry when generateEntry is false', async () => {
    await seedAccounts();

    await postEntry('2026-03-15', [
      { account: cashId, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: equityId, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 13700, currency: 'CAD', exchangeRate: 1.0 },
    ]);

    const countBefore = await JEModel.countDocuments({});

    const report = await generateRevaluation(
      { AccountModel, JournalEntryModel: JEModel, country: testPack, baseCurrency: 'CAD' },
      {
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.40 }],
        unrealizedGainLossAccountId: fxGainLossId,
        generateEntry: false,
      },
    );

    const countAfter = await JEModel.countDocuments({});
    expect(countAfter).toBe(countBefore);
    expect(report.entryId).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MULTI-TENANT SCOPING
// ═════════════════════════════════════════════════════════════════════════════

describe('multi-tenant scoping', () => {
  it('throws when orgField is set but organizationId is missing', async () => {
    await expect(
      generateRevaluation(
        {
          AccountModel: MTAccountModel,
          JournalEntryModel: MTJEModel,
          country: testPack,
          orgField: 'business',
          baseCurrency: 'CAD',
        },
        {
          asOfDate: new Date('2026-03-31'),
          rates: [{ currency: 'USD', rate: 1.40 }],
          unrealizedGainLossAccountId: new mongoose.Types.ObjectId(),
          // organizationId intentionally omitted
        },
      ),
    ).rejects.toThrow(/organizationId.*required/i);
  });

  it('scopes to the correct organization', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    // Create accounts for org A
    const cashA = await MTAccountModel.create({
      accountTypeCode: '1000', accountNumber: '1001', name: 'USD Cash A',
      currency: 'USD', business: orgA,
    });
    const equityA = await MTAccountModel.create({
      accountTypeCode: '3000', accountNumber: '3001', name: 'Equity A',
      business: orgA,
    });
    const fxA = await MTAccountModel.create({
      accountTypeCode: '7000', accountNumber: '7001', name: 'FX GL A',
      business: orgA,
    });

    // Create accounts for org B
    const cashB = await MTAccountModel.create({
      accountTypeCode: '1000', accountNumber: '1001', name: 'USD Cash B',
      currency: 'USD', business: orgB,
    });

    // Post entry for org A
    await postEntry('2026-03-15', [
      { account: cashA._id, debit: 13700, credit: 0, originalDebit: 10000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: equityA._id, debit: 0, credit: 13700, originalDebit: 0, originalCredit: 13700, currency: 'CAD', exchangeRate: 1.0 },
    ], MTJEModel, { business: orgA });

    // Post entry for org B
    await postEntry('2026-03-15', [
      { account: cashB._id, debit: 27400, credit: 0, originalDebit: 20000, originalCredit: 0, currency: 'USD', exchangeRate: 1.37 },
      { account: cashB._id, debit: 0, credit: 27400, originalDebit: 0, originalCredit: 20000, currency: 'USD', exchangeRate: 1.37 }, // dummy offset
    ], MTJEModel, { business: orgB });

    // Revalue for org A only
    const report = await generateRevaluation(
      {
        AccountModel: MTAccountModel,
        JournalEntryModel: MTJEModel,
        country: testPack,
        orgField: 'business',
        baseCurrency: 'CAD',
      },
      {
        organizationId: orgA,
        asOfDate: new Date('2026-03-31'),
        rates: [{ currency: 'USD', rate: 1.40 }],
        unrealizedGainLossAccountId: fxA._id,
      },
    );

    // Should only have org A's account
    expect(report.results).toHaveLength(1);
    expect(report.results[0].foreignBalance).toBe(10000);
    expect(report.results[0].gainLoss).toBe(300);
  });
});
