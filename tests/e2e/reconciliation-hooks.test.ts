/**
 * Reconciliation lifecycle hooks — integration tests.
 *
 * Verifies:
 *   1. before:match fires and can abort the match
 *   2. after:match fires with enriched context (items, totals, reconciliation doc)
 *   3. before:unmatch fires and can abort the unmatch
 *   4. after:unmatch fires with context (reconciliation, items)
 *   5. Hook context shape matches the exported types
 *   6. Multiple listeners on the same hook all fire
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { MatchHookContext, UnmatchHookContext } from '../../src/repositories/reconciliation.repository.js';
import type { AccountType } from '../../src/types/core.js';

const accountTypes: readonly AccountType[] = [
  { code: '1100', name: 'AR', category: 'Balance Sheet-Asset' },
  { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset' },
  { code: '4000', name: 'Revenue', category: 'Income Statement-Income' },
  { code: '3600', name: 'RE', category: 'Balance Sheet-Equity' },
];

const pack = defineCountryPack({
  code: 'RH',
  name: 'Reconciliation Hooks Test',
  defaultCurrency: 'CAD',
  accountTypes,
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

async function setup() {
  const engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'CAD',
  });

  const accts = await engine.repositories.accounts.bulkCreate([
    { accountTypeCode: '1100' },
    { accountTypeCode: '1000' },
    { accountTypeCode: '4000' },
  ] as never);

  const arId = (accts.created[0] as { _id: unknown })._id;
  const cashId = (accts.created[1] as { _id: unknown })._id;
  const revenueId = (accts.created[2] as { _id: unknown })._id;

  // Create an invoice + payment pair
  const inv = (await engine.repositories.journalEntries.create({
    journalType: 'SALES',
    state: 'posted',
    date: new Date('2026-01-15'),
    journalItems: [
      { account: arId, debit: 100000, credit: 0 },
      { account: revenueId, debit: 0, credit: 100000 },
    ],
  } as never)) as { _id: unknown };

  const pmt = (await engine.repositories.journalEntries.create({
    journalType: 'CASH_RECEIPTS',
    state: 'posted',
    date: new Date('2026-02-01'),
    journalItems: [
      { account: cashId, debit: 100000, credit: 0 },
      { account: arId, debit: 0, credit: 100000 },
    ],
  } as never)) as { _id: unknown };

  return { engine, arId, cashId, revenueId, invId: inv._id, pmtId: pmt._id };
}

describe('before:match hook', () => {
  it('fires before the reconciliation is created', async () => {
    const { engine, arId, invId, pmtId } = await setup();
    const beforeMatchSpy = vi.fn();

    engine.repositories.reconciliations.on('before:match', beforeMatchSpy);

    await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: invId, itemIndex: 0 },
        { entry: pmtId, itemIndex: 1 },
      ],
    });

    expect(beforeMatchSpy).toHaveBeenCalledTimes(1);

    const ctx = beforeMatchSpy.mock.calls[0][0] as MatchHookContext;
    expect(ctx.items).toHaveLength(2);
    expect(ctx.matchingNumber).toMatch(/^RECN-/);
    expect(ctx.debitTotal).toBe(100000);
    expect(ctx.creditTotal).toBe(100000);
    expect(ctx.isFullReconcile).toBe(true);
    expect(ctx.sharedCurrency).toBeNull(); // no currency set on items
    // reconciliation doc NOT yet available in before:match
    expect(ctx.reconciliation).toBeUndefined();
  });

  it('can abort the match by throwing', async () => {
    const { engine, arId, invId, pmtId } = await setup();

    engine.repositories.reconciliations.on('before:match', () => {
      throw new Error('Invoice is in dispute — cannot reconcile');
    });

    await expect(
      engine.repositories.reconciliations.match({
        account: arId,
        items: [
          { entry: invId, itemIndex: 0 },
          { entry: pmtId, itemIndex: 1 },
        ],
      }),
    ).rejects.toThrow('Invoice is in dispute');

    // Verify no reconciliation was created
    const open = await engine.repositories.reconciliations.getOpenItems({
      accountId: arId,
    });
    expect(open).toHaveLength(2); // both still open
  });
});

describe('after:match hook', () => {
  it('fires with the created reconciliation document', async () => {
    const { engine, arId, invId, pmtId } = await setup();
    const afterMatchSpy = vi.fn();

    engine.repositories.reconciliations.on('after:match', afterMatchSpy);

    const rec = await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: invId, itemIndex: 0 },
        { entry: pmtId, itemIndex: 1 },
      ],
    });

    expect(afterMatchSpy).toHaveBeenCalledTimes(1);

    const ctx = afterMatchSpy.mock.calls[0][0] as MatchHookContext;
    expect(ctx.reconciliation).toBeDefined();
    expect(ctx.items).toHaveLength(2);
    expect(ctx.matchingNumber).toMatch(/^RECN-/);
    expect(ctx.isFullReconcile).toBe(true);
  });

  it('multiple listeners all fire', async () => {
    const { engine, arId, invId, pmtId } = await setup();
    const spy1 = vi.fn();
    const spy2 = vi.fn();

    engine.repositories.reconciliations.on('after:match', spy1);
    engine.repositories.reconciliations.on('after:match', spy2);

    await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: invId, itemIndex: 0 },
        { entry: pmtId, itemIndex: 1 },
      ],
    });

    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
  });
});

describe('before:unmatch hook', () => {
  it('fires before the reconciliation is deleted', async () => {
    const { engine, arId, invId, pmtId } = await setup();
    const beforeUnmatchSpy = vi.fn();

    const rec = (await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: invId, itemIndex: 0 },
        { entry: pmtId, itemIndex: 1 },
      ],
    })) as { matchingNumber: string };

    engine.repositories.reconciliations.on('before:unmatch', beforeUnmatchSpy);

    await engine.repositories.reconciliations.unmatch({
      matchingNumber: rec.matchingNumber,
    });

    expect(beforeUnmatchSpy).toHaveBeenCalledTimes(1);

    const ctx = beforeUnmatchSpy.mock.calls[0][0] as UnmatchHookContext;
    expect(ctx.matchingNumber).toBe(rec.matchingNumber);
    expect(ctx.items).toHaveLength(2);
    expect(ctx.reconciliation).toBeDefined();
  });

  it('can abort the unmatch by throwing', async () => {
    const { engine, arId, invId, pmtId } = await setup();

    const rec = (await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: invId, itemIndex: 0 },
        { entry: pmtId, itemIndex: 1 },
      ],
    })) as { matchingNumber: string };

    engine.repositories.reconciliations.on('before:unmatch', () => {
      throw new Error('Period is locked — cannot unmatch');
    });

    await expect(
      engine.repositories.reconciliations.unmatch({
        matchingNumber: rec.matchingNumber,
      }),
    ).rejects.toThrow('Period is locked');

    // Items should still be matched
    const open = await engine.repositories.reconciliations.getOpenItems({
      accountId: arId,
    });
    expect(open).toHaveLength(0); // still matched
  });
});

describe('after:unmatch hook', () => {
  it('fires after reconciliation is deleted and items are cleared', async () => {
    const { engine, arId, invId, pmtId } = await setup();
    const afterUnmatchSpy = vi.fn();

    const rec = (await engine.repositories.reconciliations.match({
      account: arId,
      items: [
        { entry: invId, itemIndex: 0 },
        { entry: pmtId, itemIndex: 1 },
      ],
    })) as { matchingNumber: string };

    engine.repositories.reconciliations.on('after:unmatch', afterUnmatchSpy);

    await engine.repositories.reconciliations.unmatch({
      matchingNumber: rec.matchingNumber,
    });

    expect(afterUnmatchSpy).toHaveBeenCalledTimes(1);

    const ctx = afterUnmatchSpy.mock.calls[0][0] as UnmatchHookContext;
    expect(ctx.matchingNumber).toBe(rec.matchingNumber);

    // Verify items are now open again
    const open = await engine.repositories.reconciliations.getOpenItems({
      accountId: arId,
    });
    expect(open).toHaveLength(2);
  });
});
