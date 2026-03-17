import { describe, it, expect } from 'vitest';
import {
  isVirtualTaxAccount, computeEndingBalance, calculateTotal,
  isBalanceSheetAccountType, isIncomeStatementAccountType,
  buildAccountTypeMap,
} from './account-helpers.js';
import type { AccountType } from '../types/core.js';

describe('Account Helpers', () => {
  describe('isVirtualTaxAccount', () => {
    it('detects tax sub-accounts', () => {
      expect(isVirtualTaxAccount('2680.GST.COLLECTED')).toBe(true);
      expect(isVirtualTaxAccount('1066.GST-HST.REFUND')).toBe(true);
      expect(isVirtualTaxAccount('2680.HST13.ITC')).toBe(true);
    });

    it('rejects regular accounts', () => {
      expect(isVirtualTaxAccount('8000')).toBe(false);
      expect(isVirtualTaxAccount('1060')).toBe(false);
      expect(isVirtualTaxAccount('2680')).toBe(false);
    });
  });

  describe('computeEndingBalance', () => {
    it('assets: debit - credit', () => {
      expect(computeEndingBalance('Balance Sheet-Asset', 100000, 20000)).toBe(80000);
    });

    it('expenses: debit - credit', () => {
      expect(computeEndingBalance('Income Statement-Expense', 50000, 10000)).toBe(40000);
    });

    it('liabilities: credit - debit', () => {
      expect(computeEndingBalance('Balance Sheet-Liability', 20000, 100000)).toBe(80000);
    });

    it('income: credit - debit', () => {
      expect(computeEndingBalance('Income Statement-Income', 10000, 500000)).toBe(490000);
    });

    it('equity: credit - debit', () => {
      expect(computeEndingBalance('Balance Sheet-Equity', 0, 300000)).toBe(300000);
    });
  });

  describe('calculateTotal', () => {
    it('sums with + operations', () => {
      const formula = [
        { account: 'A', operation: '+' as const },
        { account: 'B', operation: '+' as const },
      ];
      const map = new Map([['A', 10000], ['B', 20000]]);
      expect(calculateTotal(formula, map)).toBe(30000);
    });

    it('subtracts with - operations', () => {
      const formula = [
        { account: 'A', operation: '+' as const },
        { account: 'B', operation: '-' as const },
      ];
      const map = new Map([['A', 100000], ['B', 30000]]);
      expect(calculateTotal(formula, map)).toBe(70000);
    });

    it('treats missing accounts as 0', () => {
      const formula = [
        { account: 'A', operation: '+' as const },
        { account: 'MISSING', operation: '+' as const },
      ];
      const map = new Map([['A', 50000]]);
      expect(calculateTotal(formula, map)).toBe(50000);
    });

    it('handles empty formula', () => {
      const map = new Map([['A', 10000]]);
      expect(calculateTotal([], map)).toBe(0);
    });

    it('handles all subtractions', () => {
      const formula = [
        { account: 'A', operation: '-' as const },
        { account: 'B', operation: '-' as const },
      ];
      const map = new Map([['A', 10000], ['B', 5000]]);
      expect(calculateTotal(formula, map)).toBe(-15000);
    });
  });

  describe('computeEndingBalance (extended)', () => {
    it('handles zero debits and credits', () => {
      expect(computeEndingBalance('Balance Sheet-Asset', 0, 0)).toBe(0);
      expect(computeEndingBalance('Income Statement-Income', 0, 0)).toBe(0);
    });

    it('handles equal debits and credits', () => {
      expect(computeEndingBalance('Balance Sheet-Asset', 50000, 50000)).toBe(0);
      expect(computeEndingBalance('Balance Sheet-Liability', 50000, 50000)).toBe(0);
    });
  });

  describe('isBalanceSheetAccountType', () => {
    const makeAccountType = (category: string): AccountType => ({
      code: '1010', name: 'Test', category: category as any,
      description: 'Test', parentCode: null,
    });

    it('returns true for Asset accounts', () => {
      expect(isBalanceSheetAccountType(makeAccountType('Balance Sheet-Asset'))).toBe(true);
    });

    it('returns true for Liability accounts', () => {
      expect(isBalanceSheetAccountType(makeAccountType('Balance Sheet-Liability'))).toBe(true);
    });

    it('returns true for Equity accounts', () => {
      expect(isBalanceSheetAccountType(makeAccountType('Balance Sheet-Equity'))).toBe(true);
    });

    it('returns false for Income accounts', () => {
      expect(isBalanceSheetAccountType(makeAccountType('Income Statement-Income'))).toBe(false);
    });

    it('returns false for Expense accounts', () => {
      expect(isBalanceSheetAccountType(makeAccountType('Income Statement-Expense'))).toBe(false);
    });
  });

  describe('isIncomeStatementAccountType', () => {
    const makeAccountType = (category: string): AccountType => ({
      code: '4000', name: 'Test', category: category as any,
      description: 'Test', parentCode: null,
    });

    it('returns true for Income accounts', () => {
      expect(isIncomeStatementAccountType(makeAccountType('Income Statement-Income'))).toBe(true);
    });

    it('returns true for Expense accounts', () => {
      expect(isIncomeStatementAccountType(makeAccountType('Income Statement-Expense'))).toBe(true);
    });

    it('returns false for Asset accounts', () => {
      expect(isIncomeStatementAccountType(makeAccountType('Balance Sheet-Asset'))).toBe(false);
    });

    it('returns false for Liability accounts', () => {
      expect(isIncomeStatementAccountType(makeAccountType('Balance Sheet-Liability'))).toBe(false);
    });
  });

  describe('buildAccountTypeMap', () => {
    const types: AccountType[] = [
      { code: '1010', name: 'Cash', category: 'Balance Sheet-Asset', description: '', parentCode: null },
      { code: '2100', name: 'AP', category: 'Balance Sheet-Liability', description: '', parentCode: null },
      { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: '', parentCode: null },
    ];

    it('builds map with all account types', () => {
      const map = buildAccountTypeMap(types);
      expect(map.size).toBe(3);
    });

    it('maps by code', () => {
      const map = buildAccountTypeMap(types);
      expect(map.get('1010')?.name).toBe('Cash');
      expect(map.get('2100')?.name).toBe('AP');
      expect(map.get('4000')?.name).toBe('Revenue');
    });

    it('returns undefined for missing codes', () => {
      const map = buildAccountTypeMap(types);
      expect(map.get('9999')).toBeUndefined();
    });

    it('handles empty array', () => {
      const map = buildAccountTypeMap([]);
      expect(map.size).toBe(0);
    });
  });
});
