/**
 * E2E Scenario: NorthStar Exports Ltd.
 *
 * A Canadian company (base currency CAD) trading in USD and EUR.
 * Tests the full multi-currency lifecycle: foreign transactions,
 * trial balance verification, FX revaluation, entry generation,
 * and balance sheet integrity.
 *
 * All monetary values are integer cents.
 * Exchange rates are decimals (1.35 means 1 USD = 1.35 CAD).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

// ── Test Country Pack ────────────────────────────────────────────────────────

const northstarPack = defineCountryPack({
  code: 'NS',
  name: 'NorthStar Test',
  defaultCurrency: 'CAD',
  retainedEarningsAccountCode: '3600',
  accountTypes: [
    { code: '1000', name: 'Cash CAD', category: 'Balance Sheet-Asset', description: 'Cash in CAD', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
    { code: '1010', name: 'Cash USD', category: 'Balance Sheet-Asset', description: 'Cash in USD', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
    { code: '1020', name: 'Cash EUR', category: 'Balance Sheet-Asset', description: 'Cash in EUR', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
    { code: '1200', name: 'Accounts Receivable USD', category: 'Balance Sheet-Asset', description: 'AR in USD', parentCode: null, isTotal: false },
    { code: '2000', name: 'Accounts Payable EUR', category: 'Balance Sheet-Liability', description: 'AP in EUR', parentCode: null, isTotal: false },
    { code: '3500', name: 'Common Shares', category: 'Balance Sheet-Equity', description: 'Share capital', parentCode: null, isTotal: false },
    { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false },
    { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Service revenue', parentCode: null, isTotal: false },
    { code: '5000', name: 'Expenses', category: 'Income Statement-Expense', description: 'Operating expenses', parentCode: null, isTotal: false },
    { code: '7000', name: 'Unrealized FX Gain/Loss', category: 'Income Statement-Income', description: 'Unrealized foreign exchange gain/loss', parentCode: null, isTotal: false },
  ],
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

// ── Engine Config ────────────────────────────────────────────────────────────

const config: AccountingEngineConfig = {
  country: northstarPack,
  currency: 'CAD',
  multiCurrency: { enabled: true, currencies: ['USD', 'EUR'] },
  retainedEarningsAccountCode: '3600',
};

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;
let engine: ReturnType<typeof createAccountingEngine>;

// Account IDs
let cashCADId: mongoose.Types.ObjectId;
let cashUSDId: mongoose.Types.ObjectId;
let cashEURId: mongoose.Types.ObjectId;
let arUSDId: mongoose.Types.ObjectId;
let apEURId: mongoose.Types.ObjectId;
let sharesId: mongoose.Types.ObjectId;
let reId: mongoose.Types.ObjectId;
let revenueId: mongoose.Types.ObjectId;
let expensesId: mongoose.Types.ObjectId;
let fxGainLossId: mongoose.Types.ObjectId;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function postEntry(
  date: string,
  items: Array<{
    account: mongoose.Types.ObjectId;
    debit: number;
    credit: number;
    currency?: string;
    exchangeRate?: number;
    originalDebit: number;
    originalCredit: number;
  }>,
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

// ═════════════════════════════════════════════════════════════════════════════
// E2E SCENARIO: NorthStar Exports Ltd.
// ═════════════════════════════════════════════════════════════════════════════

describe('NorthStar Exports Ltd. — Multi-Currency Revaluation E2E', () => {
  // Shared setup for the entire scenario — keeps DB alive across all describe blocks
  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    engine = createAccountingEngine(config);

    // Clean up any prior model registrations
    for (const name of ['NsAccount', 'NsJE']) {
      if (mongoose.models[name]) delete mongoose.models[name];
    }

    const acctSchema = createAccountSchema(config);
    AccountModel = mongoose.model('NsAccount', acctSchema);

    const jeSchema = createJournalEntrySchema(config, 'NsAccount');
    JEModel = mongoose.model('NsJE', jeSchema);

    await AccountModel.createIndexes();
    await JEModel.createIndexes();

    // Seed accounts
    const cashCAD = await AccountModel.create({ accountTypeCode: '1000', accountNumber: '1000', name: 'Cash CAD' });
    const cashUSD = await AccountModel.create({ accountTypeCode: '1010', accountNumber: '1010', name: 'Cash USD', currency: 'USD' });
    const cashEUR = await AccountModel.create({ accountTypeCode: '1020', accountNumber: '1020', name: 'Cash EUR', currency: 'EUR' });
    const arUSD = await AccountModel.create({ accountTypeCode: '1200', accountNumber: '1200', name: 'AR USD', currency: 'USD' });
    const apEUR = await AccountModel.create({ accountTypeCode: '2000', accountNumber: '2000', name: 'AP EUR', currency: 'EUR' });
    const shares = await AccountModel.create({ accountTypeCode: '3500', accountNumber: '3500', name: 'Common Shares' });
    const re = await AccountModel.create({ accountTypeCode: '3600', accountNumber: '3600', name: 'Retained Earnings' });
    const revenue = await AccountModel.create({ accountTypeCode: '4000', accountNumber: '4000', name: 'Revenue' });
    const expenses = await AccountModel.create({ accountTypeCode: '5000', accountNumber: '5000', name: 'Expenses' });
    const fxGL = await AccountModel.create({ accountTypeCode: '7000', accountNumber: '7000', name: 'Unrealized FX Gain/Loss' });

    cashCADId = cashCAD._id;
    cashUSDId = cashUSD._id;
    cashEURId = cashEUR._id;
    arUSDId = arUSD._id;
    apEURId = apEUR._id;
    sharesId = shares._id;
    reId = re._id;
    revenueId = revenue._id;
    expensesId = expenses._id;
    fxGainLossId = fxGL._id;

    // Seed initial equity: owner invested $50,000 CAD
    await postEntry('2026-01-01', [
      { account: cashCADId, debit: 5_000_000, credit: 0, originalDebit: 5_000_000, originalCredit: 0 },
      { account: sharesId, debit: 0, credit: 5_000_000, originalDebit: 0, originalCredit: 5_000_000 },
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  // ── 1. Setup — Multi-Currency Engine ────────────────────────────────────

  describe('Setup — Multi-Currency Engine', () => {
    it('creates engine with multi-currency config', () => {
      expect(engine.currency).toBe('CAD');
      expect(engine.config.multiCurrency?.enabled).toBe(true);
      expect(engine.config.multiCurrency?.currencies).toContain('USD');
      expect(engine.config.multiCurrency?.currencies).toContain('EUR');
    });

    it('seeds all required accounts', async () => {
      const count = await AccountModel.countDocuments({});
      expect(count).toBe(10);
    });

    it('foreign-currency accounts have the currency field set', async () => {
      const usdCash = await AccountModel.findById(cashUSDId).lean() as Record<string, unknown>;
      expect(usdCash.currency).toBe('USD');

      const eurCash = await AccountModel.findById(cashEURId).lean() as Record<string, unknown>;
      expect(eurCash.currency).toBe('EUR');
    });

    it('base-currency accounts do not have a currency field', async () => {
      const cadCash = await AccountModel.findById(cashCADId).lean() as Record<string, unknown>;
      expect(cadCash.currency).toBeNull();
    });
  });

  // ── 2. Foreign Currency Transactions ────────────────────────────────────

  describe('Foreign Currency Transactions', () => {
    // Transaction 1: Sell services to US client — $10,000 USD at rate 1.35 = $13,500 CAD
    // Dr AR USD 13,500 (originalDebit: 10,000 USD), Cr Revenue 13,500

    it('records USD sale at historical rate 1.35', async () => {
      await postEntry('2026-03-01', [
        {
          account: arUSDId,
          debit: 1_350_000, credit: 0,
          currency: 'USD', exchangeRate: 1.35,
          originalDebit: 1_000_000, originalCredit: 0,
        },
        {
          account: revenueId,
          debit: 0, credit: 1_350_000,
          originalDebit: 0, originalCredit: 1_350_000,
        },
      ]);

      const entries = await JEModel.find({ date: new Date('2026-03-01') }).lean() as Array<Record<string, unknown>>;
      const saleEntry = entries.find(e => (e.journalItems as any[]).some(
        (i: any) => String(i.account) === String(arUSDId) && i.debit === 1_350_000,
      ));
      expect(saleEntry).toBeDefined();
    });

    // Transaction 2: Receive USD payment — Dr Cash USD 13,500, Cr AR USD 13,500
    it('records USD payment receipt', async () => {
      await postEntry('2026-03-10', [
        {
          account: cashUSDId,
          debit: 1_350_000, credit: 0,
          currency: 'USD', exchangeRate: 1.35,
          originalDebit: 1_000_000, originalCredit: 0,
        },
        {
          account: arUSDId,
          debit: 0, credit: 1_350_000,
          currency: 'USD', exchangeRate: 1.35,
          originalDebit: 0, originalCredit: 1_000_000,
        },
      ]);

      // AR USD should now be zeroed out (received full payment)
      const arBalanceResult = await JEModel.aggregate([
        { $match: { state: 'posted' } },
        { $unwind: '$journalItems' },
        { $match: { 'journalItems.account': arUSDId } },
        { $group: { _id: null, d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
      ]);
      expect(arBalanceResult).toHaveLength(1);
      expect(arBalanceResult[0].d).toBe(arBalanceResult[0].c); // AR is zero
    });

    // Transaction 3: Buy supplies from EU vendor — 5,000 EUR at rate 1.47 = $7,350 CAD
    // Dr Expenses 7,350, Cr AP EUR 7,350 (originalCredit: 5,000 EUR)
    it('records EUR purchase at historical rate 1.47', async () => {
      await postEntry('2026-03-15', [
        {
          account: expensesId,
          debit: 735_000, credit: 0,
          originalDebit: 735_000, originalCredit: 0,
        },
        {
          account: apEURId,
          debit: 0, credit: 735_000,
          currency: 'EUR', exchangeRate: 1.47,
          originalDebit: 0, originalCredit: 500_000,
        },
      ]);

      // AP EUR should have a credit balance of 735,000 (liability)
      const apResult = await JEModel.aggregate([
        { $match: { state: 'posted' } },
        { $unwind: '$journalItems' },
        { $match: { 'journalItems.account': apEURId } },
        { $group: { _id: null, d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
      ]);
      expect(apResult).toHaveLength(1);
      expect(apResult[0].c - apResult[0].d).toBe(735_000);
    });

    it('trial balance in base currency (CAD) is balanced', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const tb = await reports.trialBalance({
        dateOption: 'year',
        dateValue: 2026,
      });

      // Sum all ending debits and credits
      let totalDebit = 0;
      let totalCredit = 0;
      for (const row of tb.rows) {
        totalDebit += row.ending.debit;
        totalCredit += row.ending.credit;
      }

      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBeGreaterThan(0);
    });
  });

  // ── 3. Exchange Rate Revaluation ────────────────────────────────────────

  describe('Exchange Rate Revaluation', () => {
    // New rates: USD 1.35 -> 1.40 (USD strengthened), EUR 1.47 -> 1.45 (EUR weakened)
    //
    // Cash USD: foreign balance = 10,000 USD (1,000,000 cents)
    //   Historical base: 1,350,000 cents CAD
    //   Revalued: 1,000,000 * 1.40 = 1,400,000 cents CAD
    //   Gain: +50,000 cents (USD strengthened, asset worth more in CAD)
    //
    // AR USD: foreign balance = 0 (paid in full) — no revaluation needed
    //
    // AP EUR: foreign balance = -5,000 EUR (-500,000 cents, net debit - credit)
    //   originalDebit - originalCredit = 0 - 500,000 = -500,000 (net foreign)
    //   Historical base (debit - credit): 0 - 735,000 = -735,000
    //   Revalued: -500,000 * 1.45 = -725,000
    //   gainLoss = -725,000 - (-735,000) = +10,000 (EUR weakened, liability cheaper = gain)

    it('computes gain on USD assets when USD strengthens', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const report = await reports.revaluation({
        asOfDate: new Date('2026-03-31'),
        rates: [
          { currency: 'USD', rate: 1.40 },
          { currency: 'EUR', rate: 1.45 },
        ],
        unrealizedGainLossAccountId: fxGainLossId,
      });

      const usdResult = report.results.find(r => r.currency === 'USD');
      expect(usdResult).toBeDefined();
      // Cash USD: revalued 1,000,000 * 1.40 = 1,400,000; historical = 1,350,000; gain = 50,000
      expect(usdResult!.foreignBalance).toBe(1_000_000);
      expect(usdResult!.historicalBase).toBe(1_350_000);
      expect(usdResult!.revaluedBase).toBe(1_400_000);
      expect(usdResult!.gainLoss).toBe(50_000);
    });

    it('computes gain on EUR liabilities when EUR weakens', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const report = await reports.revaluation({
        asOfDate: new Date('2026-03-31'),
        rates: [
          { currency: 'USD', rate: 1.40 },
          { currency: 'EUR', rate: 1.45 },
        ],
        unrealizedGainLossAccountId: fxGainLossId,
      });

      const eurResult = report.results.find(r => r.currency === 'EUR');
      expect(eurResult).toBeDefined();
      // AP EUR: foreignBalance = 0 - 500,000 = -500,000
      // historicalBase = 0 - 735,000 = -735,000
      // revaluedBase = -500,000 * 1.45 = -725,000
      // gainLoss = -725,000 - (-735,000) = +10,000 (gain — liability decreased)
      expect(eurResult!.foreignBalance).toBe(-500_000);
      expect(eurResult!.historicalBase).toBe(-735_000);
      expect(eurResult!.revaluedBase).toBe(-725_000);
      expect(eurResult!.gainLoss).toBe(10_000);
    });

    it('computes correct total gain/loss across all currencies', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const report = await reports.revaluation({
        asOfDate: new Date('2026-03-31'),
        rates: [
          { currency: 'USD', rate: 1.40 },
          { currency: 'EUR', rate: 1.45 },
        ],
        unrealizedGainLossAccountId: fxGainLossId,
      });

      // USD gain: 50,000 + EUR gain: 10,000 = total 60,000
      expect(report.totalGainLoss).toBe(60_000);
      expect(report.metadata.baseCurrency).toBe('CAD');
    });

    it('excludes accounts with zero gain/loss from results', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const report = await reports.revaluation({
        asOfDate: new Date('2026-03-31'),
        rates: [
          { currency: 'USD', rate: 1.40 },
          { currency: 'EUR', rate: 1.45 },
        ],
        unrealizedGainLossAccountId: fxGainLossId,
      });

      // AR USD is zeroed out, so it should not appear
      const arResult = report.results.find(r => r.accountCode === '1200');
      expect(arResult).toBeUndefined();
    });
  });

  // ── 4. Revaluation Entry Generation ─────────────────────────────────────

  describe('Revaluation Entry Generation', () => {
    let revalEntryId: unknown;

    it('creates a journal entry when generateEntry is true', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const report = await reports.revaluation({
        asOfDate: new Date('2026-03-31'),
        rates: [
          { currency: 'USD', rate: 1.40 },
          { currency: 'EUR', rate: 1.45 },
        ],
        unrealizedGainLossAccountId: fxGainLossId,
        generateEntry: true,
      });

      expect(report.entryId).toBeDefined();
      revalEntryId = report.entryId;

      const entry = await JEModel.findById(revalEntryId).lean() as Record<string, unknown>;
      expect(entry).not.toBeNull();
      expect(entry.state).toBe('posted');
      expect(entry.label).toContain('revaluation');
    });

    it('generated entry is balanced (totalDebit === totalCredit)', async () => {
      expect(revalEntryId).toBeDefined();
      const entry = await JEModel.findById(revalEntryId).lean() as Record<string, unknown>;
      expect(entry).not.toBeNull();
      expect(entry.totalDebit).toBe(entry.totalCredit);
      // Total should be 50,000 (USD gain) + 10,000 (EUR gain) = 60,000
      expect(entry.totalDebit).toBe(60_000);
    });

    it('unrealized FX gain/loss account receives the offsetting entries', async () => {
      // Aggregate the Unrealized FX Gain/Loss account balance from ALL entries
      const fxResult = await JEModel.aggregate([
        { $match: { state: 'posted' } },
        { $unwind: '$journalItems' },
        { $match: { 'journalItems.account': fxGainLossId } },
        { $group: { _id: null, d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
      ]);

      expect(fxResult).toHaveLength(1);
      // Both gains -> credited to FX account (income account, credit = increase)
      // USD gain 50,000 credit + EUR gain 10,000 credit = 60,000 net credit
      expect(fxResult[0].c - fxResult[0].d).toBe(60_000);
    });

    it('balance sheet still balances after revaluation entry', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const bs = await reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2026,
      });

      expect(bs.summary.isBalanced).toBe(true);
      expect(bs.summary.difference).toBe(0);
    });
  });

  // ── 5. Balance Sheet in Base Currency ───────────────────────────────────

  describe('Balance Sheet in Base Currency', () => {
    it('generates balance sheet with all amounts in CAD', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const bs = await reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2026,
        businessName: 'NorthStar Exports Ltd.',
      });

      expect(bs.metadata.businessName).toBe('NorthStar Exports Ltd.');
      // All values should be integers (cents)
      expect(Number.isInteger(bs.summary.totalAssets)).toBe(true);
      expect(Number.isInteger(bs.summary.totalLiabilities)).toBe(true);
      expect(Number.isInteger(bs.summary.totalEquity)).toBe(true);
    });

    it('Assets = Liabilities + Equity', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const bs = await reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2026,
      });

      expect(bs.summary.totalAssets).toBe(bs.summary.liabilitiesAndEquity);
      expect(bs.summary.isBalanced).toBe(true);

      // Verify the actual amounts:
      // Assets:
      //   Cash CAD: 5,000,000 (initial investment)
      //   Cash USD: 1,350,000 (historical) + 50,000 (reval gain) = 1,400,000
      //   Cash EUR: 0
      //   AR USD: 0
      //   Total Assets = 5,000,000 + 1,400,000 = 6,400,000
      expect(bs.summary.totalAssets).toBe(6_400_000);

      // Liabilities:
      //   AP EUR: 735,000 (historical) - 10,000 (reval gain reduces liability) = 725,000
      //   Total Liabilities = 725,000
      expect(bs.summary.totalLiabilities).toBe(725_000);

      // Equity:
      //   Shares: 5,000,000
      //   Net Income: Revenue 1,350,000 - Expenses 735,000 + FX Gain 60,000 = 675,000
      //   Total Equity = 5,000,000 + 675,000 = 5,675,000
      expect(bs.summary.totalEquity).toBe(5_675_000);

      // A = L + E: 6,400,000 = 725,000 + 5,675,000
      expect(bs.summary.totalAssets).toBe(725_000 + 5_675_000);
    });

    it('unrealized FX gain/loss is reflected in equity via net income', async () => {
      const reports = engine.createReports({ Account: AccountModel, JournalEntry: JEModel });
      const bs = await reports.balanceSheet({
        dateOption: 'year',
        dateValue: 2026,
      });

      // Find the current year net income in equity
      let currentYearNetIncome = 0;
      for (const group of bs.equity.groups) {
        for (const acct of group.accounts) {
          if (acct.id === 'current-year') {
            currentYearNetIncome = acct.balance;
          }
        }
      }

      // Net Income = Revenue (1,350,000) - Expenses (735,000) + Unrealized FX Gain (60,000)
      // Note: FX Gain/Loss is Income Statement-Income, so it adds to net income
      expect(currentYearNetIncome).toBe(675_000);
    });
  });
});
