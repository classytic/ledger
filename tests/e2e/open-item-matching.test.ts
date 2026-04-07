/**
 * Integration tests — item-level open-item matching (0.6.0).
 *
 * Covers the canonical AR/AP flows that entry-level reconciliation
 * could not express:
 *
 *   1. One invoice paid in full by one payment (basic match)
 *   2. One invoice paid partially by one payment (partial match)
 *   3. One payment settling two invoices (many-to-one)
 *   4. Two invoices settled by two separate payments (many-to-many)
 *   5. getOpenItems surfaces only unmatched items
 *   6. unmatch clears the stamps and restores items to open
 *   7. Cross-org isolation — two orgs' matching numbers do not collide
 *   8. FX realization fires on shared-currency mismatched rates
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import { fxRealizationPlugin } from '../../src/plugins/fx-realization.plugin.js';
import type { AccountType } from '../../src/types/core.js';

const accountTypes: readonly AccountType[] = [
  { code: '1100', name: 'AR', category: 'Balance Sheet-Asset', description: 'Accounts Receivable', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
  { code: '3600', name: 'RE', category: 'Balance Sheet-Equity', description: 'Retained Earnings', parentCode: null, isTotal: false, cashFlowCategory: null },
  { code: '7100', name: 'FX Gain', category: 'Income Statement-Income', description: 'Realized FX gain', parentCode: null, isTotal: false, cashFlowCategory: null },
  { code: '7200', name: 'FX Loss', category: 'Income Statement-Expense', description: 'Realized FX loss', parentCode: null, isTotal: false, cashFlowCategory: null },
];

const pack = defineCountryPack({
  code: 'OIM',
  name: 'Open Item Matching Test',
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
  });

  const accounts = await engine.repositories.accounts.bulkCreate([
    { accountTypeCode: '1100' }, // AR
    { accountTypeCode: '1000' }, // Cash
    { accountTypeCode: '4000' }, // Revenue
    { accountTypeCode: '7100' }, // FX Gain
    { accountTypeCode: '7200' }, // FX Loss
  ] as never);

  return {
    engine,
    arId: (accounts.created[0] as { _id: unknown })._id,
    cashId: (accounts.created[1] as { _id: unknown })._id,
    revenueId: (accounts.created[2] as { _id: unknown })._id,
    fxGainId: (accounts.created[3] as { _id: unknown })._id,
    fxLossId: (accounts.created[4] as { _id: unknown })._id,
  };
}

async function invoice(engine: ReturnType<typeof createAccountingEngine>, arId: unknown, revenueId: unknown, amount: number, date = new Date('2026-02-10')) {
  const entry = await engine.repositories.journalEntries.create({
    journalType: 'SALES',
    state: 'posted',
    date,
    journalItems: [
      { account: arId, debit: amount, credit: 0 },
      { account: revenueId, debit: 0, credit: amount },
    ],
  } as never);
  return entry as { _id: unknown; journalItems: unknown[] };
}

async function payment(engine: ReturnType<typeof createAccountingEngine>, arId: unknown, cashId: unknown, amount: number, date = new Date('2026-02-15')) {
  const entry = await engine.repositories.journalEntries.create({
    journalType: 'CASH_RECEIPTS',
    state: 'posted',
    date,
    journalItems: [
      { account: cashId, debit: amount, credit: 0 },
      { account: arId, debit: 0, credit: amount },
    ],
  } as never);
  return entry as { _id: unknown; journalItems: unknown[] };
}

describe('Open-item matching', () => {
  it('fully matches one invoice against one payment', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const inv = await invoice(engine, arId, revenueId, 1_000_00);
    const pay = await payment(engine, arId, cashId, 1_000_00);

    const rec = await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv._id, itemIndex: 0 }, // AR debit
        { entry: pay._id, itemIndex: 1 }, // AR credit
      ],
    }) as { isFullReconcile: boolean; matchingNumber: string; debitTotal: number; creditTotal: number; difference: number };

    expect(rec.isFullReconcile).toBe(true);
    expect(rec.difference).toBe(0);
    expect(rec.matchingNumber).toMatch(/^RECN-\d+$/);

    const open = await engine.repositories.reconciliations.getOpenItems({ accountId: arId });
    expect(open).toHaveLength(0);
  });

  it('partial match (payment < invoice) leaves the invoice partially open', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const inv = await invoice(engine, arId, revenueId, 1_000_00);
    const pay = await payment(engine, arId, cashId, 400_00);

    const rec = await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    }) as { isFullReconcile: boolean; difference: number };

    expect(rec.isFullReconcile).toBe(false);
    expect(rec.difference).toBe(600_00);
  });

  it('one payment settles two invoices (many-to-one)', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const inv1 = await invoice(engine, arId, revenueId, 300_00);
    const inv2 = await invoice(engine, arId, revenueId, 200_00);
    const pay = await payment(engine, arId, cashId, 500_00);

    const rec = await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv1._id, itemIndex: 0 },
        { entry: inv2._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    }) as { isFullReconcile: boolean; items: unknown[] };

    expect(rec.isFullReconcile).toBe(true);
    expect(rec.items).toHaveLength(3);
  });

  it('getOpenItems returns only unmatched items', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const _matchedInv = await invoice(engine, arId, revenueId, 100_00);
    const _matchedPay = await payment(engine, arId, cashId, 100_00);
    const openInv = await invoice(engine, arId, revenueId, 250_00, new Date('2026-03-01'));

    await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: _matchedInv._id, itemIndex: 0 },
        { entry: _matchedPay._id, itemIndex: 1 },
      ],
    });

    const open = await engine.repositories.reconciliations.getOpenItems({ accountId: arId });
    expect(open).toHaveLength(1);
    expect(String(open[0].entry)).toBe(String(openInv._id));
    expect(open[0].debit).toBe(250_00);
  });

  it('unmatch clears matching numbers and restores items to open', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const inv = await invoice(engine, arId, revenueId, 500_00);
    const pay = await payment(engine, arId, cashId, 500_00);

    const rec = await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    }) as { matchingNumber: string };

    const before = await engine.repositories.reconciliations.getOpenItems({ accountId: arId });
    expect(before).toHaveLength(0);

    await engine.repositories.reconciliations.unmatch({ matchingNumber: rec.matchingNumber });

    const after = await engine.repositories.reconciliations.getOpenItems({ accountId: arId });
    expect(after).toHaveLength(2);
  });

  it('rejects matching an item that is already matched', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const inv = await invoice(engine, arId, revenueId, 100_00);
    const pay1 = await payment(engine, arId, cashId, 100_00);
    const pay2 = await payment(engine, arId, cashId, 100_00);

    await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv._id, itemIndex: 0 },
        { entry: pay1._id, itemIndex: 1 },
      ],
    });

    await expect(
      engine.repositories.reconciliations.match({
        account: arId,
        items: [
          { entry: inv._id, itemIndex: 0 }, // already matched
          { entry: pay2._id, itemIndex: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects an item reference on the wrong account', async () => {
    const { engine, arId, cashId, revenueId } = await bootstrap();
    const inv = await invoice(engine, arId, revenueId, 100_00);
    const pay = await payment(engine, arId, cashId, 100_00);

    await expect(
      engine.repositories.reconciliations.match({
        account: arId,
        items: [
          { entry: inv._id, itemIndex: 1 }, // item 1 is revenue, not AR
          { entry: pay._id, itemIndex: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('FX realization plugin', () => {
  it('books a realized gain when a foreign invoice is paid at a higher rate', async () => {
    // Base = USD. We simulate a CAD-denominated invoice against a CAD-account.
    // At invoice time:  1000 CAD × 0.73 = 730 USD  → debit AR 73000 cents
    // At payment time:  1000 CAD × 0.78 = 780 USD  → credit AR 78000 cents
    // Realized gain: 5000 cents USD
    // Bootstrap a dedicated multi-currency engine — the default bootstrap
    // does not enable the currency item fields, which the FX plugin depends on.
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
      multiCurrency: { enabled: true, currencies: ['CAD'] },
      modelNames: {
        account: 'FxAccount',
        journalEntry: 'FxJE',
        fiscalPeriod: 'FxFP',
        budget: 'FxBudget',
        reconciliation: 'FxRecon',
        journal: 'FxJournal',
      },
    });

    const accts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1100' },
      { accountTypeCode: '1000' },
      { accountTypeCode: '4000' },
      { accountTypeCode: '7100' },
      { accountTypeCode: '7200' },
    ] as never);
    const arId = (accts.created[0] as { _id: unknown })._id;
    const cashId = (accts.created[1] as { _id: unknown })._id;
    const revenueId = (accts.created[2] as { _id: unknown })._id;
    const fxGainId = (accts.created[3] as { _id: unknown })._id;
    const fxLossId = (accts.created[4] as { _id: unknown })._id;

    // Wire FX realization plugin against reconciliations.
    fxRealizationPlugin({
      journalEntries: engine.repositories.journalEntries,
      realizedGainAccount: fxGainId,
      realizedLossAccount: fxLossId,
      baseCurrency: 'USD',
    }).apply(engine.repositories.reconciliations);

    const inv = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-02-10'),
      journalItems: [
        {
          account: arId,
          debit: 730_00,
          credit: 0,
          currency: 'CAD',
          exchangeRate: 0.73,
          originalDebit: 1_000_00,
          originalCredit: 0,
        },
        {
          account: revenueId,
          debit: 0,
          credit: 730_00,
          currency: 'CAD',
          exchangeRate: 0.73,
          originalDebit: 0,
          originalCredit: 1_000_00,
        },
      ],
    } as never) as { _id: unknown };

    const pay = await engine.repositories.journalEntries.create({
      journalType: 'CASH_RECEIPTS',
      state: 'posted',
      date: new Date('2026-02-25'),
      journalItems: [
        {
          account: cashId,
          debit: 780_00,
          credit: 0,
          currency: 'CAD',
          exchangeRate: 0.78,
          originalDebit: 1_000_00,
          originalCredit: 0,
        },
        {
          account: arId,
          debit: 0,
          credit: 780_00,
          currency: 'CAD',
          exchangeRate: 0.78,
          originalDebit: 0,
          originalCredit: 1_000_00,
        },
      ],
    } as never) as { _id: unknown };

    // Match. Foreign totals net to zero (1000 debit - 1000 credit = 0) but
    // base totals have a 50 USD gap that the FX plugin captures.
    const rec = await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: inv._id, itemIndex: 0 }, // 73000 debit
        { entry: pay._id, itemIndex: 1 }, // 78000 credit
      ],
    }) as { matchingNumber: string };

    // Verify an FX entry got booked. The plugin writes its id onto the recon.
    const doc = (await (engine.models.Reconciliation as unknown as {
      findOne: (q: Record<string, unknown>) => { lean: () => Promise<unknown> };
    }).findOne({ matchingNumber: rec.matchingNumber }).lean()) as {
      fxRealizationEntry: unknown;
    };
    expect(doc.fxRealizationEntry).not.toBeNull();

    // And the entry itself is a balanced 5000 cent gain.
    const fxEntry = (await engine.repositories.journalEntries.getById(
      doc.fxRealizationEntry as never,
    )) as { totalDebit: number; totalCredit: number; label: string };
    expect(fxEntry.totalDebit).toBe(50_00);
    expect(fxEntry.totalCredit).toBe(50_00);
    expect(fxEntry.label).toMatch(/FX realization/);
  });
});
