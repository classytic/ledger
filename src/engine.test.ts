import { describe, it, expect } from 'vitest';
import { AccountingEngine, createAccountingEngine } from './engine.js';
import { defineCountryPack } from './country/index.js';
import { Money } from './money.js';
import type { AccountType } from './types/core.js';

// Minimal country pack for testing
const testAccountTypes: AccountType[] = [
  { code: '1010', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null },
  { code: '2100', name: 'AP', category: 'Balance Sheet-Liability', description: 'Payables', parentCode: null },
  { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null },
  { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null },
  { code: '5000', name: 'Expenses', category: 'Income Statement-Expense', description: 'Expenses', parentCode: null },
  { code: '1000', name: 'Assets Group', category: 'Balance Sheet-Asset', description: 'Group', parentCode: null, isGroup: true },
  { code: '1099', name: 'Total Assets', category: 'Balance Sheet-Asset', description: 'Total', parentCode: null, isTotal: true },
];

const testPack = defineCountryPack({
  code: 'TS',
  name: 'Testland',
  defaultCurrency: 'TST',
  accountTypes: testAccountTypes,
  taxCodes: {
    GST: { code: 'GST', name: 'GST', taxType: 'GST', rate: 0.05, direction: 'collected', description: '', active: true },
  },
  taxCodesByRegion: { DEFAULT: ['GST'] },
  regions: ['DEFAULT'],
});

describe('AccountingEngine', () => {
  describe('createAccountingEngine factory', () => {
    it('returns an AccountingEngine instance', () => {
      const engine = createAccountingEngine({ country: testPack, currency: 'TST' });
      expect(engine).toBeInstanceOf(AccountingEngine);
    });

    it('stores config', () => {
      const config = { country: testPack, currency: 'TST' };
      const engine = createAccountingEngine(config);
      expect(engine.config).toBe(config);
    });

    it('stores country pack', () => {
      const engine = createAccountingEngine({ country: testPack, currency: 'TST' });
      expect(engine.country).toBe(testPack);
    });

    it('stores currency', () => {
      const engine = createAccountingEngine({ country: testPack, currency: 'CAD' });
      expect(engine.currency).toBe('CAD');
    });

    it('exposes Money module', () => {
      const engine = createAccountingEngine({ country: testPack, currency: 'TST' });
      expect(engine.money).toBe(Money);
    });
  });

  describe('account type helpers', () => {
    const engine = createAccountingEngine({ country: testPack, currency: 'TST' });

    it('getPostingAccountTypes filters out groups and totals', () => {
      const posting = engine.getPostingAccountTypes();
      expect(posting.every(at => !at.isGroup && !at.isTotal)).toBe(true);
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
      expect(at!.name).toBe('Cash');
    });

    it('getAccountType returns undefined for unknown code', () => {
      expect(engine.getAccountType('9999')).toBeUndefined();
    });

    it('getTaxCodesForRegion returns tax codes', () => {
      const codes = engine.getTaxCodesForRegion('DEFAULT');
      expect(codes).toHaveLength(1);
      expect(codes[0].code).toBe('GST');
    });

    it('getTaxCodesForRegion returns empty for unknown region', () => {
      expect(engine.getTaxCodesForRegion('UNKNOWN')).toEqual([]);
    });
  });

  describe('schema factories', () => {
    const engine = createAccountingEngine({
      country: testPack,
      currency: 'TST',
      multiTenant: { orgField: 'business', orgRef: 'Business' },
    });

    it('createAccountSchema returns a Mongoose schema', () => {
      const schema = engine.createAccountSchema();
      expect(schema).toBeDefined();
      expect(typeof schema.path).toBe('function');
    });

    it('createJournalEntrySchema returns a Mongoose schema', () => {
      const schema = engine.createJournalEntrySchema('Account');
      expect(schema).toBeDefined();
      expect(typeof schema.path).toBe('function');
    });

    it('createFiscalPeriodSchema returns a Mongoose schema', () => {
      const schema = engine.createFiscalPeriodSchema();
      expect(schema).toBeDefined();
      expect(typeof schema.path).toBe('function');
    });

    it('createAccountSchema respects indexes=false', () => {
      const schema = engine.createAccountSchema({ indexes: false });
      expect(schema).toBeDefined();
    });

    it('createJournalEntrySchema respects autoReference=false', () => {
      const schema = engine.createJournalEntrySchema('Account', { autoReference: false });
      expect(schema).toBeDefined();
    });
  });

  describe('multi-tenant vs single-tenant', () => {
    it('works without multiTenant config', () => {
      const engine = createAccountingEngine({ country: testPack, currency: 'TST' });
      const schema = engine.createAccountSchema();
      expect(schema).toBeDefined();
    });

    it('adds org field with multiTenant config', () => {
      const engine = createAccountingEngine({
        country: testPack,
        currency: 'TST',
        multiTenant: { orgField: 'business', orgRef: 'Business' },
      });
      const schema = engine.createAccountSchema();
      expect(schema.path('business')).toBeDefined();
    });
  });

  describe('fiscal year config', () => {
    it('defaults fiscalYearStartMonth to 1', () => {
      const engine = createAccountingEngine({ country: testPack, currency: 'TST' });
      expect(engine.config.fiscalYearStartMonth).toBeUndefined();
    });

    it('accepts custom fiscal year start month', () => {
      const engine = createAccountingEngine({
        country: testPack, currency: 'TST',
        fiscalYearStartMonth: 4,
      });
      expect(engine.config.fiscalYearStartMonth).toBe(4);
    });
  });
});
