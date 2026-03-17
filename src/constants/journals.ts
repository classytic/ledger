/**
 * Journal Types — Standard journal classifications.
 * Extensible: country packs can add custom journal types.
 */

import type { JournalType } from '../types/core.js';

export const JOURNAL_TYPES: Readonly<Record<string, JournalType>> = Object.freeze({
  SALES:              { code: 'SALES', name: 'Sales Journal', description: 'Sales transactions and revenue' },
  PURCHASES:          { code: 'PURCHASES', name: 'Purchases Journal', description: 'Purchase transactions and expenses' },
  CASH_RECEIPTS:      { code: 'CASH_RECEIPTS', name: 'Cash Receipts Journal', description: 'Cash and bank deposits received' },
  CASH_PAYMENTS:      { code: 'CASH_PAYMENTS', name: 'Cash Payments Journal', description: 'Cash and bank payments made' },
  PAYROLL:            { code: 'PAYROLL', name: 'Payroll Journal', description: 'Employee wages, salaries, and related expenses' },
  GENERAL:            { code: 'GENERAL', name: 'General Journal', description: 'Adjusting entries, corrections, and misc transactions' },
  INVENTORY:          { code: 'INVENTORY', name: 'Inventory Journal', description: 'Inventory adjustments and movements' },
  FIXED_ASSETS:       { code: 'FIXED_ASSETS', name: 'Fixed Assets Journal', description: 'Asset purchases, disposals, and depreciation' },
  BANK_RECONCILIATION:{ code: 'BANK_RECONCILIATION', name: 'Bank Reconciliation', description: 'Bank reconciliation adjustments' },
  DEPRECIATION:       { code: 'DEPRECIATION', name: 'Depreciation Journal', description: 'Periodic depreciation expenses' },
  YEAR_END:           { code: 'YEAR_END', name: 'Year-End Adjustments', description: 'Year-end closing and adjustment entries' },
  ACCOUNTS_RECEIVABLE:{ code: 'ACCOUNTS_RECEIVABLE', name: 'Accounts Receivable', description: 'Customer invoices and receivable transactions' },
  ACCOUNTS_PAYABLE:   { code: 'ACCOUNTS_PAYABLE', name: 'Accounts Payable', description: 'Vendor bills and payable transactions' },
  TAX:                { code: 'TAX', name: 'Tax Journal', description: 'GST/HST/PST and other tax-related entries' },
  MISC:               { code: 'MISC', name: 'Miscellaneous', description: 'Transactions that don\'t fit other categories' },
});

export const JOURNAL_CODES = Object.freeze(
  Object.fromEntries(Object.keys(JOURNAL_TYPES).map(k => [k, k])) as Record<string, string>,
);

export function getJournalTypeCodes(): string[] {
  return Object.keys(JOURNAL_TYPES);
}

export function isValidJournalType(code: string): boolean {
  return code in JOURNAL_TYPES;
}

export function getJournalType(code: string): JournalType | null {
  return JOURNAL_TYPES[code] ?? null;
}
