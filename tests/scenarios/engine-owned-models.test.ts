/**
 * Scenario: Engine-Owned Models (flow/promo pattern)
 *
 * Verifies the new engine ownership API where:
 *   createAccountingEngine({ mongoose: connection, ... })
 * eagerly creates models and repositories — no manual wiring.
 *
 * This is the primary integration pattern for consumers (fajr-be-arc etc.)
 * that use framework auto-discovery.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';
import { legacyTrialBalance } from '../helpers/legacy-report-view.js';

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

const testPack = defineCountryPack({
  code: 'TS',
  name: 'Test',
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
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Clear models between tests to avoid OverwriteModelError across describe blocks
  for (const name of Object.keys(mongoose.connection.models)) {
    if (name.startsWith('EOM_')) delete mongoose.connection.models[name];
  }
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key].deleteMany({});
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Engine eagerly creates models from config
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Engine ownership — models', () => {
  it('engine.models is populated when mongoose is provided', () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Acct_1',
        journalEntry: 'EOM_JE_1',
        fiscalPeriod: 'EOM_FP_1',
        budget: 'EOM_B_1',
        reconciliation: 'EOM_R_1',
      },
      country: testPack,
      currency: 'USD',
    });

    expect(engine.models).toBeDefined();
    expect(engine.models.Account).toBeDefined();
    expect(engine.models.JournalEntry).toBeDefined();
    expect(engine.models.FiscalPeriod).toBeDefined();
    expect(engine.models.Budget).toBeDefined();
    expect(engine.models.Reconciliation).toBeDefined();
  });

  it('model names match the config overrides', () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Acct_2',
        journalEntry: 'EOM_JE_2',
        fiscalPeriod: 'EOM_FP_2',
        budget: 'EOM_B_2',
        reconciliation: 'EOM_R_2',
      },
      country: testPack,
      currency: 'USD',
    });

    expect(engine.models.Account.modelName).toBe('EOM_Acct_2');
    expect(engine.models.JournalEntry.modelName).toBe('EOM_JE_2');
  });

  it('createAccountingEngine throws when mongoose is not provided', () => {
    // @ts-expect-error — intentionally omit required field
    expect(() => createAccountingEngine({ country: testPack, currency: 'USD' })).toThrow(
      'mongoose` connection is required',
    );
  });

  it('reusing model names on same connection returns existing models (idempotent)', () => {
    const e1 = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Shared_Acct',
        journalEntry: 'EOM_Shared_JE',
        fiscalPeriod: 'EOM_Shared_FP',
        budget: 'EOM_Shared_B',
        reconciliation: 'EOM_Shared_R',
      },
      country: testPack,
      currency: 'USD',
    });

    const e2 = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Shared_Acct',
        journalEntry: 'EOM_Shared_JE',
        fiscalPeriod: 'EOM_Shared_FP',
        budget: 'EOM_Shared_B',
        reconciliation: 'EOM_Shared_R',
      },
      country: testPack,
      currency: 'USD',
    });

    // Same underlying model — no OverwriteModelError
    expect(e1.models.Account).toBe(e2.models.Account);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Engine exposes fully-wired repositories
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Engine ownership — repositories', () => {
  it('engine.repositories.accounts has domain methods', () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Acct_Repo',
        journalEntry: 'EOM_JE_Repo',
        fiscalPeriod: 'EOM_FP_Repo',
        budget: 'EOM_B_Repo',
        reconciliation: 'EOM_R_Repo',
      },
      country: testPack,
      currency: 'USD',
    });

    expect(engine.repositories.accounts).toBeDefined();
    expect(typeof engine.repositories.accounts.seedAccounts).toBe('function');
    expect(typeof engine.repositories.accounts.bulkCreate).toBe('function');
  });

  it('engine.repositories.journalEntries has post/reverse/unpost/duplicate', () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Acct_JE',
        journalEntry: 'EOM_JE_JE',
        fiscalPeriod: 'EOM_FP_JE',
        budget: 'EOM_B_JE',
        reconciliation: 'EOM_R_JE',
      },
      country: testPack,
      currency: 'USD',
    });

    const repo = engine.repositories.journalEntries;
    expect(typeof repo.post).toBe('function');
    expect(typeof repo.reverse).toBe('function');
    expect(typeof repo.unpost).toBe('function');
    expect(typeof repo.duplicate).toBe('function');
  });

  it('seedAccounts creates all posting accounts from country pack', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Seed_Acct',
        journalEntry: 'EOM_Seed_JE',
        fiscalPeriod: 'EOM_Seed_FP',
        budget: 'EOM_Seed_B',
        reconciliation: 'EOM_Seed_R',
      },
      country: testPack,
      currency: 'USD',
    });

    const result = await engine.repositories.accounts.seedAccounts(undefined);
    expect(result.created).toBeGreaterThan(0);

    const count = await engine.models.Account.countDocuments({});
    expect(count).toBe(result.created);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Engine exposes reports bound to owned models
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Engine ownership — reports', () => {
  it('engine.reports is populated and usable', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_Rep_Acct',
        journalEntry: 'EOM_Rep_JE',
        fiscalPeriod: 'EOM_Rep_FP',
        budget: 'EOM_Rep_B',
        reconciliation: 'EOM_Rep_R',
      },
      country: testPack,
      currency: 'USD',
      retainedEarningsAccountCode: '3600',
    });

    await engine.repositories.accounts.seedAccounts(undefined);

    // Seed a balanced entry
    const accounts = await engine.models.Account.find({}).lean();
    const cash = accounts.find((a: any) => a.accountTypeCode === '1001');
    const revenue = accounts.find((a: any) => a.accountTypeCode === '4010');

    await engine.models.JournalEntry.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2025-01-15'),
      journalItems: [
        { account: (cash as any)._id, debit: 10000, credit: 0 },
        { account: (revenue as any)._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    const tb = await engine.reports.trialBalance({
      dateOption: 'year',
      dateValue: 2025,
    });

    expect(legacyTrialBalance(tb).rows.length).toBeGreaterThan(0);
    const totalD = legacyTrialBalance(tb).rows.reduce((s: number, r: any) => s + r.ending.debit, 0);
    const totalC = legacyTrialBalance(tb).rows.reduce((s: number, r: any) => s + r.ending.credit, 0);
    expect(totalD).toBe(totalC);
  });

  it('createAccountingEngine throws when mongoose is not provided (reports dep)', () => {
    // @ts-expect-error — intentionally omit required field
    expect(() => createAccountingEngine({ country: testPack, currency: 'USD' })).toThrow(
      'mongoose` connection is required',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Full integration: post entry through engine.repositories
// ═════════════════════════════════════════════════════════════════════════════

describe('4. End-to-end integration', () => {
  it('create draft → post via engine.repositories.journalEntries.post()', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      modelNames: {
        account: 'EOM_E2E_Acct',
        journalEntry: 'EOM_E2E_JE',
        fiscalPeriod: 'EOM_E2E_FP',
        budget: 'EOM_E2E_B',
        reconciliation: 'EOM_E2E_R',
      },
      country: testPack,
      currency: 'USD',
    });

    await engine.repositories.accounts.seedAccounts(undefined);
    const accounts = await engine.models.Account.find({}).lean();
    const cash = accounts.find((a: any) => a.accountTypeCode === '1001');
    const revenue = accounts.find((a: any) => a.accountTypeCode === '4010');

    // Create draft via the repository (hooks fire — org check, etc.)
    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-02-10'),
      journalItems: [
        { account: (cash as any)._id, debit: 5000, credit: 0 },
        { account: (revenue as any)._id, debit: 0, credit: 5000 },
      ],
    } as any);

    expect((draft as any).state).toBe('draft');

    // Post via the domain method
    const posted = await engine.repositories.journalEntries.post((draft as any)._id);
    expect((posted as any).state).toBe('posted');
  });
});
