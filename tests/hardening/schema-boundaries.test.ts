/**
 * Schema Boundary & State Machine Tests
 *
 * Validates journal entry state transitions, validation hooks,
 * and schema-level data integrity. Beats Odoo's state machine
 * tests by covering every transition path and boundary value.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

const testPack = defineCountryPack({
  code: 'HT', name: 'Hardening Test', defaultCurrency: 'USD',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '2000', name: 'AP', category: 'Balance Sheet-Liability', description: 'AP', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Rev', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '5000', name: 'COGS', category: 'Income Statement-Expense', description: 'COGS', parentCode: null, isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
});

const config: AccountingEngineConfig = { country: testPack, currency: 'USD' };

let mongod: MongoMemoryServer;
let JE: mongoose.Model<any>;
let Account: mongoose.Model<any>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const name of ['HT_Account', 'HT_JournalEntry']) {
    if (mongoose.models[name]) delete mongoose.models[name];
  }

  Account = mongoose.model('HT_Account', createAccountSchema(config));
  JE = mongoose.model('HT_JournalEntry', createJournalEntrySchema(config, 'HT_Account'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key].deleteMany({});
  }
});

async function createAccounts() {
  const cash = await Account.create({ accountTypeCode: '1000', name: 'Cash', active: true });
  const ap = await Account.create({ accountTypeCode: '2000', name: 'AP', active: true });
  const rev = await Account.create({ accountTypeCode: '4000', name: 'Revenue', active: true });
  return { cash, ap, rev };
}

// ── State Machine ─────────────────────────────────────────────────────────

describe('Journal Entry — state machine', () => {
  it('defaults to draft state', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      journalItems: [
        { account: cash._id, debit: 1000, credit: 0 },
        { account: ap._id, debit: 0, credit: 1000 },
      ],
    });
    expect(entry.state).toBe('draft');
  });

  it('draft can be posted when balanced', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      journalItems: [
        { account: cash._id, debit: 5000, credit: 0 },
        { account: ap._id, debit: 0, credit: 5000 },
      ],
    });
    entry.state = 'posted';
    await entry.save();
    expect(entry.state).toBe('posted');
  });

  it('draft allows unbalanced entries', async () => {
    const { cash } = await createAccounts();
    const entry = await JE.create({
      state: 'draft',
      journalItems: [
        { account: cash._id, debit: 1000, credit: 0 },
      ],
    });
    expect(entry.state).toBe('draft');
  });

  it('posting an unbalanced entry throws', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      journalItems: [
        { account: cash._id, debit: 1000, credit: 0 },
        { account: ap._id, debit: 0, credit: 999 },
      ],
    });
    entry.state = 'posted';
    // Use validate() to trigger pre-validate hook without hitting post-save error middleware
    const err = await entry.validate().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('debit must equal total credit');
  });

  it('posting with fewer than 2 items throws', async () => {
    const { cash } = await createAccounts();
    const entry = await JE.create({
      journalItems: [
        { account: cash._id, debit: 1000, credit: 0 },
      ],
    });
    entry.state = 'posted';
    const err = await entry.validate().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('at least 2 journal items');
  });
});

// ── Journal Item Validation ───────────────────────────────────────────────

describe('Journal Entry — item validation', () => {
  it('rejects both debit and credit > 0 on same item', async () => {
    const { cash, ap } = await createAccounts();
    const doc = new JE({
      state: 'posted',
      journalItems: [
        { account: cash._id, debit: 1000, credit: 500 },
        { account: ap._id, debit: 0, credit: 500 },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
  });

  it('rejects non-integer amounts', async () => {
    const { cash, ap } = await createAccounts();
    const doc = new JE({
      state: 'posted',
      journalItems: [
        { account: cash._id, debit: 100.5, credit: 0 },
        { account: ap._id, debit: 0, credit: 100.5 },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.message).toContain('non-negative integer');
  });

  it('rejects negative amounts', async () => {
    const { cash, ap } = await createAccounts();
    const doc = new JE({
      state: 'posted',
      journalItems: [
        { account: cash._id, debit: -1000, credit: 0 },
        { account: ap._id, debit: 0, credit: 1000 },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    // Mongoose min:0 fires before custom validator
    expect(err!.message).toMatch(/less than minimum|non-negative integer/);
  });

  it('accepts zero debit and zero credit (valid line)', async () => {
    const { cash, ap, rev } = await createAccounts();
    // Zero lines are allowed in draft
    const entry = await JE.create({
      state: 'draft',
      journalItems: [
        { account: cash._id, debit: 0, credit: 0 },
        { account: ap._id, debit: 0, credit: 0 },
        { account: rev._id, debit: 0, credit: 0 },
      ],
    });
    expect(entry.journalItems).toHaveLength(3);
  });
});

// ── Double-Entry Conservation Law ─────────────────────────────────────────

describe('Journal Entry — conservation law', () => {
  it('totalDebit always equals totalCredit on posted entries', async () => {
    const { cash, ap, rev } = await createAccounts();

    // Multi-line entry: cash in, revenue earned, AP adjustment
    const entry = await JE.create({
      state: 'posted',
      journalItems: [
        { account: cash._id, debit: 10000, credit: 0 },
        { account: ap._id, debit: 0, credit: 3000 },
        { account: rev._id, debit: 0, credit: 7000 },
      ],
    });

    expect(entry.totalDebit).toBe(10000);
    expect(entry.totalCredit).toBe(10000);
    expect(entry.totalDebit).toBe(entry.totalCredit);
  });

  it('pre-save hook computes totals for drafts too', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      state: 'draft',
      journalItems: [
        { account: cash._id, debit: 500, credit: 0 },
        { account: ap._id, debit: 0, credit: 300 },
      ],
    });
    // Totals are computed even for unbalanced drafts
    expect(entry.totalDebit).toBe(500);
    expect(entry.totalCredit).toBe(300);
  });

  it('1-cent imbalance is caught', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      journalItems: [
        { account: cash._id, debit: 10001, credit: 0 },
        { account: ap._id, debit: 0, credit: 10000 },
      ],
    });
    entry.state = 'posted';
    const err = await entry.validate().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('debit must equal total credit');
  });
});

// ── Reference Number Auto-Generation ──────────────────────────────────────

describe('Journal Entry — reference numbers', () => {
  it('auto-generates reference on first save', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      date: new Date('2025-03-15'),
      journalType: 'SALES',
      journalItems: [
        { account: cash._id, debit: 1000, credit: 0 },
        { account: ap._id, debit: 0, credit: 1000 },
      ],
    });
    expect(entry.referenceNumber).toMatch(/^SALES\/2025\/03\/0001$/);
  });

  it('increments sequence for same journal type and month', async () => {
    const { cash, ap } = await createAccounts();
    const items = [
      { account: cash._id, debit: 1000, credit: 0 },
      { account: ap._id, debit: 0, credit: 1000 },
    ];

    const e1 = await JE.create({ date: new Date('2025-03-01'), journalType: 'SALES', journalItems: items });
    const e2 = await JE.create({ date: new Date('2025-03-15'), journalType: 'SALES', journalItems: items });
    const e3 = await JE.create({ date: new Date('2025-03-28'), journalType: 'SALES', journalItems: items });

    expect(e1.referenceNumber).toBe('SALES/2025/03/0001');
    expect(e2.referenceNumber).toBe('SALES/2025/03/0002');
    expect(e3.referenceNumber).toBe('SALES/2025/03/0003');
  });

  it('resets sequence for different month', async () => {
    const { cash, ap } = await createAccounts();
    const items = [
      { account: cash._id, debit: 1000, credit: 0 },
      { account: ap._id, debit: 0, credit: 1000 },
    ];

    await JE.create({ date: new Date('2025-03-15'), journalType: 'SALES', journalItems: items });
    const april = await JE.create({ date: new Date('2025-04-01'), journalType: 'SALES', journalItems: items });

    expect(april.referenceNumber).toBe('SALES/2025/04/0001');
  });

  it('different journal types have independent sequences', async () => {
    const { cash, ap } = await createAccounts();
    const items = [
      { account: cash._id, debit: 1000, credit: 0 },
      { account: ap._id, debit: 0, credit: 1000 },
    ];

    const sales = await JE.create({ date: new Date('2025-03-15'), journalType: 'SALES', journalItems: items });
    const purchases = await JE.create({ date: new Date('2025-03-15'), journalType: 'PURCHASES', journalItems: items });

    expect(sales.referenceNumber).toBe('SALES/2025/03/0001');
    expect(purchases.referenceNumber).toBe('PURCHASES/2025/03/0001');
  });
});

// ── Journal Type Enum Validation ──────────────────────────────────────────

describe('Journal Entry — journalType enum', () => {
  it('accepts all built-in journal types', async () => {
    const { cash, ap } = await createAccounts();
    const items = [
      { account: cash._id, debit: 100, credit: 0 },
      { account: ap._id, debit: 0, credit: 100 },
    ];

    for (const jt of ['SALES', 'PURCHASES', 'GENERAL', 'MISC']) {
      const entry = await JE.create({ journalType: jt, journalItems: items });
      expect(entry.journalType).toBe(jt);
    }
  });

  it('rejects invalid journal type', async () => {
    const { cash, ap } = await createAccounts();
    const doc = new JE({
      journalType: 'INVALID_TYPE',
      journalItems: [
        { account: cash._id, debit: 100, credit: 0 },
        { account: ap._id, debit: 0, credit: 100 },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors?.journalType).toBeDefined();
  });

  it('defaults to MISC', async () => {
    const { cash, ap } = await createAccounts();
    const entry = await JE.create({
      journalItems: [
        { account: cash._id, debit: 100, credit: 0 },
        { account: ap._id, debit: 0, credit: 100 },
      ],
    });
    expect(entry.journalType).toBe('MISC');
  });
});
