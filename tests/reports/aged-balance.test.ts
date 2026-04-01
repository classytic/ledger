import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { generateAgedBalance } from '../../src/reports/aged-balance.js';
import type { AgedBucketConfig } from '../../src/reports/aged-balance.js';

// ── Test country pack ────────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'AGD', name: 'Aged Test', defaultCurrency: 'TST',
  retainedEarningsAccountCode: '3660',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '1200', name: 'Accounts Receivable', category: 'Balance Sheet-Asset', description: 'AR', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '1300', name: 'Other Receivable', category: 'Balance Sheet-Asset', description: 'Other AR', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '2000', name: 'Accounts Payable', category: 'Balance Sheet-Liability', description: 'AP', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '2100', name: 'Other Payable', category: 'Balance Sheet-Liability', description: 'Other AP', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '3000', name: 'Share Capital', category: 'Balance Sheet-Equity', description: 'Equity', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '3660', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '4000', name: 'Sales Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
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

let cashId: mongoose.Types.ObjectId;
let arId: mongoose.Types.ObjectId;
let otherArId: mongoose.Types.ObjectId;
let apId: mongoose.Types.ObjectId;
let otherApId: mongoose.Types.ObjectId;
let equityId: mongoose.Types.ObjectId;
let revenueId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const acctSchema = createAccountSchema(config);
  if (mongoose.models['AgedAccount']) delete mongoose.models['AgedAccount'];
  AccountModel = mongoose.model('AgedAccount', acctSchema);

  const jeSchema = createJournalEntrySchema(config, 'AgedAccount', {
    extraItemFields: { dueDate: { type: Date, default: null } },
  });
  if (mongoose.models['AgedJE']) delete mongoose.models['AgedJE'];
  JEModel = mongoose.model('AgedJE', jeSchema);

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

  const cash = await AccountModel.create({ accountTypeCode: '1000' });
  const ar = await AccountModel.create({ accountTypeCode: '1200' });
  const otherAr = await AccountModel.create({ accountTypeCode: '1300' });
  const ap = await AccountModel.create({ accountTypeCode: '2000' });
  const otherAp = await AccountModel.create({ accountTypeCode: '2100' });
  const eq = await AccountModel.create({ accountTypeCode: '3000' });
  const rev = await AccountModel.create({ accountTypeCode: '4000' });

  cashId = cash._id;
  arId = ar._id;
  otherArId = otherAr._id;
  apId = ap._id;
  otherApId = otherAp._id;
  equityId = eq._id;
  revenueId = rev._id;
});

/** Helper: create a posted journal entry with due dates on items */
async function postEntry(
  date: string,
  items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number; dueDate?: string | null }>,
) {
  return JEModel.create({
    journalType: 'GENERAL',
    state: 'posted',
    date: new Date(date),
    journalItems: items.map(i => ({
      account: i.account,
      debit: i.debit,
      credit: i.credit,
      dueDate: i.dueDate ? new Date(i.dueDate) : null,
    })),
    totalDebit: items.reduce((s, i) => s + i.debit, 0),
    totalCredit: items.reduce((s, i) => s + i.credit, 0),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Aged Balance Report', () => {
  const asOfDate = new Date('2025-06-15');

  describe('default buckets', () => {
    it('distributes balances into correct aging buckets', async () => {
      // Current (due Jun 1 = 14 days ago)
      await postEntry('2025-06-01', [
        { account: arId, debit: 10000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 10000 },
      ]);

      // 31-60 days (due May 1 = 45 days ago)
      await postEntry('2025-05-01', [
        { account: arId, debit: 20000, credit: 0, dueDate: '2025-05-01' },
        { account: revenueId, debit: 0, credit: 20000 },
      ]);

      // 61-90 days (due Apr 1 = 75 days ago)
      await postEntry('2025-04-01', [
        { account: arId, debit: 30000, credit: 0, dueDate: '2025-04-01' },
        { account: revenueId, debit: 0, credit: 30000 },
      ]);

      // 90+ days (due Feb 1 = 134 days ago)
      await postEntry('2025-02-01', [
        { account: arId, debit: 40000, credit: 0, dueDate: '2025-02-01' },
        { account: revenueId, debit: 0, credit: 40000 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      expect(report.bucketLabels).toEqual(['Current', '31-60', '61-90', '90+']);

      // AR account row (only AR has due-dated items; cash has none)
      const arRow = report.rows.find(r => String(r.accountId) === String(arId));
      expect(arRow).toBeDefined();
      expect(arRow!.buckets['Current']).toBe(10000);
      expect(arRow!.buckets['31-60']).toBe(20000);
      expect(arRow!.buckets['61-90']).toBe(30000);
      expect(arRow!.buckets['90+']).toBe(40000);
      expect(arRow!.total).toBe(100000);
    });
  });

  describe('custom bucket configuration', () => {
    it('uses custom buckets when provided', async () => {
      const customBuckets: AgedBucketConfig[] = [
        { label: '0-15', minDays: 0, maxDays: 16 },
        { label: '16-45', minDays: 16, maxDays: 46 },
        { label: '46+', minDays: 46, maxDays: Infinity },
      ];

      // 10 days past due
      await postEntry('2025-06-01', [
        { account: arId, debit: 5000, credit: 0, dueDate: '2025-06-05' },
        { account: revenueId, debit: 0, credit: 5000 },
      ]);

      // 30 days past due
      await postEntry('2025-05-15', [
        { account: arId, debit: 7000, credit: 0, dueDate: '2025-05-16' },
        { account: revenueId, debit: 0, credit: 7000 },
      ]);

      // 75 days past due
      await postEntry('2025-04-01', [
        { account: arId, debit: 9000, credit: 0, dueDate: '2025-04-01' },
        { account: revenueId, debit: 0, credit: 9000 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate, buckets: customBuckets },
      );

      expect(report.bucketLabels).toEqual(['0-15', '16-45', '46+']);

      const arRow = report.rows.find(r => String(r.accountId) === String(arId));
      expect(arRow).toBeDefined();
      expect(arRow!.buckets['0-15']).toBe(5000);
      expect(arRow!.buckets['16-45']).toBe(7000);
      expect(arRow!.buckets['46+']).toBe(9000);
    });
  });

  describe('type filtering', () => {
    it('receivable type filters to asset accounts only', async () => {
      // AR entry (asset)
      await postEntry('2025-06-01', [
        { account: arId, debit: 10000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 10000 },
      ]);

      // AP entry (liability) — should NOT appear in receivable report
      await postEntry('2025-06-01', [
        { account: apId, debit: 0, credit: 15000, dueDate: '2025-06-01' },
        { account: cashId, debit: 15000, credit: 0 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      const accountIds = report.rows.map(r => String(r.accountId));
      expect(accountIds).toContain(String(arId));
      expect(accountIds).not.toContain(String(apId));
    });

    it('payable type filters to liability accounts only', async () => {
      // AR entry (asset) — should NOT appear in payable report
      await postEntry('2025-06-01', [
        { account: arId, debit: 10000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 10000 },
      ]);

      // AP entry (liability)
      await postEntry('2025-06-01', [
        { account: apId, debit: 0, credit: 15000, dueDate: '2025-06-01' },
        { account: cashId, debit: 15000, credit: 0 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'payable', asOfDate },
      );

      const accountIds = report.rows.map(r => String(r.accountId));
      expect(accountIds).toContain(String(apId));
      expect(accountIds).not.toContain(String(arId));
    });
  });

  describe('specific accountIds filter', () => {
    it('only includes specified accounts', async () => {
      // Entry on AR
      await postEntry('2025-06-01', [
        { account: arId, debit: 10000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 10000 },
      ]);

      // Entry on Other AR
      await postEntry('2025-06-01', [
        { account: otherArId, debit: 20000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 20000 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate, accountIds: [arId] },
      );

      expect(report.rows.length).toBe(1);
      expect(String(report.rows[0].accountId)).toBe(String(arId));
      expect(report.rows[0].total).toBe(10000);
    });
  });

  describe('empty results', () => {
    it('returns empty report when no matching entries exist', async () => {
      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      expect(report.rows).toEqual([]);
      expect(report.grandTotal).toBe(0);
      expect(report.totals['Current']).toBe(0);
      expect(report.totals['31-60']).toBe(0);
      expect(report.totals['61-90']).toBe(0);
      expect(report.totals['90+']).toBe(0);
    });

    it('returns empty report when no accounts match the type', async () => {
      // Delete all liability accounts so payable has nothing
      await AccountModel.deleteMany({ accountTypeCode: { $in: ['2000', '2100'] } });

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'payable', asOfDate },
      );

      expect(report.rows).toEqual([]);
      expect(report.grandTotal).toBe(0);
    });
  });

  describe('sorting', () => {
    it('sorts rows by account code', async () => {
      // Entry on Other AR (code 1300)
      await postEntry('2025-06-01', [
        { account: otherArId, debit: 5000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 5000 },
      ]);

      // Entry on AR (code 1200)
      await postEntry('2025-06-01', [
        { account: arId, debit: 10000, credit: 0, dueDate: '2025-06-01' },
        { account: revenueId, debit: 0, credit: 10000 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      // Filter to only AR rows (cash may have zero balance and not appear)
      const arRows = report.rows.filter(r =>
        String(r.accountId) === String(arId) || String(r.accountId) === String(otherArId),
      );

      expect(arRows.length).toBe(2);
      expect(arRows[0].accountCode).toBe('1200');
      expect(arRows[1].accountCode).toBe('1300');
    });
  });

  describe('bucket totals', () => {
    it('computes correct totals per bucket across multiple accounts', async () => {
      // AR: current bucket
      await postEntry('2025-06-10', [
        { account: arId, debit: 10000, credit: 0, dueDate: '2025-06-10' },
        { account: revenueId, debit: 0, credit: 10000 },
      ]);

      // Other AR: current bucket
      await postEntry('2025-06-05', [
        { account: otherArId, debit: 15000, credit: 0, dueDate: '2025-06-05' },
        { account: revenueId, debit: 0, credit: 15000 },
      ]);

      // AR: 31-60 bucket
      await postEntry('2025-05-01', [
        { account: arId, debit: 20000, credit: 0, dueDate: '2025-05-01' },
        { account: revenueId, debit: 0, credit: 20000 },
      ]);

      // Other AR: 90+ bucket
      await postEntry('2025-01-01', [
        { account: otherArId, debit: 30000, credit: 0, dueDate: '2025-01-01' },
        { account: revenueId, debit: 0, credit: 30000 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      expect(report.totals['Current']).toBe(25000);   // 10000 + 15000
      expect(report.totals['31-60']).toBe(20000);
      expect(report.totals['61-90']).toBe(0);
      expect(report.totals['90+']).toBe(30000);
      expect(report.grandTotal).toBe(75000);
    });
  });

  describe('missing due dates', () => {
    it('treats missing due dates as current (0 days past due)', async () => {
      // Entry with no dueDate
      await postEntry('2025-06-01', [
        { account: arId, debit: 12000, credit: 0, dueDate: null },
        { account: revenueId, debit: 0, credit: 12000 },
      ]);

      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      const arRow = report.rows.find(r => String(r.accountId) === String(arId));
      expect(arRow).toBeDefined();
      expect(arRow!.buckets['Current']).toBe(12000);
      expect(arRow!.total).toBe(12000);
    });
  });

  describe('metadata', () => {
    it('includes correct metadata', async () => {
      const report = await generateAgedBalance(
        { AccountModel, JournalEntryModel: JEModel, country: testPack },
        { type: 'receivable', asOfDate },
      );

      expect(report.metadata.asOfDate).toBe('2025-06-15');
      expect(report.metadata.type).toBe('receivable');
      expect(report.metadata.generatedAt).toBeDefined();
    });
  });
});
