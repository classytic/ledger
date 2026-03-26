/**
 * Multi-Currency Schema Extension Tests
 *
 * Verifies that the multi-currency opt-in fields are correctly added
 * to Account and JournalEntry schemas when enabled, and absent when not.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../src/schemas/journal-entry.schema.js';
import { defineCountryPack } from '../src/country/index.js';
import type { AccountingEngineConfig } from '../src/types/engine.js';
import { createAccountingEngine } from '../src/engine.js';

// ── Minimal country pack ────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'MC', name: 'Multi-Currency Test', defaultCurrency: 'CAD',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '2000', name: 'Payables', category: 'Balance Sheet-Liability', description: 'AP', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '5000', name: 'Expenses', category: 'Income Statement-Expense', description: 'Expenses', parentCode: null, isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
});

// ── Configs ─────────────────────────────────────────────────────────────────

const singleCurrencyConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'CAD',
};

const multiCurrencyConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'CAD',
  multiCurrency: {
    enabled: true,
    currencies: ['USD', 'GBP', 'BDT'],
  },
};

const multiCurrencyNoListConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'CAD',
  multiCurrency: {
    enabled: true,
    // no currencies list — any value accepted
  },
};

// ── Setup ───────────────────────────────────────────────────────────────────

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
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA CREATION — WITHOUT multiCurrency
// ═══════════════════════════════════════════════════════════════════════════════

describe('Schema creation WITHOUT multiCurrency', () => {
  it('Account schema does NOT have a currency field', () => {
    const schema = createAccountSchema(singleCurrencyConfig);
    expect(schema.path('currency')).toBeUndefined();
  });

  it('JournalEntry schema items do NOT have currency/exchangeRate/originalDebit/originalCredit fields', () => {
    const schema = createJournalEntrySchema(singleCurrencyConfig, 'MCTestAcct');

    // journalItems is an array — check sub-paths
    expect(schema.path('journalItems.currency')).toBeUndefined();
    expect(schema.path('journalItems.exchangeRate')).toBeUndefined();
    expect(schema.path('journalItems.originalDebit')).toBeUndefined();
    expect(schema.path('journalItems.originalCredit')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA CREATION — WITH multiCurrency
// ═══════════════════════════════════════════════════════════════════════════════

describe('Schema creation WITH multiCurrency enabled', () => {
  it('Account schema HAS a currency field', () => {
    const schema = createAccountSchema(multiCurrencyConfig);
    expect(schema.path('currency')).toBeDefined();
  });

  it('currency field on Account is of type String', () => {
    const schema = createAccountSchema(multiCurrencyConfig);
    const currencyPath = schema.path('currency');
    expect(currencyPath).toBeDefined();
    expect(currencyPath!.instance).toBe('String');
  });

  it('JournalEntry items HAVE currency, exchangeRate, originalDebit, originalCredit', () => {
    const schema = createJournalEntrySchema(multiCurrencyConfig, 'MCAcctWithCurr');

    expect(schema.path('journalItems.currency')).toBeDefined();
    expect(schema.path('journalItems.exchangeRate')).toBeDefined();
    expect(schema.path('journalItems.originalDebit')).toBeDefined();
    expect(schema.path('journalItems.originalCredit')).toBeDefined();
  });

  it('exchangeRate is of type Number', () => {
    const schema = createJournalEntrySchema(multiCurrencyConfig, 'MCAcctExRate');
    const erPath = schema.path('journalItems.exchangeRate');
    expect(erPath).toBeDefined();
    expect(erPath!.instance).toBe('Number');
  });

  it('originalDebit and originalCredit are of type Number', () => {
    const schema = createJournalEntrySchema(multiCurrencyConfig, 'MCAcctOrigAmts');
    expect(schema.path('journalItems.originalDebit')!.instance).toBe('Number');
    expect(schema.path('journalItems.originalCredit')!.instance).toBe('Number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXCHANGE RATE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('exchangeRate validation', () => {
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;

  beforeAll(() => {
    if (mongoose.models['MCExRateAcct']) delete mongoose.models['MCExRateAcct'];
    AccountModel = mongoose.model('MCExRateAcct', createAccountSchema(multiCurrencyConfig));

    if (mongoose.models['MCExRateJE']) delete mongoose.models['MCExRateJE'];
    JEModel = mongoose.model('MCExRateJE', createJournalEntrySchema(multiCurrencyConfig, 'MCExRateAcct'));
  });

  it('allows null exchangeRate', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, exchangeRate: null, originalDebit: 10000, originalCredit: 0 },
        { account: acc2._id, debit: 0, credit: 10000, exchangeRate: null, originalDebit: 0, originalCredit: 10000 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).resolves.toBeUndefined();
  });

  it('allows positive exchangeRate', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, exchangeRate: 1.35, originalDebit: 7407, originalCredit: 0 },
        { account: acc2._id, debit: 0, credit: 10000, exchangeRate: 1.35, originalDebit: 0, originalCredit: 7407 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).resolves.toBeUndefined();
  });

  it('rejects exchangeRate of 0', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, exchangeRate: 0 },
        { account: acc2._id, debit: 0, credit: 10000, exchangeRate: 1.0 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).rejects.toThrow(/exchangeRate must be greater than zero/);
  });

  it('rejects negative exchangeRate', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, exchangeRate: -1.5 },
        { account: acc2._id, debit: 0, credit: 10000, exchangeRate: 1.0 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).rejects.toThrow(/exchangeRate must be greater than zero/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORIGINAL DEBIT / ORIGINAL CREDIT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('originalDebit / originalCredit validation', () => {
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;

  beforeAll(() => {
    if (mongoose.models['MCOrigAcct']) delete mongoose.models['MCOrigAcct'];
    AccountModel = mongoose.model('MCOrigAcct', createAccountSchema(multiCurrencyConfig));

    if (mongoose.models['MCOrigJE']) delete mongoose.models['MCOrigJE'];
    JEModel = mongoose.model('MCOrigJE', createJournalEntrySchema(multiCurrencyConfig, 'MCOrigAcct'));
  });

  it('allows non-negative integer originalDebit', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, originalDebit: 7500, originalCredit: 0 },
        { account: acc2._id, debit: 0, credit: 10000, originalDebit: 0, originalCredit: 7500 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).resolves.toBeUndefined();
  });

  it('rejects fractional originalDebit', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, originalDebit: 75.5, originalCredit: 0 },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).rejects.toThrow(/must be a non-negative integer/);
  });

  it('rejects negative originalCredit', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 10000, originalDebit: 0, originalCredit: -100 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).rejects.toThrow();
  });

  it('allows zero originalDebit and originalCredit', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, originalDebit: 0, originalCredit: 0 },
        { account: acc2._id, debit: 0, credit: 10000, originalDebit: 0, originalCredit: 0 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CURRENCY ENUM VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('currency enum validation', () => {
  let AccountModel: mongoose.Model<any>;
  let JEModel: mongoose.Model<any>;

  beforeAll(() => {
    if (mongoose.models['MCEnumAcct']) delete mongoose.models['MCEnumAcct'];
    AccountModel = mongoose.model('MCEnumAcct', createAccountSchema(multiCurrencyConfig));

    if (mongoose.models['MCEnumJE']) delete mongoose.models['MCEnumJE'];
    JEModel = mongoose.model('MCEnumJE', createJournalEntrySchema(multiCurrencyConfig, 'MCEnumAcct'));
  });

  it('accepts base currency (CAD)', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: 'CAD' });
    await expect(acc.validate()).resolves.toBeUndefined();
  });

  it('accepts allowed foreign currency (USD)', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: 'USD' });
    await expect(acc.validate()).resolves.toBeUndefined();
  });

  it('accepts allowed foreign currency (GBP)', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: 'GBP' });
    await expect(acc.validate()).resolves.toBeUndefined();
  });

  it('accepts allowed foreign currency (BDT)', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: 'BDT' });
    await expect(acc.validate()).resolves.toBeUndefined();
  });

  it('accepts null currency', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: null });
    await expect(acc.validate()).resolves.toBeUndefined();
  });

  it('rejects disallowed currency (EUR)', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: 'EUR' });
    await expect(acc.validate()).rejects.toThrow();
  });

  it('rejects disallowed currency (JPY)', async () => {
    const acc = new AccountModel({ accountTypeCode: '1000', currency: 'JPY' });
    await expect(acc.validate()).rejects.toThrow();
  });

  it('journal item currency also validates against allowed list', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, currency: 'EUR' },
        { account: acc2._id, debit: 0, credit: 10000, currency: 'EUR' },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).rejects.toThrow();
  });

  it('journal item accepts allowed currency', async () => {
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0, currency: 'USD', originalDebit: 7500, originalCredit: 0 },
        { account: acc2._id, debit: 0, credit: 10000, currency: 'USD', originalDebit: 0, originalCredit: 7500 },
      ],
      totalDebit: 10000, totalCredit: 10000,
    });
    await expect(entry.validate()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CURRENCY FIELD ON ACCOUNT — present vs absent
// ═══════════════════════════════════════════════════════════════════════════════

describe('currency field on Account', () => {
  it('present when multiCurrency is enabled', () => {
    const schema = createAccountSchema(multiCurrencyConfig);
    expect(schema.path('currency')).toBeDefined();
  });

  it('absent when multiCurrency is not enabled', () => {
    const schema = createAccountSchema(singleCurrencyConfig);
    expect(schema.path('currency')).toBeUndefined();
  });

  it('absent when multiCurrency is undefined', () => {
    const config: AccountingEngineConfig = { country: testPack, currency: 'CAD' };
    const schema = createAccountSchema(config);
    expect(schema.path('currency')).toBeUndefined();
  });

  it('accepts any currency when currencies list is omitted', async () => {
    if (mongoose.models['MCNoListAcct']) delete mongoose.models['MCNoListAcct'];
    const Model = mongoose.model('MCNoListAcct', createAccountSchema(multiCurrencyNoListConfig));

    // With no enum restriction, any string should pass
    const acc = new Model({ accountTypeCode: '1000', currency: 'XYZ' });
    await expect(acc.validate()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Backward compatibility — engine without multiCurrency', () => {
  it('createAccountingEngine works without multiCurrency config', () => {
    const engine = createAccountingEngine({ country: testPack, currency: 'CAD' });
    expect(engine).toBeDefined();
    expect(engine.currency).toBe('CAD');
    expect(engine.country).toBe(testPack);
  });

  it('schemas created without multiCurrency function identically to before', async () => {
    const config: AccountingEngineConfig = { country: testPack, currency: 'CAD' };

    if (mongoose.models['MCBackAcct']) delete mongoose.models['MCBackAcct'];
    const AccountModel = mongoose.model('MCBackAcct', createAccountSchema(config));

    if (mongoose.models['MCBackJE']) delete mongoose.models['MCBackJE'];
    const JEModel = mongoose.model('MCBackJE', createJournalEntrySchema(config, 'MCBackAcct'));

    // Account creation works
    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });
    expect(acc1.accountTypeCode).toBe('1000');

    // Journal entry creation works
    const entry = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 5000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 5000 },
      ],
      totalDebit: 5000, totalCredit: 5000,
    });
    await expect(entry.validate()).resolves.toBeUndefined();

    // No currency-related fields exist
    expect(entry.journalItems[0].currency).toBeUndefined();
    expect(entry.journalItems[0].exchangeRate).toBeUndefined();
    expect(entry.journalItems[0].originalDebit).toBeUndefined();
    expect(entry.journalItems[0].originalCredit).toBeUndefined();
  });

  it('double-entry validation still works without multiCurrency', async () => {
    const config: AccountingEngineConfig = { country: testPack, currency: 'CAD' };

    if (mongoose.models['MCBackDE_Acct']) delete mongoose.models['MCBackDE_Acct'];
    const AccountModel = mongoose.model('MCBackDE_Acct', createAccountSchema(config));

    if (mongoose.models['MCBackDE_JE']) delete mongoose.models['MCBackDE_JE'];
    const JEModel = mongoose.model('MCBackDE_JE', createJournalEntrySchema(config, 'MCBackDE_Acct'));

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '4000' });

    // Unbalanced posted entry should fail
    const unbalanced = new JEModel({
      journalType: 'GENERAL', state: 'posted', date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 5000 },
      ],
      totalDebit: 10000, totalCredit: 5000,
    });
    await expect(unbalanced.validate()).rejects.toThrow('Total debit must equal total credit');
  });
});
