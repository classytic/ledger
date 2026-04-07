/**
 * Integration tests — partner ledger report + credit limit plugin (0.6.0).
 *
 * Covers the building blocks for an ERP A/R + A/P workflow:
 *
 *   1. getOpenItems({ filter: { partnerId } }) returns only that partner's items
 *   2. getOpenItems({ asOfDate }) gives historical snapshots
 *   3. generatePartnerLedger opening balance from prior activity
 *   4. generatePartnerLedger running balance through period
 *   5. generatePartnerLedger excludes matched items when includeMatched: false
 *   6. generatePartnerLedger aged buckets at end-of-period
 *   7. creditLimitPlugin allows sales under the limit
 *   8. creditLimitPlugin blocks sales that breach the limit
 *   9. creditLimitPlugin counts existing exposure correctly
 *  10. creditLimitPlugin exempts reversals + FX entries
 *  11. creditLimitPlugin demands partnerId on every A/R debit
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import { creditLimitPlugin } from '../../src/plugins/credit-limit.plugin.js';
import { generatePartnerLedger } from '../../src/reports/partner-ledger.js';
import type { AccountType } from '../../src/types/core.js';
import { AccountingError } from '../../src/utils/errors.js';

const accountTypes: readonly AccountType[] = [
  { code: '1100', name: 'AR', category: 'Balance Sheet-Asset', description: 'AR control', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '2100', name: 'AP', category: 'Balance Sheet-Liability', description: 'AP control', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '1500', name: 'Inventory', category: 'Balance Sheet-Asset', description: 'Inventory', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
  { code: '5000', name: 'COGS', category: 'Income Statement-Expense', description: 'COGS', parentCode: null, isTotal: false, cashFlowCategory: null },
  { code: '3600', name: 'RE', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },
];

const pack = defineCountryPack({
  code: 'ERP',
  name: 'ERP test pack',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  retainedEarningsAccountCode: '3600',
});

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  for (const name of Object.keys(mongoose.models)) delete mongoose.models[name];
  for (const name of Object.keys(mongoose.connection.collections)) {
    await mongoose.connection.collections[name]?.deleteMany({});
  }
});

async function bootstrap() {
  const engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    schemaOptions: {
      journalEntry: {
        // Tag every journal item with a partnerId so the partner ledger
        // and credit-limit plugin can scope by it. This is the standard
        // way to wire subsidiary ledgers in @classytic/ledger 0.6.0.
        extraItemFields: {
          partnerId: { type: String, default: null, index: true },
        },
      },
    },
  });

  const accounts = await engine.repositories.accounts.bulkCreate([
    { accountTypeCode: '1100' }, // AR control
    { accountTypeCode: '2100' }, // AP control
    { accountTypeCode: '1000' }, // Cash
    { accountTypeCode: '1500' }, // Inventory
    { accountTypeCode: '4000' }, // Revenue
    { accountTypeCode: '5000' }, // COGS
  ] as never);

  return {
    engine,
    arId: (accounts.created[0] as { _id: unknown })._id,
    apId: (accounts.created[1] as { _id: unknown })._id,
    cashId: (accounts.created[2] as { _id: unknown })._id,
    inventoryId: (accounts.created[3] as { _id: unknown })._id,
    revenueId: (accounts.created[4] as { _id: unknown })._id,
    cogsId: (accounts.created[5] as { _id: unknown })._id,
  };
}

async function creditSale(
  engine: ReturnType<typeof createAccountingEngine>,
  arId: unknown,
  revenueId: unknown,
  partnerId: string,
  amount: number,
  date = new Date('2026-02-10'),
  maturityDate?: Date,
) {
  return engine.repositories.journalEntries.create({
    journalType: 'SALES',
    state: 'posted',
    date,
    label: `Credit sale to ${partnerId}`,
    journalItems: [
      { account: arId, debit: amount, credit: 0, partnerId, maturityDate },
      { account: revenueId, debit: 0, credit: amount },
    ],
  } as never) as unknown as { _id: unknown };
}

async function customerPayment(
  engine: ReturnType<typeof createAccountingEngine>,
  arId: unknown,
  cashId: unknown,
  partnerId: string,
  amount: number,
  date = new Date('2026-02-25'),
) {
  return engine.repositories.journalEntries.create({
    journalType: 'CASH_RECEIPTS',
    state: 'posted',
    date,
    label: `Payment from ${partnerId}`,
    journalItems: [
      { account: cashId, debit: amount, credit: 0 },
      { account: arId, debit: 0, credit: amount, partnerId },
    ],
  } as never) as unknown as { _id: unknown };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. getOpenItems with partner filter + asOfDate
// ═══════════════════════════════════════════════════════════════════════════

describe('getOpenItems — partner-scoped subsidiary ledger', () => {
  it('returns only the requested partner\'s open items', async () => {
    const { engine, arId, revenueId } = await bootstrap();

    await creditSale(engine, arId, revenueId, 'cust-A', 100_00);
    await creditSale(engine, arId, revenueId, 'cust-B', 250_00);
    await creditSale(engine, arId, revenueId, 'cust-A', 75_00, new Date('2026-02-15'));

    const itemsA = await engine.repositories.reconciliations.getOpenItems({
      accountId: arId,
      filter: { partnerId: 'cust-A' },
    });
    expect(itemsA).toHaveLength(2);
    expect(itemsA.every((i) => i.debit === 100_00 || i.debit === 75_00)).toBe(true);

    const itemsB = await engine.repositories.reconciliations.getOpenItems({
      accountId: arId,
      filter: { partnerId: 'cust-B' },
    });
    expect(itemsB).toHaveLength(1);
    expect(itemsB[0].debit).toBe(250_00);
  });

  it('respects asOfDate — historical open-item snapshot', async () => {
    const { engine, arId, revenueId } = await bootstrap();

    await creditSale(engine, arId, revenueId, 'cust-A', 100_00, new Date('2026-01-15'));
    await creditSale(engine, arId, revenueId, 'cust-A', 200_00, new Date('2026-03-15'));

    // As of Feb 1: only the January item exists
    const snapshot = await engine.repositories.reconciliations.getOpenItems({
      accountId: arId,
      filter: { partnerId: 'cust-A' },
      asOfDate: new Date('2026-02-01'),
    });
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].debit).toBe(100_00);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. generatePartnerLedger
// ═══════════════════════════════════════════════════════════════════════════

describe('generatePartnerLedger — supplier/customer statement', () => {
  it('computes opening balance, running balance, and aged buckets', async () => {
    const { engine, arId, revenueId, cashId } = await bootstrap();

    // Prior period: $1000 sale, $300 payment → opening = 700
    await creditSale(engine, arId, revenueId, 'cust-X', 1_000_00, new Date('2025-12-10'));
    await customerPayment(engine, arId, cashId, 'cust-X', 300_00, new Date('2025-12-20'));

    // In-period: $500 sale, $200 payment
    await creditSale(engine, arId, revenueId, 'cust-X', 500_00, new Date('2026-02-05'),
      new Date('2026-01-05')); // intentionally past due
    await customerPayment(engine, arId, cashId, 'cust-X', 200_00, new Date('2026-02-15'));

    const statement = await generatePartnerLedger(
      {
        AccountModel: engine.models.Account,
        JournalEntryModel: engine.models.JournalEntry,
      },
      {
        controlAccountId: arId,
        partnerId: 'cust-X',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
      },
    );

    expect(statement.openingBalance).toBe(700_00);
    // Period delta: +500 - 200 = +300; closing = 700 + 300 = 1000
    expect(statement.closingBalance).toBe(1_000_00);
    expect(statement.lines).toHaveLength(2);
    expect(statement.lines[0].balance).toBe(1_200_00); // after +500
    expect(statement.lines[1].balance).toBe(1_000_00); // after -200

    // The +500 sale was due Jan 5, end-of-period is Mar 31 → ~85 days past due
    // → falls in '61-90' bucket
    expect(statement.agedBuckets['61-90']).toBe(500_00);
    expect(statement.openItemsTotal).toBe(300_00); // 500 sale - 200 pay (both unmatched)
  });

  it('omits matched items when includeMatched: false', async () => {
    const { engine, arId, revenueId, cashId } = await bootstrap();

    const inv = await creditSale(engine, arId, revenueId, 'cust-Y', 400_00);
    const pay = await customerPayment(engine, arId, cashId, 'cust-Y', 400_00);
    await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    });

    const openOnly = await generatePartnerLedger(
      { AccountModel: engine.models.Account, JournalEntryModel: engine.models.JournalEntry },
      {
        controlAccountId: arId,
        partnerId: 'cust-Y',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
        includeMatched: false,
      },
    );
    expect(openOnly.lines).toHaveLength(0);
    expect(openOnly.closingBalance).toBe(0);

    const withMatched = await generatePartnerLedger(
      { AccountModel: engine.models.Account, JournalEntryModel: engine.models.JournalEntry },
      {
        controlAccountId: arId,
        partnerId: 'cust-Y',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
      },
    );
    expect(withMatched.lines).toHaveLength(2);
    expect(withMatched.matchedTotal).toBe(0); // sale +400, pay -400, net = 0
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. creditLimitPlugin
// ═══════════════════════════════════════════════════════════════════════════

describe('creditLimitPlugin', () => {
  function withCreditLimit(
    engine: ReturnType<typeof createAccountingEngine>,
    arId: unknown,
    limits: Record<string, number | null>,
  ) {
    creditLimitPlugin({
      arControlAccountId: arId,
      JournalEntryModel: engine.models.JournalEntry,
      getCreditLimit: (partnerId) => limits[String(partnerId)] ?? null,
    }).apply(engine.repositories.journalEntries);
  }

  it('allows a sale comfortably under the limit', async () => {
    const { engine, arId, revenueId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-Z': 1_000_00 });

    await expect(creditSale(engine, arId, revenueId, 'cust-Z', 500_00)).resolves.toBeDefined();
  });

  it('blocks a single sale that exceeds the limit', async () => {
    const { engine, arId, revenueId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-Z': 1_000_00 });

    try {
      await creditSale(engine, arId, revenueId, 'cust-Z', 1_500_00);
      throw new Error('expected credit limit to fire');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingError);
      expect((err as AccountingError).code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect((err as AccountingError).status).toBe(402);
    }
  });

  it('blocks the next sale when cumulative exposure exceeds the limit', async () => {
    const { engine, arId, revenueId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-Z': 1_000_00 });

    await creditSale(engine, arId, revenueId, 'cust-Z', 700_00);
    await expect(creditSale(engine, arId, revenueId, 'cust-Z', 400_00)).rejects.toMatchObject({
      code: 'CREDIT_LIMIT_EXCEEDED',
    });
  });

  it('allows the same sale after a payment frees up headroom', async () => {
    const { engine, arId, revenueId, cashId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-Z': 1_000_00 });

    const inv1 = await creditSale(engine, arId, revenueId, 'cust-Z', 800_00);
    // 800 outstanding, 200 free → next 400 should fail
    await expect(creditSale(engine, arId, revenueId, 'cust-Z', 400_00)).rejects.toMatchObject({
      code: 'CREDIT_LIMIT_EXCEEDED',
    });
    // But after a 600 payment matched against the invoice, headroom = 800
    const pay = await customerPayment(engine, arId, cashId, 'cust-Z', 600_00);
    await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv1._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    });
    await expect(creditSale(engine, arId, revenueId, 'cust-Z', 400_00)).resolves.toBeDefined();
  });

  it('exempts reversals (which use _ledgerInternal=reverseMark)', async () => {
    const { engine, arId, revenueId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-Z': 1_000_00 });

    const inv = await creditSale(engine, arId, revenueId, 'cust-Z', 900_00);
    // 900 outstanding, 100 free. Reverse should NOT trip the limit even
    // though the reversal mark on the original is an internal update.
    await expect(
      engine.repositories.journalEntries.reverse(inv._id),
    ).resolves.toBeDefined();
  });

  it('demands a partnerId on every A/R debit', async () => {
    const { engine, arId, revenueId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-Z': 1_000_00 });

    await expect(
      engine.repositories.journalEntries.create({
        journalType: 'SALES',
        state: 'posted',
        date: new Date('2026-02-10'),
        journalItems: [
          { account: arId, debit: 100_00, credit: 0 }, // missing partnerId
          { account: revenueId, debit: 0, credit: 100_00 },
        ],
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('skips entirely when getCreditLimit returns null (unlimited partner)', async () => {
    const { engine, arId, revenueId } = await bootstrap();
    withCreditLimit(engine, arId, { 'cust-VIP': null });

    await expect(creditSale(engine, arId, revenueId, 'cust-VIP', 999_999_00)).resolves.toBeDefined();
  });
});
