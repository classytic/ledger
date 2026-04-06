/**
 * Semantic Record API — unit tests
 *
 * Each verb (sale, expense, transfer, payment, adjustment) is tested for:
 * - Happy path: correct journal items created
 * - Tax splitting (exclusive and inclusive)
 * - Validation: missing accounts, bad amounts, unbalanced adjustments
 * - Structured field errors in AccountingError
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TaxCode } from '../../src/country/index.js';
import { defineCountryPack } from '../../src/country/index.js';
import { type AccountingEngine, createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';
import { AccountingError } from '../../src/utils/errors.js';

const accountTypes: readonly AccountType[] = [
  {
    code: '1001',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1002',
    name: 'Bank',
    category: 'Balance Sheet-Asset',
    description: 'Bank',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1200',
    name: 'Accounts Receivable',
    category: 'Balance Sheet-Asset',
    description: 'AR',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2001',
    name: 'Accounts Payable',
    category: 'Balance Sheet-Liability',
    description: 'AP',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2300',
    name: 'HST Collected',
    category: 'Balance Sheet-Liability',
    description: 'HST Payable',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '2400',
    name: 'HST Paid (ITC)',
    category: 'Balance Sheet-Asset',
    description: 'HST ITC',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '3100',
    name: 'Capital',
    category: 'Balance Sheet-Equity',
    description: 'Capital',
    parentCode: null,
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
  {
    code: '4010',
    name: 'Service Revenue',
    category: 'Income Statement-Income',
    description: 'Services',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6010',
    name: 'Rent',
    category: 'Income Statement-Expense',
    description: 'Rent',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '6020',
    name: 'Salaries',
    category: 'Income Statement-Expense',
    description: 'Salaries',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },
];

const taxCodes: Record<string, TaxCode> = {
  HST: {
    code: 'HST',
    name: 'Harmonized Sales Tax',
    taxType: 'HST',
    rate: 0.13,
    direction: 'collected',
    description: '13% HST',
    active: true,
  },
  HST_ITC: {
    code: 'HST_ITC',
    name: 'HST Input Tax Credit',
    taxType: 'HST',
    rate: 0.13,
    direction: 'recoverable',
    description: '13% recoverable',
    active: true,
  },
};

const pack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes,
  taxCodesByRegion: { ON: ['HST', 'HST_ITC'] },
  regions: ['ON'],
  retainedEarningsAccountCode: '3600',
});

let mongod: MongoMemoryServer;
let engine: AccountingEngine;

const MODEL_PREFIX = 'RecUnit_';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const n of [
    `${MODEL_PREFIX}Acct`,
    `${MODEL_PREFIX}JE`,
    `${MODEL_PREFIX}FP`,
    `${MODEL_PREFIX}B`,
    `${MODEL_PREFIX}R`,
  ]) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    modelNames: {
      account: `${MODEL_PREFIX}Acct`,
      journalEntry: `${MODEL_PREFIX}JE`,
      fiscalPeriod: `${MODEL_PREFIX}FP`,
      budget: `${MODEL_PREFIX}B`,
      reconciliation: `${MODEL_PREFIX}R`,
    },
  });

  await engine.models.Account.createIndexes();
  await engine.models.JournalEntry.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await engine.models.Account.deleteMany({});
  await engine.models.JournalEntry.deleteMany({});

  // Seed all posting accounts
  await engine.repositories.accounts.seedAccounts(undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// record.sale
// ═════════════════════════════════════════════════════════════════════════════

describe('record.sale', () => {
  it('records a cash sale without tax', async () => {
    const entry = await engine.record.sale(undefined, {
      date: new Date('2025-01-15'),
      amount: 10000, // $100.00
      receivableAccount: '1001',
      revenueAccount: '4010',
      label: 'INV-001',
    });

    expect((entry as any).state).toBe('posted');
    expect((entry as any).journalType).toBe('SALES');
    expect((entry as any).totalDebit).toBe(10000);
    expect((entry as any).totalCredit).toBe(10000);
    expect((entry as any).journalItems).toHaveLength(2);
  });

  it('records a sale with HST (tax-exclusive)', async () => {
    const entry = await engine.record.sale(undefined, {
      date: new Date('2025-01-15'),
      amount: 10000, // $100.00 base
      receivableAccount: '1200',
      revenueAccount: '4010',
      tax: { code: 'HST', account: '2300' },
      label: 'INV-002',
    });

    // 13% HST → $13.00 tax → $113.00 total
    expect((entry as any).totalDebit).toBe(11300);
    expect((entry as any).totalCredit).toBe(11300);
    expect((entry as any).journalItems).toHaveLength(3);

    const items = (entry as any).journalItems as Array<{
      debit: number;
      credit: number;
    }>;
    // AR debit 11300, revenue credit 10000, HST credit 1300
    expect(items.find((i) => i.debit === 11300)).toBeDefined();
    expect(items.find((i) => i.credit === 10000)).toBeDefined();
    expect(items.find((i) => i.credit === 1300)).toBeDefined();
  });

  it('records a sale with HST (tax-inclusive)', async () => {
    const entry = await engine.record.sale(undefined, {
      date: new Date('2025-01-15'),
      amount: 11300, // $113.00 total
      receivableAccount: '1001',
      revenueAccount: '4010',
      tax: { code: 'HST', account: '2300', inclusive: true },
    });

    // Split 11300 inclusive → base 10000, tax 1300
    expect((entry as any).totalDebit).toBe(11300);
    const items = (entry as any).journalItems as Array<{
      debit: number;
      credit: number;
    }>;
    expect(items.find((i) => i.credit === 10000)).toBeDefined();
    expect(items.find((i) => i.credit === 1300)).toBeDefined();
  });

  it('throws with field errors when receivable account is not seeded', async () => {
    await engine.models.Account.deleteOne({ accountTypeCode: '1001' });

    const err = await engine.record
      .sale(undefined, {
        date: new Date(),
        amount: 10000,
        receivableAccount: '1001',
        revenueAccount: '4010',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    const ae = err as AccountingError;
    expect(ae.code).toBe('NOT_FOUND');
    expect(ae.fields).toBeDefined();
    expect(ae.fields?.some((f) => f.value === '1001')).toBe(true);
  });

  it('throws with field error when tax code is not registered', async () => {
    const err = await engine.record
      .sale(undefined, {
        date: new Date(),
        amount: 10000,
        receivableAccount: '1001',
        revenueAccount: '4010',
        tax: { code: 'UNKNOWN_TAX', account: '2300' },
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).code).toBe('NOT_FOUND');
    expect((err as AccountingError).fields?.[0].path).toBe('tax.code');
  });

  it('rejects zero and negative amounts with field errors', async () => {
    for (const amount of [0, -100]) {
      const err = await engine.record
        .sale(undefined, {
          date: new Date(),
          amount,
          receivableAccount: '1001',
          revenueAccount: '4010',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AccountingError);
      expect((err as AccountingError).fields?.[0].path).toBe('amount');
    }
  });

  it('rejects non-integer amounts', async () => {
    const err = await engine.record
      .sale(undefined, {
        date: new Date(),
        amount: 100.5,
        receivableAccount: '1001',
        revenueAccount: '4010',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).fields?.[0].issue).toContain('integer');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// record.expense
// ═════════════════════════════════════════════════════════════════════════════

describe('record.expense', () => {
  it('records a cash expense without tax', async () => {
    const entry = await engine.record.expense(undefined, {
      date: new Date('2025-01-20'),
      amount: 5000,
      expenseAccount: '6010',
      paidFromAccount: '1001',
      label: 'Jan rent',
    });

    expect((entry as any).journalType).toBe('PURCHASES');
    expect((entry as any).totalDebit).toBe(5000);
    expect((entry as any).totalCredit).toBe(5000);
  });

  it('records an expense with recoverable HST (ITC)', async () => {
    const entry = await engine.record.expense(undefined, {
      date: new Date('2025-01-20'),
      amount: 5000,
      expenseAccount: '6010',
      paidFromAccount: '2001',
      tax: { code: 'HST_ITC', account: '2400' },
      label: 'Rent + HST',
    });

    // Base 5000 + HST 650 = 5650 total
    expect((entry as any).totalDebit).toBe(5650);
    expect((entry as any).totalCredit).toBe(5650);
    const items = (entry as any).journalItems as Array<{ debit: number; credit: number }>;
    expect(items.find((i) => i.debit === 5000)).toBeDefined(); // expense
    expect(items.find((i) => i.debit === 650)).toBeDefined(); // ITC
    expect(items.find((i) => i.credit === 5650)).toBeDefined(); // AP
  });

  it('records an on-account expense (credit to AP)', async () => {
    const entry = await engine.record.expense(undefined, {
      date: new Date('2025-01-20'),
      amount: 3000,
      expenseAccount: '6010',
      paidFromAccount: '2001',
    });
    const items = (entry as any).journalItems as Array<{
      account: unknown;
      debit: number;
      credit: number;
    }>;
    expect(items.find((i) => i.credit === 3000)).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// record.transfer
// ═════════════════════════════════════════════════════════════════════════════

describe('record.transfer', () => {
  it('transfers between two balance-sheet accounts', async () => {
    const entry = await engine.record.transfer(undefined, {
      date: new Date('2025-01-25'),
      amount: 10000,
      fromAccount: '1001',
      toAccount: '1002',
      label: 'Cash to bank',
    });

    expect((entry as any).journalType).toBe('GENERAL');
    expect((entry as any).totalDebit).toBe(10000);
    expect((entry as any).journalItems).toHaveLength(2);
  });

  it('rejects transfer between the same account', async () => {
    const err = await engine.record
      .transfer(undefined, {
        date: new Date(),
        amount: 1000,
        fromAccount: '1001',
        toAccount: '1001',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).fields?.[0].path).toBe('fromAccount');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// record.payment
// ═════════════════════════════════════════════════════════════════════════════

describe('record.payment', () => {
  it('records a customer payment (AR → Cash)', async () => {
    const entry = await engine.record.payment(undefined, {
      date: new Date('2025-02-01'),
      amount: 5000,
      fromReceivableAccount: '1200',
      toCashAccount: '1001',
      label: 'Payment for INV-001',
    });

    expect((entry as any).journalType).toBe('CASH_RECEIPTS');
    expect((entry as any).totalDebit).toBe(5000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// record.adjustment
// ═════════════════════════════════════════════════════════════════════════════

describe('record.adjustment', () => {
  it('records a balanced multi-line adjustment', async () => {
    const entry = await engine.record.adjustment(undefined, {
      date: new Date('2025-03-31'),
      label: 'Depreciation',
      lines: [
        { account: '6020', debit: 1000 },
        { account: '1001', credit: 1000 },
      ],
    });

    expect((entry as any).totalDebit).toBe(1000);
    expect((entry as any).totalCredit).toBe(1000);
  });

  it('rejects unbalanced adjustments with a detailed field error', async () => {
    const err = await engine.record
      .adjustment(undefined, {
        date: new Date(),
        lines: [
          { account: '6020', debit: 1000 },
          { account: '1001', credit: 999 },
        ],
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    const f = (err as AccountingError).fields?.[0];
    expect(f.path).toBe('lines');
    expect(f.issue).toContain('equal');
    expect((f.value as any).totalDebit).toBe(1000);
    expect((f.value as any).totalCredit).toBe(999);
  });

  it('rejects adjustment with < 2 lines', async () => {
    const err = await engine.record
      .adjustment(undefined, {
        date: new Date(),
        lines: [{ account: '6020', debit: 1000 }],
      })
      .catch((e: unknown) => e);

    expect((err as AccountingError).fields?.[0].path).toBe('lines');
  });

  it('rejects adjustment lines with both debit and credit', async () => {
    const err = await engine.record
      .adjustment(undefined, {
        date: new Date(),
        lines: [
          { account: '6020', debit: 500, credit: 500 },
          { account: '1001', credit: 1000 },
        ],
      })
      .catch((e: unknown) => e);

    expect((err as AccountingError).fields?.some((f) => f.path === 'lines.0')).toBe(true);
  });
});
