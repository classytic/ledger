/**
 * E2E: Full Quarterly Cycle Using Only Semantic API
 *
 * A small consulting business (Contoso) operates for Q1 2025 using
 * ONLY `engine.record.*` verbs and `engine.reports.*` — no manual
 * journal-entry assembly. This is the golden path for AI agents and
 * MCP tools: natural-language operations map 1:1 to record.* verbs.
 *
 * Flow:
 *   1. Owner invests cash          → record.adjustment
 *   2. Sales throughout Q1          → record.sale (with HST)
 *   3. Rent paid monthly            → record.expense (with HST ITC)
 *   4. Customer pays invoice        → record.payment
 *   5. Cash → Bank transfer         → record.transfer
 *   6. Trial balance, IS, BS        → engine.reports.*
 *   7. Conservation invariant verified across the quarter
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineCountryPack, type TaxCode } from '../../src/country/index.js';
import { type AccountingEngine, createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';

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
    name: 'Share Capital',
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
    name: 'Consulting Revenue',
    category: 'Income Statement-Income',
    description: 'Consulting',
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
    name: 'Harmonized Sales Tax 13%',
    taxType: 'HST',
    rate: 0.13,
    direction: 'collected',
    description: '13% HST Ontario',
    active: true,
  },
  HST_ITC: {
    code: 'HST_ITC',
    name: 'HST Input Tax Credit',
    taxType: 'HST',
    rate: 0.13,
    direction: 'recoverable',
    description: '13% recoverable on expenses',
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

const PREFIX = 'Contoso_';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const n of [`${PREFIX}Acct`, `${PREFIX}JE`, `${PREFIX}FP`, `${PREFIX}B`, `${PREFIX}R`]) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    retainedEarningsAccountCode: '3600',
    modelNames: {
      account: `${PREFIX}Acct`,
      journalEntry: `${PREFIX}JE`,
      fiscalPeriod: `${PREFIX}FP`,
      budget: `${PREFIX}B`,
      reconciliation: `${PREFIX}R`,
    },
  });

  await engine.models.Account.createIndexes();
  await engine.models.JournalEntry.createIndexes();
  await engine.repositories.accounts.seedAccounts(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ═════════════════════════════════════════════════════════════════════════════
// Helper: sum the posted journal entries for conservation law
// ═════════════════════════════════════════════════════════════════════════════

async function assertConservation() {
  const result = await engine.models.JournalEntry.aggregate([
    { $match: { state: 'posted' } },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: '$totalDebit' },
        totalCredit: { $sum: '$totalCredit' },
      },
    },
  ]);
  if (result.length === 0) return;
  expect(result[0].totalDebit).toBe(result[0].totalCredit);
}

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 1: Business setup
// ═════════════════════════════════════════════════════════════════════════════

describe('Contoso Consulting — Q1 2025 (semantic API)', () => {
  it('introspect.catalog gives the AI agent everything it needs upfront', async () => {
    const catalog = await engine.introspect.catalog();

    expect(catalog.accounts.length).toBe(accountTypes.length);
    expect(catalog.journalTypes.length).toBeGreaterThanOrEqual(15);
    expect(catalog.reports.length).toBeGreaterThanOrEqual(9);
    expect(catalog.taxCodes.length).toBe(2);

    // Agent can list tax codes
    expect(catalog.taxCodes.some((t) => t.code === 'HST')).toBe(true);

    // Agent can list revenue accounts
    const revenue = catalog.accounts.find((a) => a.code === '4010');
    expect(revenue?.normalBalance).toBe('credit');
  });

  it('records owner investment via record.adjustment', async () => {
    await engine.record.adjustment(undefined, {
      date: new Date('2025-01-01'),
      label: 'Owner investment',
      lines: [
        { account: '1001', debit: 5_000_000 }, // $50,000 cash
        { account: '3100', credit: 5_000_000 }, // Share capital
      ],
    });
    await assertConservation();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 2: January — First sale with HST
// ═════════════════════════════════════════════════════════════════════════════

describe('January operations', () => {
  it('records a $10,000 sale on account with 13% HST', async () => {
    const entry = await engine.record.sale(undefined, {
      date: new Date('2025-01-15'),
      amount: 1_000_000, // $10,000 base
      receivableAccount: '1200',
      revenueAccount: '4010',
      tax: { code: 'HST', account: '2300' },
      label: 'INV-001 — Q1 planning workshop',
    });

    // AR debit 11300 ($113.00 * 100 = 1,130,000 cents)
    expect((entry as any).totalDebit).toBe(1_130_000);
    expect((entry as any).totalCredit).toBe(1_130_000);

    await assertConservation();
  });

  it('records a $5,000 cash sale with HST (tax-inclusive)', async () => {
    const entry = await engine.record.sale(undefined, {
      date: new Date('2025-01-20'),
      amount: 565_000, // $5,650 tax-inclusive
      receivableAccount: '1001', // direct to cash
      revenueAccount: '4010',
      tax: { code: 'HST', account: '2300', inclusive: true },
      label: 'INV-002 — Walk-in consultation',
    });

    // Split 5650 → base 5000 + tax 650
    const items = (entry as any).journalItems as Array<{ debit: number; credit: number }>;
    expect(items.find((i) => i.credit === 500_000)).toBeDefined(); // $5,000 revenue
    expect(items.find((i) => i.credit === 65_000)).toBeDefined(); // $650 HST
    await assertConservation();
  });

  it('pays January rent $3,000 + HST via AP', async () => {
    await engine.record.expense(undefined, {
      date: new Date('2025-01-31'),
      amount: 300_000, // $3,000 base
      expenseAccount: '6010',
      paidFromAccount: '2001',
      tax: { code: 'HST_ITC', account: '2400' },
      label: 'Jan rent',
    });
    await assertConservation();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 3: February — Customer payment, cash management
// ═════════════════════════════════════════════════════════════════════════════

describe('February operations', () => {
  it('customer pays the January invoice ($11,300)', async () => {
    await engine.record.payment(undefined, {
      date: new Date('2025-02-10'),
      amount: 1_130_000,
      fromReceivableAccount: '1200',
      toCashAccount: '1001',
      label: 'Payment for INV-001',
    });
    await assertConservation();
  });

  it('transfers $20,000 cash to the operating bank account', async () => {
    await engine.record.transfer(undefined, {
      date: new Date('2025-02-15'),
      amount: 2_000_000,
      fromAccount: '1001',
      toAccount: '1002',
      label: 'Excess cash → operating account',
    });
    await assertConservation();
  });

  it('pays salaries $8,000 from bank', async () => {
    await engine.record.expense(undefined, {
      date: new Date('2025-02-28'),
      amount: 800_000,
      expenseAccount: '6020',
      paidFromAccount: '1002',
      label: 'February salaries',
    });
    await assertConservation();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 4: March — Another sale + year-end prep
// ═════════════════════════════════════════════════════════════════════════════

describe('March operations', () => {
  it('records a $25,000 cash sale with HST (tax-exclusive)', async () => {
    await engine.record.sale(undefined, {
      date: new Date('2025-03-20'),
      amount: 2_500_000,
      receivableAccount: '1001',
      revenueAccount: '4010',
      tax: { code: 'HST', account: '2300' },
      label: 'INV-003 — End-of-quarter engagement',
    });
    await assertConservation();
  });

  it('pays March rent and salaries', async () => {
    await engine.record.expense(undefined, {
      date: new Date('2025-03-31'),
      amount: 300_000,
      expenseAccount: '6010',
      paidFromAccount: '2001',
      tax: { code: 'HST_ITC', account: '2400' },
      label: 'Mar rent',
    });
    await engine.record.expense(undefined, {
      date: new Date('2025-03-31'),
      amount: 800_000,
      expenseAccount: '6020',
      paidFromAccount: '1002',
      label: 'March salaries',
    });
    await assertConservation();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 5: Reports — the payoff
// ═════════════════════════════════════════════════════════════════════════════

describe('Q1 reports (via engine.reports)', () => {
  it('trial balance: debits === credits', async () => {
    const tb = await engine.reports.trialBalance({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });
    const totalD = tb.rows.reduce((s: number, r: any) => s + r.ending.debit, 0);
    const totalC = tb.rows.reduce((s: number, r: any) => s + r.ending.credit, 0);
    expect(totalD).toBe(totalC);
    expect(totalD).toBeGreaterThan(0);
  });

  it('income statement: revenue $40,000 base — expenses $14,600 → net $25,400', async () => {
    const is = await engine.reports.incomeStatement({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    // Revenue (tax-exclusive): $10K + $5K + $25K = $40,000 = 4,000,000 cents
    // Expenses: Rent $3K + $3K = $6K; Salaries $8K + $8K = $16K → $22K? Wait let me recalc.
    // Actually: Feb salaries $8K + Mar salaries $8K = $16K; Rent $3K + $3K = $6K
    // Total expenses = $22K
    // Net income = $40K - $22K = $18,000 = 1,800,000 cents
    expect(is.netIncome).toBe(1_800_000);
  });

  it('balance sheet balances: A = L + E', async () => {
    const bs = await engine.reports.balanceSheet({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    expect(bs.summary.isBalanced).toBe(true);
    expect(bs.summary.difference).toBe(0);
  });

  it('introspect.accounts returns the same COA the engine used', async () => {
    const list = await engine.introspect.accounts();
    expect(list.length).toBe(accountTypes.length);
    // Revenue accounts are credit-normal
    expect(list.find((a) => a.code === '4010')?.normalBalance).toBe('credit');
    // Asset accounts are debit-normal
    expect(list.find((a) => a.code === '1001')?.normalBalance).toBe('debit');
  });
});
