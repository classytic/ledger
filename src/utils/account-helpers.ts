/**
 * Account Helper Utilities
 */

import { extractMainType } from '../constants/categories.js';
import type { AccountType, CategoryKey, TotalAccountOp } from '../types/core.js';

/**
 * Check if an account type is a virtual tax sub-account.
 * Returns true if the account's parent has `isVirtualTotal: true`.
 * Works for any country pack — no code format assumptions.
 */
export function isVirtualTaxAccount(
  accountType: AccountType,
  accountMap: Map<string, AccountType>,
): boolean {
  if (!accountType.parentCode) return false;
  const parent = accountMap.get(accountType.parentCode);
  return parent?.isVirtualTotal === true;
}

/** Check if an account type is a balance sheet account */
export function isBalanceSheetAccountType(accountType: AccountType): boolean {
  const { category } = accountType;
  return (
    category.endsWith('-Asset') || category.endsWith('-Liability') || category.endsWith('-Equity')
  );
}

/** Check if an account type is an income statement account */
export function isIncomeStatementAccountType(accountType: AccountType): boolean {
  const { category } = accountType;
  return category.endsWith('-Income') || category.endsWith('-Expense');
}

/**
 * Calculate a total from sub-accounts using the totalAccountTypes formula.
 * @param formula - Array of { account, operation } instructions
 * @param balanceMap - Map of account code → balance
 */
export function calculateTotal(
  formula: readonly TotalAccountOp[],
  balanceMap: Map<string, number>,
): number {
  let total = 0;
  for (const item of formula) {
    const balance = balanceMap.get(item.account) ?? 0;
    total += item.operation === '+' ? balance : -balance;
  }
  return total;
}

/**
 * Compute the ending balance for an account given its debits and credits.
 * Uses the account's main type to determine normal balance direction.
 *
 * Assets & Expenses: debit - credit
 * Liabilities, Equity & Income: credit - debit
 */
export function computeEndingBalance(
  category: CategoryKey,
  totalDebit: number,
  totalCredit: number,
): number {
  const mainType = extractMainType(category);
  if (mainType === 'Asset' || mainType === 'Expense') {
    return totalDebit - totalCredit;
  }
  return totalCredit - totalDebit;
}

/**
 * Build a lookup map from an array of account types.
 */
export function buildAccountTypeMap(
  accountTypes: readonly AccountType[],
): Map<string, AccountType> {
  const map = new Map<string, AccountType>();
  for (const at of accountTypes) {
    map.set(at.code, at);
  }
  return map;
}
