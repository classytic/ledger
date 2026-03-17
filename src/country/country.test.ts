import { describe, it, expect } from 'vitest';
import { defineCountryPack } from './index.js';
import type { CountryPackInput } from './index.js';
import type { AccountType } from '../types/core.js';

const mockAccountTypes: AccountType[] = [
  {
    code: '1010', name: 'Cash', category: 'Balance Sheet-Asset',
    description: 'Cash at bank', parentCode: null,
  },
  {
    code: '2100', name: 'Accounts Payable', category: 'Balance Sheet-Liability',
    description: 'Trade payables', parentCode: null,
  },
  {
    code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity',
    description: 'Retained earnings', parentCode: null,
  },
  {
    code: '4000', name: 'Sales Revenue', category: 'Income Statement-Income',
    description: 'Revenue from sales', parentCode: null,
  },
  {
    code: '5000', name: 'Cost of Goods Sold', category: 'Income Statement-Expense',
    description: 'COGS', parentCode: null,
  },
  {
    code: '1000', name: 'Current Assets', category: 'Balance Sheet-Asset',
    description: 'Group: current assets', parentCode: null,
    isGroup: true,
  },
  {
    code: '1099', name: 'Total Current Assets', category: 'Balance Sheet-Asset',
    description: 'Total: current assets', parentCode: null,
    isTotal: true,
    totalAccountTypes: [{ account: '1010', operation: '+' }],
  },
];

const mockInput: CountryPackInput = {
  code: 'TS',
  name: 'Testland',
  defaultCurrency: 'TST',
  accountTypes: mockAccountTypes,
  taxCodes: {
    GST: {
      code: 'GST', name: 'Goods & Services Tax', taxType: 'GST',
      rate: 0.05, direction: 'collected', description: '5% GST', active: true,
    },
    PST: {
      code: 'PST', name: 'Provincial Sales Tax', taxType: 'PST',
      rate: 0.07, direction: 'collected', province: 'BC',
      description: '7% PST', active: true,
    },
  },
  taxCodesByRegion: {
    BC: ['GST', 'PST'],
    AB: ['GST'],
  },
  regions: ['BC', 'AB'],
};

describe('defineCountryPack', () => {
  const pack = defineCountryPack(mockInput);

  it('preserves static properties', () => {
    expect(pack.code).toBe('TS');
    expect(pack.name).toBe('Testland');
    expect(pack.defaultCurrency).toBe('TST');
    expect(pack.regions).toEqual(['BC', 'AB']);
  });

  describe('getPostingAccountTypes', () => {
    it('filters out groups and totals', () => {
      const posting = pack.getPostingAccountTypes();
      expect(posting.every(at => !at.isGroup && !at.isTotal)).toBe(true);
    });

    it('includes regular posting accounts', () => {
      const posting = pack.getPostingAccountTypes();
      const codes = posting.map(at => at.code);
      expect(codes).toContain('1010');
      expect(codes).toContain('2100');
      expect(codes).toContain('4000');
    });

    it('excludes group accounts', () => {
      const posting = pack.getPostingAccountTypes();
      const codes = posting.map(at => at.code);
      expect(codes).not.toContain('1000');
    });

    it('excludes total accounts', () => {
      const posting = pack.getPostingAccountTypes();
      const codes = posting.map(at => at.code);
      expect(codes).not.toContain('1099');
    });
  });

  describe('getAccountType', () => {
    it('returns account type by code', () => {
      const at = pack.getAccountType('1010');
      expect(at).toBeDefined();
      expect(at!.name).toBe('Cash');
    });

    it('returns undefined for unknown code', () => {
      expect(pack.getAccountType('9999')).toBeUndefined();
    });
  });

  describe('isValidAccountType', () => {
    it('returns true for known codes', () => {
      expect(pack.isValidAccountType('1010')).toBe(true);
      expect(pack.isValidAccountType('4000')).toBe(true);
    });

    it('returns false for unknown codes', () => {
      expect(pack.isValidAccountType('9999')).toBe(false);
      expect(pack.isValidAccountType('')).toBe(false);
    });
  });

  describe('isPostingAccount', () => {
    it('returns true for posting accounts', () => {
      expect(pack.isPostingAccount('1010')).toBe(true);
      expect(pack.isPostingAccount('2100')).toBe(true);
    });

    it('returns false for group accounts', () => {
      expect(pack.isPostingAccount('1000')).toBe(false);
    });

    it('returns false for total accounts', () => {
      expect(pack.isPostingAccount('1099')).toBe(false);
    });

    it('returns false for unknown codes', () => {
      expect(pack.isPostingAccount('9999')).toBe(false);
    });
  });

  describe('getTaxCodesForRegion', () => {
    it('returns tax codes for known region', () => {
      const bcTaxes = pack.getTaxCodesForRegion('BC');
      expect(bcTaxes).toHaveLength(2);
      expect(bcTaxes.map(t => t.code)).toEqual(['GST', 'PST']);
    });

    it('returns single tax code for region with one', () => {
      const abTaxes = pack.getTaxCodesForRegion('AB');
      expect(abTaxes).toHaveLength(1);
      expect(abTaxes[0].code).toBe('GST');
    });

    it('returns empty array for unknown region', () => {
      expect(pack.getTaxCodesForRegion('XX')).toEqual([]);
    });
  });

  describe('flattenAccountTypes', () => {
    it('returns all account types', () => {
      const all = pack.flattenAccountTypes();
      expect(all).toHaveLength(mockAccountTypes.length);
    });
  });
});
