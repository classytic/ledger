/**
 * Integration tests for the unified lock primitive against real MongoDB.
 *
 * Covers all three presets through the real repository pipeline:
 *
 *   fiscalLockPlugin   ─ annual/quarterly fiscal close (FiscalPeriod model)
 *   taxLockPlugin      ─ monthly VAT filing, narrowed by account.taxMetadata
 *   dailyLockPlugin    ─ per-branch day-close watermark (multi-tenant)
 *
 * These exercise the `before:create` and `before:update` hooks end-to-end,
 * including the `_ledgerInternal` skip path that lets reverse() route a
 * counter-entry into an *open* period while the original is in a locked one.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import { dailyLockPlugin, taxLockPlugin } from '../../src/plugins/lock/index.js';
import type { AccountType } from '../../src/types/core.js';
import { AccountingError } from '../../src/utils/errors.js';

// ── Country pack ────────────────────────────────────────────────────────────

const accountTypes: readonly AccountType[] = [
  {
    code: '1000',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2100',
    name: 'VAT Payable',
    category: 'Balance Sheet-Liability',
    description: 'VAT collected',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
    // Tax accounts carry `taxMetadata` — the default selector picks these up.
    taxMetadata: { taxType: 'VAT', rate: 15, direction: 'collected' },
  } as AccountType & { taxMetadata: Record<string, unknown> },
  {
    code: '4000',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: 'Revenue',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
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
];

const pack = defineCountryPack({
  code: 'LCK',
  name: 'Lock Test Pack',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  retainedEarningsAccountCode: '3600',
});

// ── DB Bootstrap ────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

interface Fixture {
  engine: ReturnType<typeof createAccountingEngine>;
  cashId: unknown;
  vatId: unknown;
  revenueId: unknown;
}

async function bootstrap(): Promise<Fixture> {
  const engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
  });

  const accounts = await engine.repositories.accounts.bulkCreate([
    { accountTypeCode: '1000' },
    { accountTypeCode: '2100' },
    { accountTypeCode: '4000' },
  ] as never);

  return {
    engine,
    cashId: (accounts.created[0] as { _id: unknown })._id,
    vatId: (accounts.created[1] as { _id: unknown })._id,
    revenueId: (accounts.created[2] as { _id: unknown })._id,
  };
}

function saleItems(cashId: unknown, revenueId: unknown) {
  return [
    { account: cashId, debit: 1_000, credit: 0 },
    { account: revenueId, debit: 0, credit: 1_000 },
  ];
}

function saleWithVat(cashId: unknown, revenueId: unknown, vatId: unknown) {
  return [
    { account: cashId, debit: 1_150, credit: 0 },
    { account: revenueId, debit: 0, credit: 1_000 },
    { account: vatId, debit: 0, credit: 150 },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Fiscal lock (auto-wired by the engine's repository factory)
// ═══════════════════════════════════════════════════════════════════════════

describe('fiscalLockPlugin — unified-primitive integration', () => {
  it('blocks post() into a closed fiscal period with PERIOD_LOCKED_FISCAL', async () => {
    const { engine, cashId, revenueId } = await bootstrap();

    await engine.models.FiscalPeriod.create({
      name: 'FY2025-Q1',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      closed: true,
      closedAt: new Date(),
    });

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-02-14'),
      journalItems: saleItems(cashId, revenueId),
    } as never);

    try {
      await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);
      throw new Error('expected fiscal lock to fire');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingError);
      const e = err as AccountingError;
      expect(e.code).toBe('PERIOD_LOCKED_FISCAL');
      expect(e.status).toBe(409);
      expect(e.message).toMatch(/FY2025-Q1/);
    }
  });

  it('allows posting into an open fiscal period', async () => {
    const { engine, cashId, revenueId } = await bootstrap();

    await engine.models.FiscalPeriod.create({
      name: 'FY2025-Q2',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2025-06-30'),
      closed: false,
    });

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-05-15'),
      journalItems: saleItems(cashId, revenueId),
    } as never);

    await expect(
      engine.repositories.journalEntries.post((draft as { _id: unknown })._id),
    ).resolves.toBeDefined();
  });

  it('reverse() can post a counter-entry into an OPEN period while the original sits in a CLOSED one', async () => {
    const { engine, cashId, revenueId } = await bootstrap();

    // Entry originally posted in February — that period was still open then.
    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-02-10'),
      journalItems: saleItems(cashId, revenueId),
    } as never);
    await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);

    // Now Q1 gets closed.
    await engine.models.FiscalPeriod.create({
      name: 'FY2025-Q1',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      closed: true,
      closedAt: new Date(),
    });

    // Reverse into the open Q2. The counter-entry creation runs through the
    // plugin pipeline with an Apr-15 date — allowed. The original's
    // `reversed=true` patch is flagged `_ledgerInternal='reverseMark'` so the
    // fiscal lock DOES NOT fire on that update (even though the original's
    // date is in Q1).
    const result = await engine.repositories.journalEntries.reverse(
      (draft as { _id: unknown })._id,
      undefined,
      { reversalDate: new Date('2025-04-15') },
    );
    expect(result.reversal).toBeDefined();
    expect((result.original as { reversed?: boolean }).reversed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Tax lock — account-scoped via default taxMetadata selector
// ═══════════════════════════════════════════════════════════════════════════

describe('taxLockPlugin — account-scoped narrowing', () => {
  async function withTaxLock(): Promise<Fixture & { TaxPeriodModel: mongoose.Model<unknown> }> {
    // Tax period model is consumer-owned. We create an ad-hoc collection.
    const TaxPeriodModel = mongoose.model(
      'LockTest_TaxPeriod',
      new mongoose.Schema({
        jurisdiction: String,
        taxType: String,
        periodStart: Date,
        periodEnd: Date,
        status: String,
        returnRef: String,
      }),
    );

    const fixture = await bootstrap();
    const plugin = taxLockPlugin({
      TaxPeriodModel,
      AccountModel: fixture.engine.models.Account,
      JournalEntryModel: fixture.engine.models.JournalEntry,
      // The persisted Account doc only carries `accountTypeCode`; the
      // country pack owns the `taxMetadata` on the AccountType, so we
      // bridge via a code check. Real consumers can either stamp tax
      // flags onto the account schema or resolve through the pack.
      isTaxAffecting: (acc) => acc.accountTypeCode === '2100',
    });
    plugin.apply(fixture.engine.repositories.journalEntries);

    return { ...fixture, TaxPeriodModel };
  }

  it('blocks entries that touch a tax account during a FILED period', async () => {
    const { engine, cashId, vatId, revenueId, TaxPeriodModel } = await withTaxLock();

    await TaxPeriodModel.create({
      jurisdiction: 'LCK-A',
      taxType: 'VAT',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-01-31'),
      status: 'filed',
      returnRef: 'LCK-VAT-2026-01',
    });

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2026-01-15'),
      journalItems: saleWithVat(cashId, revenueId, vatId),
    } as never);

    try {
      await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);
      throw new Error('expected tax lock to fire');
    } catch (err) {
      const e = err as AccountingError;
      expect(e.code).toBe('PERIOD_LOCKED_TAX');
      expect(e.message).toMatch(/LCK-VAT-2026-01/);
    }
  });

  it('ALLOWS entries in a filed window when no journal item touches a tax account', async () => {
    const { engine, cashId, revenueId, TaxPeriodModel } = await withTaxLock();

    await TaxPeriodModel.create({
      jurisdiction: 'LCK-A',
      taxType: 'VAT',
      periodStart: new Date('2026-02-01'),
      periodEnd: new Date('2026-02-28'),
      status: 'filed',
    });

    // Pure revenue — no VAT account touched, so taxLockPlugin narrowing
    // short-circuits and the entry posts fine.
    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2026-02-14'),
      journalItems: saleItems(cashId, revenueId),
    } as never);

    await expect(
      engine.repositories.journalEntries.post((draft as { _id: unknown })._id),
    ).resolves.toBeDefined();
  });

  it('ALLOWS entries when tax period status is "open"', async () => {
    const { engine, cashId, vatId, revenueId, TaxPeriodModel } = await withTaxLock();

    await TaxPeriodModel.create({
      jurisdiction: 'LCK-A',
      taxType: 'VAT',
      periodStart: new Date('2026-03-01'),
      periodEnd: new Date('2026-03-31'),
      status: 'open',
    });

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2026-03-15'),
      journalItems: saleWithVat(cashId, revenueId, vatId),
    } as never);

    await expect(
      engine.repositories.journalEntries.post((draft as { _id: unknown })._id),
    ).resolves.toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Daily lock — per-branch watermark
// ═══════════════════════════════════════════════════════════════════════════

describe('dailyLockPlugin — watermark semantics', () => {
  async function withDailyLock(watermark: Date | null) {
    const fixture = await bootstrap();
    const plugin = dailyLockPlugin({
      getLastClosedDate: () => watermark,
      JournalEntryModel: fixture.engine.models.JournalEntry,
    });
    plugin.apply(fixture.engine.repositories.journalEntries);
    return fixture;
  }

  it('blocks entries dated on the watermark (inclusive)', async () => {
    const { engine, cashId, revenueId } = await withDailyLock(new Date('2026-02-10T00:00:00Z'));

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2026-02-10T00:00:00Z'),
      journalItems: saleItems(cashId, revenueId),
    } as never);

    try {
      await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);
      throw new Error('expected daily lock to fire');
    } catch (err) {
      const e = err as AccountingError;
      expect(e.code).toBe('PERIOD_LOCKED_DAILY');
    }
  });

  it('allows entries dated strictly after the watermark', async () => {
    const { engine, cashId, revenueId } = await withDailyLock(new Date('2026-02-10'));

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2026-02-11'),
      journalItems: saleItems(cashId, revenueId),
    } as never);

    await expect(
      engine.repositories.journalEntries.post((draft as { _id: unknown })._id),
    ).resolves.toBeDefined();
  });

  it('no lock when watermark is null', async () => {
    const { engine, cashId, revenueId } = await withDailyLock(null);

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('1970-01-01'),
      journalItems: saleItems(cashId, revenueId),
    } as never);

    await expect(
      engine.repositories.journalEntries.post((draft as { _id: unknown })._id),
    ).resolves.toBeDefined();
  });
});
