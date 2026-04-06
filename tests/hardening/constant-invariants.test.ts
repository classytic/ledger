/**
 * Constant Invariant Tests
 *
 * Validates structural invariants across all frozen constants.
 * Inspired by @classytic/flow's disjoint-set tests and Odoo's
 * constraint validation. Ensures no silent data corruption.
 */

import { describe, it, expect } from 'vitest';
import {
  CATEGORIES, CATEGORY_KEYS,
  isValidCategory, getNormalBalance,
  isBalanceSheet, isIncomeStatement,
  categoryKey, extractMainType, extractStatementType,
} from '../../src/constants/categories.js';
import {
  JOURNAL_TYPES, JOURNAL_CODES,
  getJournalTypeCodes, isValidJournalType, getJournalType,
} from '../../src/constants/journals.js';
import {
  CURRENCIES, getCurrency, isValidCurrency, getMinorUnit,
} from '../../src/constants/currencies.js';

// ── Categories: Structural Invariants ─────────────────────────────────────

describe('Categories — invariants', () => {
  it('CATEGORIES is frozen (immutable)', () => {
    expect(Object.isFrozen(CATEGORIES)).toBe(true);
  });

  it('exactly 5 categories exist', () => {
    expect(CATEGORY_KEYS.length).toBe(5);
  });

  it('every main type appears exactly once', () => {
    const mainTypes = CATEGORY_KEYS.map(k => CATEGORIES[k].mainType);
    const unique = new Set(mainTypes);
    expect(unique.size).toBe(5);
    expect(unique).toContain('Asset');
    expect(unique).toContain('Liability');
    expect(unique).toContain('Equity');
    expect(unique).toContain('Income');
    expect(unique).toContain('Expense');
  });

  it('balance sheet and income statement are disjoint sets', () => {
    const bs = CATEGORY_KEYS.filter(k => isBalanceSheet(k));
    const is = CATEGORY_KEYS.filter(k => isIncomeStatement(k));

    // Disjoint
    for (const k of bs) expect(is).not.toContain(k);
    for (const k of is) expect(bs).not.toContain(k);

    // Union covers all categories
    expect(bs.length + is.length).toBe(CATEGORY_KEYS.length);
  });

  it('balance sheet has exactly 3 types: Asset, Liability, Equity', () => {
    const bs = CATEGORY_KEYS.filter(k => isBalanceSheet(k));
    const mainTypes = bs.map(k => CATEGORIES[k].mainType).sort();
    expect(mainTypes).toEqual(['Asset', 'Equity', 'Liability']);
  });

  it('income statement has exactly 2 types: Income, Expense', () => {
    const is = CATEGORY_KEYS.filter(k => isIncomeStatement(k));
    const mainTypes = is.map(k => CATEGORIES[k].mainType).sort();
    expect(mainTypes).toEqual(['Expense', 'Income']);
  });

  it('normal balance follows accounting equation: Assets+Expenses=debit, rest=credit', () => {
    expect(getNormalBalance('Asset')).toBe('debit');
    expect(getNormalBalance('Expense')).toBe('debit');
    expect(getNormalBalance('Liability')).toBe('credit');
    expect(getNormalBalance('Equity')).toBe('credit');
    expect(getNormalBalance('Income')).toBe('credit');
  });

  it('categoryKey is the inverse of extract functions (bidirectional)', () => {
    for (const key of CATEGORY_KEYS) {
      const main = extractMainType(key);
      const stmt = extractStatementType(key);
      expect(main).not.toBeNull();
      expect(stmt).not.toBeNull();
      expect(categoryKey(stmt!, main!)).toBe(key);
    }
  });

  it('every CATEGORY_KEYS entry passes isValidCategory', () => {
    for (const key of CATEGORY_KEYS) {
      expect(isValidCategory(key), `${key} should be valid`).toBe(true);
    }
  });

  it('isValidCategory is case-sensitive', () => {
    expect(isValidCategory('balance sheet-asset')).toBe(false);
    expect(isValidCategory('BALANCE SHEET-ASSET')).toBe(false);
    expect(isValidCategory('Balance Sheet-Asset')).toBe(true);
  });

  it('extractMainType returns null for malformed keys', () => {
    expect(extractMainType('')).toBeNull();
    expect(extractMainType('nodelimiter')).toBeNull();
    expect(extractMainType('a-b-c')).toBeNull(); // 3 parts
  });
});

// ── Journal Types: Structural Invariants ──────────────────────────────────

describe('Journal Types — invariants', () => {
  it('JOURNAL_TYPES is frozen', () => {
    expect(Object.isFrozen(JOURNAL_TYPES)).toBe(true);
  });

  it('exactly 15 built-in types', () => {
    expect(Object.keys(JOURNAL_TYPES).length).toBe(15);
  });

  it('every key matches its .code property (self-consistent)', () => {
    for (const [key, jt] of Object.entries(JOURNAL_TYPES)) {
      expect(jt.code, `${key}.code should equal key`).toBe(key);
    }
  });

  it('no duplicate codes', () => {
    const codes = Object.values(JOURNAL_TYPES).map(jt => jt.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('all names are non-empty and unique', () => {
    const names = Object.values(JOURNAL_TYPES).map(jt => jt.name);
    for (const n of names) expect(n.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all descriptions are non-empty', () => {
    for (const jt of Object.values(JOURNAL_TYPES)) {
      expect(jt.description.length, `${jt.code} description empty`).toBeGreaterThan(0);
    }
  });

  it('JOURNAL_CODES maps each key to itself', () => {
    expect(Object.isFrozen(JOURNAL_CODES)).toBe(true);
    for (const key of Object.keys(JOURNAL_TYPES)) {
      expect(JOURNAL_CODES[key]).toBe(key);
    }
  });

  it('getJournalTypeCodes and JOURNAL_TYPES keys are in sync', () => {
    const codes = getJournalTypeCodes();
    for (const key of Object.keys(JOURNAL_TYPES)) {
      expect(codes).toContain(key);
    }
  });

  it('isValidJournalType is case-sensitive', () => {
    expect(isValidJournalType('SALES')).toBe(true);
    expect(isValidJournalType('sales')).toBe(false);
    expect(isValidJournalType('Sales')).toBe(false);
  });

  it('getJournalType returns readonly objects', () => {
    const jt = getJournalType('SALES');
    expect(jt).not.toBeNull();
    expect(jt!.code).toBe('SALES');
    // Verify it's from the frozen source
    expect(jt).toBe(JOURNAL_TYPES['SALES']);
  });

  it('essential journal types for double-entry accounting exist', () => {
    const essential = [
      'SALES', 'PURCHASES', 'GENERAL', 'CASH_RECEIPTS', 'CASH_PAYMENTS',
      'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'TAX', 'MISC',
    ];
    for (const code of essential) {
      expect(isValidJournalType(code), `Missing essential type: ${code}`).toBe(true);
    }
  });

  it('mutation attempts on frozen JOURNAL_TYPES throw TypeError', () => {
    expect(() => {
      // @ts-expect-error — intentional mutation attempt
      JOURNAL_TYPES['HACKED'] = { code: 'HACKED', name: 'x', description: 'x' };
    }).toThrow(TypeError);
    expect(Object.keys(JOURNAL_TYPES).length).toBe(15);
  });
});

// ── Currencies: Structural Invariants ─────────────────────────────────────

describe('Currencies — invariants', () => {
  it('CURRENCIES is frozen', () => {
    expect(Object.isFrozen(CURRENCIES)).toBe(true);
  });

  it('all currency codes are exactly 3 uppercase letters (ISO 4217)', () => {
    for (const code of Object.keys(CURRENCIES)) {
      expect(code, `${code} is not ISO 4217`).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('no duplicate currency codes', () => {
    const codes = Object.keys(CURRENCIES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('each currency has non-empty code, name, symbol', () => {
    for (const [code, currency] of Object.entries(CURRENCIES)) {
      expect(currency.code, `${code}.code`).toBe(code);
      expect(currency.name.length, `${code}.name empty`).toBeGreaterThan(0);
      expect(currency.symbol.length, `${code}.symbol empty`).toBeGreaterThan(0);
    }
  });

  it('minorUnit is 0, 2, or 3 for all currencies', () => {
    for (const [code, currency] of Object.entries(CURRENCIES)) {
      expect([0, 2, 3], `${code} has unexpected minorUnit ${currency.minorUnit}`)
        .toContain(currency.minorUnit);
    }
  });

  it('JPY has minorUnit=0, most others have 2', () => {
    expect(getCurrency('JPY')!.minorUnit).toBe(0);
    expect(getCurrency('USD')!.minorUnit).toBe(2);
    expect(getCurrency('CAD')!.minorUnit).toBe(2);
    expect(getCurrency('EUR')!.minorUnit).toBe(2);
  });

  it('getMinorUnit defaults to 2 for unknown currencies', () => {
    expect(getMinorUnit('UNKNOWN')).toBe(2);
    expect(getMinorUnit('')).toBe(2);
  });

  it('isValidCurrency is case-sensitive', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('usd')).toBe(false);
    expect(isValidCurrency('Usd')).toBe(false);
  });

  it('major world currencies are present', () => {
    const major = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'];
    for (const code of major) {
      expect(isValidCurrency(code), `Missing major currency: ${code}`).toBe(true);
    }
  });

  it('getCurrency returns null for non-existent codes', () => {
    expect(getCurrency('XYZ')).toBeNull();
    expect(getCurrency('')).toBeNull();
  });
});
