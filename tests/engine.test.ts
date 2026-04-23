import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../src/country/index.js';
import { AccountingEngine, createAccountingEngine } from '../src/engine.js';
import { Money } from '../src/money.js';
import type { AccountType } from '../src/types/core.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(() => {
  for (const name of Object.keys(mongoose.connection.models)) {
    if (name.startsWith('Eng_')) delete mongoose.connection.models[name];
  }
});

let _engCounter = 0;
const engModelNames = () => {
  const i = ++_engCounter;
  return {
    account: `Eng_Acct_${i}`,
    journalEntry: `Eng_JE_${i}`,
    fiscalPeriod: `Eng_FP_${i}`,
    budget: `Eng_B_${i}`,
    reconciliation: `Eng_R_${i}`,
  };
};

// Minimal country pack for testing
const testAccountTypes: AccountType[] = [
  {
    code: '1010',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: null,
  },
  {
    code: '2100',
    name: 'AP',
    category: 'Balance Sheet-Liability',
    description: 'Payables',
    parentCode: null,
  },
  {
    code: '3600',
    name: 'Retained Earnings',
    category: 'Balance Sheet-Equity',
    description: 'RE',
    parentCode: null,
  },
  {
    code: '4000',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: 'Revenue',
    parentCode: null,
  },
  {
    code: '5000',
    name: 'Expenses',
    category: 'Income Statement-Expense',
    description: 'Expenses',
    parentCode: null,
  },
  {
    code: '1000',
    name: 'Assets Group',
    category: 'Balance Sheet-Asset',
    description: 'Group',
    parentCode: null,
    isGroup: true,
  },
  {
    code: '1099',
    name: 'Total Assets',
    category: 'Balance Sheet-Asset',
    description: 'Total',
    parentCode: null,
    isTotal: true,
  },
];

const testPack = defineCountryPack({
  code: 'TS',
  name: 'Testland',
  defaultCurrency: 'TST',
  accountTypes: testAccountTypes,
});

describe('AccountingEngine', () => {
  describe('createAccountingEngine factory', () => {
    it('returns an AccountingEngine instance', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine).toBeInstanceOf(AccountingEngine);
    });

    it('stores config', () => {
      const config = {
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      };
      const engine = createAccountingEngine(config);
      expect(engine.config).toBe(config);
    });

    it('stores country pack', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine.country).toBe(testPack);
    });

    it('stores currency', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'CAD',
        modelNames: engModelNames(),
      });
      expect(engine.currency).toBe('CAD');
    });

    it('exposes Money module', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine.money).toBe(Money);
    });
  });

  describe('account type helpers', () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'TST',
      modelNames: engModelNames(),
    });

    it('getPostingAccountTypes filters out groups and totals', () => {
      const posting = engine.getPostingAccountTypes();
      expect(posting.every((at) => !at.isGroup && !at.isTotal)).toBe(true);
      expect(posting.length).toBe(5); // 5 posting accounts
    });

    it('isValidAccountType returns true for valid codes', () => {
      expect(engine.isValidAccountType('1010')).toBe(true);
      expect(engine.isValidAccountType('4000')).toBe(true);
    });

    it('isValidAccountType returns false for unknown codes', () => {
      expect(engine.isValidAccountType('9999')).toBe(false);
    });

    it('getAccountType returns definition for known code', () => {
      const at = engine.getAccountType('1010');
      expect(at).toBeDefined();
      expect(at?.name).toBe('Cash');
    });

    it('getAccountType returns undefined for unknown code', () => {
      expect(engine.getAccountType('9999')).toBeUndefined();
    });
  });

  describe('engine-owned models', () => {
    it('engine.models.Account is a mongoose Model', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        multiTenant: { tenantField: 'business', ref: 'Business' },
        modelNames: engModelNames(),
      });
      expect(engine.models.Account).toBeDefined();
      expect(typeof engine.models.Account.schema.path).toBe('function');
    });

    it('engine.models.JournalEntry is a mongoose Model', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine.models.JournalEntry).toBeDefined();
      expect(typeof engine.models.JournalEntry.schema.path).toBe('function');
    });

    it('engine.models.FiscalPeriod is a mongoose Model', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine.models.FiscalPeriod).toBeDefined();
    });
  });

  describe('multi-tenant vs single-tenant', () => {
    it('works without multiTenant config', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine.models.Account).toBeDefined();
    });

    it('adds org field with multiTenant config', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        multiTenant: { tenantField: 'business', ref: 'Business' },
        modelNames: engModelNames(),
      });
      expect(engine.models.Account.schema.path('business')).toBeDefined();
    });
  });

  describe('fiscal year config', () => {
    it('defaults fiscalYearStartMonth to 1', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        modelNames: engModelNames(),
      });
      expect(engine.config.fiscalYearStartMonth).toBeUndefined();
    });

    it('accepts custom fiscal year start month', () => {
      const engine = createAccountingEngine({
        mongoose: mongoose.connection,
        country: testPack,
        currency: 'TST',
        fiscalYearStartMonth: 4,
        modelNames: engModelNames(),
      });
      expect(engine.config.fiscalYearStartMonth).toBe(4);
    });
  });
});
