/**
 * Semantic Introspect API — unit tests
 *
 * Verifies that agents can discover accounts, journal types, reports,
 * tax codes, and fiscal periods via a single structured API.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { _resetCustomJournalTypes, registerJournalType } from '../../src/constants/journals.js';
import { defineCountryPack } from '../../src/country/index.js';
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
    code: '2001',
    name: 'AP',
    category: 'Balance Sheet-Liability',
    description: 'AP',
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
    code: '4010',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: 'Revenue',
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
];

const pack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'USD',
  accountTypes,
});

let mongod: MongoMemoryServer;
let engine: AccountingEngine;

const PREFIX = 'IntroUnit_';

beforeAll(async () => {
  _resetCustomJournalTypes();
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const n of [`${PREFIX}Acct`, `${PREFIX}JE`, `${PREFIX}FP`, `${PREFIX}B`, `${PREFIX}R`]) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    modelNames: {
      account: `${PREFIX}Acct`,
      journalEntry: `${PREFIX}JE`,
      fiscalPeriod: `${PREFIX}FP`,
      budget: `${PREFIX}B`,
      reconciliation: `${PREFIX}R`,
    },
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  _resetCustomJournalTypes();
});

beforeEach(async () => {
  await engine.models.Account.deleteMany({});
  await engine.models.FiscalPeriod.deleteMany({});
});

// ═════════════════════════════════════════════════════════════════════════════
// accounts()
// ═════════════════════════════════════════════════════════════════════════════

describe('introspect.accounts', () => {
  it('returns empty array when no accounts are seeded', async () => {
    const list = await engine.introspect.accounts();
    expect(list).toEqual([]);
  });

  it('returns all seeded accounts with code, name, category, normalBalance', async () => {
    await engine.repositories.accounts.seedAccounts(undefined);
    const list = await engine.introspect.accounts();

    expect(list.length).toBeGreaterThan(0);
    for (const a of list) {
      expect(a.id).toBeDefined();
      expect(a.code).toBeDefined();
      expect(a.name).toBeDefined();
      expect(['debit', 'credit']).toContain(a.normalBalance);
      expect(typeof a.active).toBe('boolean');
      expect(typeof a.isPosting).toBe('boolean');
    }
  });

  it('correctly assigns normal balance: Assets/Expenses=debit, Liabilities/Equity/Income=credit', async () => {
    await engine.repositories.accounts.seedAccounts(undefined);
    const list = await engine.introspect.accounts();

    const cash = list.find((a) => a.code === '1001');
    const ap = list.find((a) => a.code === '2001');
    const capital = list.find((a) => a.code === '3100');
    const revenue = list.find((a) => a.code === '4010');
    const rent = list.find((a) => a.code === '6010');

    expect(cash?.normalBalance).toBe('debit');
    expect(ap?.normalBalance).toBe('credit');
    expect(capital?.normalBalance).toBe('credit');
    expect(revenue?.normalBalance).toBe('credit');
    expect(rent?.normalBalance).toBe('debit');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// journalTypes()
// ═════════════════════════════════════════════════════════════════════════════

describe('introspect.journalTypes', () => {
  it('returns all 15 built-in types', () => {
    _resetCustomJournalTypes();
    const list = engine.introspect.journalTypes();
    expect(list.length).toBe(15);
    expect(list.some((j) => j.code === 'SALES')).toBe(true);
    expect(list.some((j) => j.code === 'GENERAL')).toBe(true);
  });

  it('includes custom types registered via registerJournalType', () => {
    _resetCustomJournalTypes();
    registerJournalType('CUSTOM_INTRO', {
      code: 'CUSTOM_INTRO',
      name: 'Custom Introspect',
      description: 'A custom type for introspection tests',
    });

    const list = engine.introspect.journalTypes();
    expect(list.length).toBe(16);
    expect(list.some((j) => j.code === 'CUSTOM_INTRO')).toBe(true);

    _resetCustomJournalTypes();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// reports()
// ═════════════════════════════════════════════════════════════════════════════

describe('introspect.reports', () => {
  it('returns a descriptor for every available report', () => {
    const list = engine.introspect.reports();
    const names = list.map((r) => r.name);

    const expected = [
      'trialBalance',
      'balanceSheet',
      'incomeStatement',
      'generalLedger',
      'cashFlow',
      'agedBalance',
      'dimensionBreakdown',
      'budgetVsActual',
      'revaluation',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('every report has title, description, and parameter list', () => {
    const list = engine.introspect.reports();
    for (const r of list) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(Array.isArray(r.params)).toBe(true);
      for (const p of r.params) {
        expect(p.name.length).toBeGreaterThan(0);
        expect(typeof p.required).toBe('boolean');
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// fiscalPeriods()
// ═════════════════════════════════════════════════════════════════════════════

describe('introspect.fiscalPeriods', () => {
  it('returns empty array when no periods exist', async () => {
    const list = await engine.introspect.fiscalPeriods();
    expect(list).toEqual([]);
  });

  it('returns periods sorted by startDate ascending', async () => {
    await engine.models.FiscalPeriod.create({
      name: 'Q2 2025',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2025-06-30'),
    });
    await engine.models.FiscalPeriod.create({
      name: 'Q1 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    const list = await engine.introspect.fiscalPeriods();
    expect(list.length).toBe(2);
    expect(list[0].name).toBe('Q1 2025');
    expect(list[1].name).toBe('Q2 2025');
    expect(list[0].closed).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// catalog() — one-shot snapshot
// ═════════════════════════════════════════════════════════════════════════════

describe('introspect.catalog', () => {
  it('returns everything an agent needs in one call', async () => {
    await engine.repositories.accounts.seedAccounts(undefined);
    await engine.models.FiscalPeriod.create({
      name: 'Q1 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    const cat = await engine.introspect.catalog();

    expect(cat.accounts.length).toBeGreaterThan(0);
    expect(cat.journalTypes.length).toBeGreaterThanOrEqual(15);
    expect(cat.reports.length).toBeGreaterThanOrEqual(9);
    expect(cat.fiscalPeriods.length).toBe(1);
  });
});
