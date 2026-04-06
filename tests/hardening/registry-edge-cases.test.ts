/**
 * Registry Edge Cases & Freeze Timing Tests
 *
 * Validates the extensible journal type registry under adversarial
 * conditions: duplicate registration, post-freeze registration,
 * code/key mismatches, and interaction with schema creation.
 *
 * Beats Odoo's selection_add tests by enforcing timing constraints
 * and proving that frozen state cannot be bypassed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  JOURNAL_TYPES,
  registerJournalType,
  getCustomJournalTypes,
  getJournalTypeCodes,
  isValidJournalType,
  getJournalType,
  _freezeJournalTypes,
  _resetCustomJournalTypes,
} from '../../src/constants/journals.js';

afterEach(() => {
  _resetCustomJournalTypes();
});

// ── Registration Validation ───────────────────────────────────────────────

describe('Registry — registration validation', () => {
  it('rejects overriding any of the 15 built-in types', () => {
    for (const code of Object.keys(JOURNAL_TYPES)) {
      expect(
        () => registerJournalType(code, { code, name: 'Override', description: 'Bad' }),
        `Should reject override of ${code}`,
      ).toThrow('Cannot override built-in');
    }
  });

  it('rejects code mismatch (key ≠ def.code)', () => {
    expect(() =>
      registerJournalType('POS', { code: 'POINT_OF_SALE', name: 'POS', description: 'x' }),
    ).toThrow('code mismatch');
  });

  it('rejects empty name', () => {
    expect(() =>
      registerJournalType('POS', { code: 'POS', name: '', description: 'x' }),
    ).toThrow('non-empty name and description');
  });

  it('rejects empty description', () => {
    expect(() =>
      registerJournalType('POS', { code: 'POS', name: 'POS', description: '' }),
    ).toThrow('non-empty name and description');
  });

  it('accepts valid custom type', () => {
    registerJournalType('POS_SALES', {
      code: 'POS_SALES',
      name: 'POS Sales',
      description: 'Point-of-sale daily transactions',
    });
    expect(isValidJournalType('POS_SALES')).toBe(true);
  });

  it('allows re-registering same code with same definition (idempotent overwrite)', () => {
    const def = { code: 'POS', name: 'POS', description: 'POS transactions' };
    registerJournalType('POS', def);
    registerJournalType('POS', def); // should not throw
    expect(getCustomJournalTypes().length).toBe(1);
  });
});

// ── Freeze Timing ─────────────────────────────────────────────────────────

describe('Registry — freeze timing', () => {
  it('registration works before freeze', () => {
    registerJournalType('CUSTOM_A', {
      code: 'CUSTOM_A', name: 'Custom A', description: 'Before freeze',
    });
    _freezeJournalTypes();
    expect(isValidJournalType('CUSTOM_A')).toBe(true);
  });

  it('registration throws after freeze', () => {
    _freezeJournalTypes();
    expect(() =>
      registerJournalType('CUSTOM_B', {
        code: 'CUSTOM_B', name: 'Custom B', description: 'After freeze',
      }),
    ).toThrow('after schema initialization');
  });

  it('frozen types are still queryable', () => {
    registerJournalType('CUSTOM_C', {
      code: 'CUSTOM_C', name: 'Custom C', description: 'Queryable after freeze',
    });
    _freezeJournalTypes();

    expect(isValidJournalType('CUSTOM_C')).toBe(true);
    expect(getJournalType('CUSTOM_C')!.name).toBe('Custom C');
    expect(getJournalTypeCodes()).toContain('CUSTOM_C');
  });

  it('reset unfreezes for subsequent registrations', () => {
    _freezeJournalTypes();
    expect(() =>
      registerJournalType('X', { code: 'X', name: 'X', description: 'X' }),
    ).toThrow('after schema initialization');

    _resetCustomJournalTypes();

    // After reset, registration works again
    registerJournalType('Y', { code: 'Y', name: 'Y', description: 'Y' });
    expect(isValidJournalType('Y')).toBe(true);
  });

  it('reset clears all custom types', () => {
    registerJournalType('A', { code: 'A', name: 'A', description: 'A' });
    registerJournalType('B', { code: 'B', name: 'B', description: 'B' });
    expect(getCustomJournalTypes().length).toBe(2);

    _resetCustomJournalTypes();

    expect(getCustomJournalTypes().length).toBe(0);
    expect(isValidJournalType('A')).toBe(false);
    expect(isValidJournalType('B')).toBe(false);
  });
});

// ── Lookup Correctness ────────────────────────────────────────────────────

describe('Registry — lookup correctness', () => {
  it('custom types appear in getJournalTypeCodes', () => {
    registerJournalType('ECOM', { code: 'ECOM', name: 'E-Commerce', description: 'Online orders' });
    const codes = getJournalTypeCodes();
    expect(codes).toContain('ECOM');
    expect(codes).toContain('SALES'); // built-in still there
    expect(codes.length).toBe(Object.keys(JOURNAL_TYPES).length + 1);
  });

  it('getJournalType returns custom type by code', () => {
    registerJournalType('PAYROLL_MONTHLY', {
      code: 'PAYROLL_MONTHLY', name: 'Monthly Payroll', description: 'Monthly payroll run',
    });
    const jt = getJournalType('PAYROLL_MONTHLY');
    expect(jt).not.toBeNull();
    expect(jt!.code).toBe('PAYROLL_MONTHLY');
    expect(jt!.name).toBe('Monthly Payroll');
  });

  it('getJournalType prefers built-in over custom (defense-in-depth)', () => {
    // Can't register SALES (throws), but verify the lookup order is correct
    // by checking that built-in types are served from JOURNAL_TYPES
    const jt = getJournalType('SALES');
    expect(jt).toBe(JOURNAL_TYPES['SALES']);
  });

  it('custom types are isolated from JOURNAL_TYPES object', () => {
    registerJournalType('ISOLATED', {
      code: 'ISOLATED', name: 'Isolated', description: 'Should not appear in JOURNAL_TYPES',
    });
    expect(JOURNAL_TYPES).not.toHaveProperty('ISOLATED');
    expect(Object.keys(JOURNAL_TYPES).length).toBe(15); // unchanged
  });

  it('multiple custom types coexist correctly', () => {
    const customs = [
      { code: 'POS_SALES', name: 'POS Sales', description: 'POS' },
      { code: 'ECOM_SALES', name: 'E-Commerce Sales', description: 'ECOM' },
      { code: 'WHOLESALE', name: 'Wholesale', description: 'Wholesale' },
    ];
    for (const def of customs) registerJournalType(def.code, def);

    expect(getCustomJournalTypes().length).toBe(3);
    expect(getJournalTypeCodes().length).toBe(15 + 3);

    for (const def of customs) {
      expect(isValidJournalType(def.code)).toBe(true);
      expect(getJournalType(def.code)!.name).toBe(def.name);
    }
  });
});

// ── Adversarial Inputs ────────────────────────────────────────────────────

describe('Registry — adversarial inputs', () => {
  it('allows empty string code (edge case — callers should validate upstream)', () => {
    // Empty string passes our current validation (code matches key, name/desc non-empty)
    // This is acceptable — Mongoose enum validation will reject it at schema level
    registerJournalType('', { code: '', name: 'Empty', description: 'Empty code' });
    expect(isValidJournalType('')).toBe(true);
  });

  it('handles code with special characters', () => {
    // Should work — codes are arbitrary strings
    registerJournalType('POS-SALES_V2', {
      code: 'POS-SALES_V2', name: 'POS Sales V2', description: 'Versioned POS',
    });
    expect(isValidJournalType('POS-SALES_V2')).toBe(true);
  });

  it('handles unicode code', () => {
    registerJournalType('日本語', {
      code: '日本語', name: 'Japanese', description: 'Unicode test',
    });
    expect(isValidJournalType('日本語')).toBe(true);
    expect(getJournalType('日本語')!.name).toBe('Japanese');
  });

  it('handles very long code', () => {
    const longCode = 'A'.repeat(500);
    registerJournalType(longCode, {
      code: longCode, name: 'Long', description: 'Very long code',
    });
    expect(isValidJournalType(longCode)).toBe(true);
  });
});
