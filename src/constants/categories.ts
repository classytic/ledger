/**
 * Account Categories — Single source of truth for account classification.
 */

import type { Category, CategoryKey, MainType, StatementType } from '../types/core.js';

/** All valid categories */
export const CATEGORIES: Readonly<Record<CategoryKey, Category>> = Object.freeze({
  'Balance Sheet-Asset': {
    name: 'Balance Sheet',
    mainType: 'Asset',
    statementType: 'Balance Sheet',
  },
  'Balance Sheet-Liability': {
    name: 'Balance Sheet',
    mainType: 'Liability',
    statementType: 'Balance Sheet',
  },
  'Balance Sheet-Equity': {
    name: 'Balance Sheet',
    mainType: 'Equity',
    statementType: 'Balance Sheet',
  },
  'Income Statement-Income': {
    name: 'Income Statement',
    mainType: 'Income',
    statementType: 'Income Statement',
  },
  'Income Statement-Expense': {
    name: 'Income Statement',
    mainType: 'Expense',
    statementType: 'Income Statement',
  },
});

export const CATEGORY_KEYS = Object.keys(CATEGORIES) as CategoryKey[];

export function isValidCategory(key: string): key is CategoryKey {
  return key in CATEGORIES;
}

export function getCategoryMainType(key: CategoryKey): MainType {
  return CATEGORIES[key].mainType;
}

export function getCategoryStatementType(key: CategoryKey): StatementType {
  return CATEGORIES[key].statementType;
}

export function isBalanceSheet(key: CategoryKey): boolean {
  return CATEGORIES[key].statementType === 'Balance Sheet';
}

export function isIncomeStatement(key: CategoryKey): boolean {
  return CATEGORIES[key].statementType === 'Income Statement';
}

/**
 * Get the normal balance for a main type.
 * Assets & Expenses → debit. Liabilities, Equity & Income → credit.
 */
export function getNormalBalance(mainType: MainType): 'debit' | 'credit' {
  return mainType === 'Asset' || mainType === 'Expense' ? 'debit' : 'credit';
}

/** Build a category key from parts */
export function categoryKey(statement: StatementType, mainType: MainType): CategoryKey {
  return `${statement}-${mainType}` as CategoryKey;
}

/** Extract main type from a category key string */
export function extractMainType(key: string): MainType | null {
  const parts = key.split('-');
  return (parts.length === 2 ? parts[1] : null) as MainType | null;
}

/** Extract statement type from a category key string */
export function extractStatementType(key: string): StatementType | null {
  const parts = key.split('-');
  return (parts.length === 2 ? parts[0] : null) as StatementType | null;
}
