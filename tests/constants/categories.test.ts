import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_KEYS,
  categoryKey,
  extractMainType,
  extractStatementType,
  getCategoryMainType,
  getCategoryStatementType,
  getNormalBalance,
  isBalanceSheet,
  isIncomeStatement,
  isValidCategory,
} from '../../src/constants/categories.js';

describe('Categories', () => {
  it('has exactly 5 categories', () => {
    expect(Object.keys(CATEGORIES)).toHaveLength(5);
  });

  it('validates known categories', () => {
    expect(isValidCategory('Balance Sheet-Asset')).toBe(true);
    expect(isValidCategory('Income Statement-Expense')).toBe(true);
    expect(isValidCategory('Invalid-Type')).toBe(false);
  });

  it('extracts main type', () => {
    expect(getCategoryMainType('Balance Sheet-Asset')).toBe('Asset');
    expect(getCategoryMainType('Income Statement-Income')).toBe('Income');
  });

  it('detects balance sheet categories', () => {
    expect(isBalanceSheet('Balance Sheet-Asset')).toBe(true);
    expect(isBalanceSheet('Balance Sheet-Liability')).toBe(true);
    expect(isBalanceSheet('Income Statement-Income')).toBe(false);
  });

  it('detects income statement categories', () => {
    expect(isIncomeStatement('Income Statement-Income')).toBe(true);
    expect(isIncomeStatement('Income Statement-Expense')).toBe(true);
    expect(isIncomeStatement('Balance Sheet-Equity')).toBe(false);
  });

  it('determines normal balance', () => {
    expect(getNormalBalance('Asset')).toBe('debit');
    expect(getNormalBalance('Expense')).toBe('debit');
    expect(getNormalBalance('Liability')).toBe('credit');
    expect(getNormalBalance('Equity')).toBe('credit');
    expect(getNormalBalance('Income')).toBe('credit');
  });

  it('extracts from category key strings', () => {
    expect(extractMainType('Balance Sheet-Asset')).toBe('Asset');
    expect(extractStatementType('Income Statement-Expense')).toBe('Income Statement');
  });

  it('extractMainType returns null for malformed keys', () => {
    expect(extractMainType('NoHyphen')).toBeNull();
    expect(extractMainType('')).toBeNull();
  });

  it('extractStatementType returns null for malformed keys', () => {
    expect(extractStatementType('NoHyphen')).toBeNull();
    expect(extractStatementType('')).toBeNull();
  });

  describe('getCategoryStatementType', () => {
    it('returns Balance Sheet for BS categories', () => {
      expect(getCategoryStatementType('Balance Sheet-Asset')).toBe('Balance Sheet');
      expect(getCategoryStatementType('Balance Sheet-Liability')).toBe('Balance Sheet');
      expect(getCategoryStatementType('Balance Sheet-Equity')).toBe('Balance Sheet');
    });

    it('returns Income Statement for IS categories', () => {
      expect(getCategoryStatementType('Income Statement-Income')).toBe('Income Statement');
      expect(getCategoryStatementType('Income Statement-Expense')).toBe('Income Statement');
    });
  });

  describe('categoryKey', () => {
    it('builds key from parts', () => {
      expect(categoryKey('Balance Sheet', 'Asset')).toBe('Balance Sheet-Asset');
      expect(categoryKey('Income Statement', 'Expense')).toBe('Income Statement-Expense');
    });
  });

  describe('CATEGORY_KEYS', () => {
    it('has exactly 5 keys', () => {
      expect(CATEGORY_KEYS).toHaveLength(5);
    });

    it('all keys are valid categories', () => {
      for (const key of CATEGORY_KEYS) {
        expect(isValidCategory(key)).toBe(true);
      }
    });
  });
});
