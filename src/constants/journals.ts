/**
 * Journal Types — Standard journal classifications.
 * Extensible: country packs can add custom journal types.
 */

import type { JournalType } from '../types/core.js';

export const JOURNAL_TYPES: Readonly<Record<string, JournalType>> = Object.freeze({
  SALES: { code: 'SALES', name: 'Sales Journal', description: 'Sales transactions and revenue' },
  PURCHASES: {
    code: 'PURCHASES',
    name: 'Purchases Journal',
    description: 'Purchase transactions and expenses',
  },
  CASH_RECEIPTS: {
    code: 'CASH_RECEIPTS',
    name: 'Cash Receipts Journal',
    description: 'Cash and bank deposits received',
  },
  CASH_PAYMENTS: {
    code: 'CASH_PAYMENTS',
    name: 'Cash Payments Journal',
    description: 'Cash and bank payments made',
  },
  PAYROLL: {
    code: 'PAYROLL',
    name: 'Payroll Journal',
    description: 'Employee wages, salaries, and related expenses',
  },
  GENERAL: {
    code: 'GENERAL',
    name: 'General Journal',
    description: 'Adjusting entries, corrections, and misc transactions',
  },
  INVENTORY: {
    code: 'INVENTORY',
    name: 'Inventory Journal',
    description: 'Inventory adjustments and movements',
  },
  FIXED_ASSETS: {
    code: 'FIXED_ASSETS',
    name: 'Fixed Assets Journal',
    description: 'Asset purchases, disposals, and depreciation',
  },
  BANK_RECONCILIATION: {
    code: 'BANK_RECONCILIATION',
    name: 'Bank Reconciliation',
    description: 'Bank reconciliation adjustments',
  },
  DEPRECIATION: {
    code: 'DEPRECIATION',
    name: 'Depreciation Journal',
    description: 'Periodic depreciation expenses',
  },
  YEAR_END: {
    code: 'YEAR_END',
    name: 'Year-End Adjustments',
    description: 'Year-end closing and adjustment entries',
  },
  ACCOUNTS_RECEIVABLE: {
    code: 'ACCOUNTS_RECEIVABLE',
    name: 'Accounts Receivable',
    description: 'Customer invoices and receivable transactions',
  },
  ACCOUNTS_PAYABLE: {
    code: 'ACCOUNTS_PAYABLE',
    name: 'Accounts Payable',
    description: 'Vendor bills and payable transactions',
  },
  TAX: {
    code: 'TAX',
    name: 'Tax Journal',
    description: 'GST/HST/PST and other tax-related entries',
  },
  MISC: {
    code: 'MISC',
    name: 'Miscellaneous',
    description: "Transactions that don't fit other categories",
  },
});

export const JOURNAL_CODES = Object.freeze(
  Object.fromEntries(Object.keys(JOURNAL_TYPES).map((k) => [k, k])) as Record<string, string>,
);

// ── Extensible Journal Type Registry ────────────────────────────────────────

const _customTypes: Record<string, JournalType> = {};
let _frozen = false;

/**
 * Register a custom journal type. Must be called **before** schema
 * initialization (`createJournalEntrySchema`). Custom types are
 * automatically included in Mongoose enum validation and all lookup
 * functions.
 */
export function registerJournalType(code: string, def: JournalType): void {
  if (_frozen) throw new Error('Cannot register journal types after schema initialization');
  if (code in JOURNAL_TYPES) throw new Error(`Cannot override built-in journal type: ${code}`);
  if (def.code !== code)
    throw new Error(`Journal type code mismatch: key="${code}" but def.code="${def.code}"`);
  if (!def.name || !def.description)
    throw new Error(`Journal type "${code}" requires non-empty name and description`);
  _customTypes[code] = def;
}

/** Returns all custom (non-built-in) journal types. */
export function getCustomJournalTypes(): JournalType[] {
  return Object.values(_customTypes);
}

/** @internal Lock the registry — called by `createJournalEntrySchema`. */
export function _freezeJournalTypes(): void {
  _frozen = true;
}

/** @internal Test-only reset. Clears custom types and unfreezes. */
export function _resetCustomJournalTypes(): void {
  for (const key of Object.keys(_customTypes)) delete _customTypes[key];
  _frozen = false;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

export function getJournalTypeCodes(): string[] {
  return [...Object.keys(JOURNAL_TYPES), ...Object.keys(_customTypes)];
}

export function isValidJournalType(code: string): boolean {
  return code in JOURNAL_TYPES || code in _customTypes;
}

export function getJournalType(code: string): JournalType | null {
  return JOURNAL_TYPES[code] ?? _customTypes[code] ?? null;
}
