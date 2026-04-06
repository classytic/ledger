import { describe, it, expect, afterEach } from 'vitest';
import {
  JOURNAL_TYPES, JOURNAL_CODES,
  getJournalTypeCodes, isValidJournalType, getJournalType,
  registerJournalType, getCustomJournalTypes,
  _resetCustomJournalTypes,
} from '../../src/constants/journals.js';

describe('Journals', () => {
  describe('JOURNAL_TYPES', () => {
    it('has at least 14 journal types', () => {
      expect(Object.keys(JOURNAL_TYPES).length).toBeGreaterThanOrEqual(14);
    });

    it('each type has code, name, and description', () => {
      for (const [key, jt] of Object.entries(JOURNAL_TYPES)) {
        expect(jt.code).toBe(key);
        expect(typeof jt.name).toBe('string');
        expect(typeof jt.description).toBe('string');
        expect(jt.name.length).toBeGreaterThan(0);
      }
    });

    it('includes essential journal types', () => {
      expect(JOURNAL_TYPES.SALES).toBeDefined();
      expect(JOURNAL_TYPES.PURCHASES).toBeDefined();
      expect(JOURNAL_TYPES.GENERAL).toBeDefined();
      expect(JOURNAL_TYPES.PAYROLL).toBeDefined();
      expect(JOURNAL_TYPES.YEAR_END).toBeDefined();
      expect(JOURNAL_TYPES.TAX).toBeDefined();
    });
  });

  describe('JOURNAL_CODES', () => {
    it('maps each key to itself', () => {
      for (const key of Object.keys(JOURNAL_TYPES)) {
        expect(JOURNAL_CODES[key]).toBe(key);
      }
    });
  });

  describe('getJournalTypeCodes', () => {
    it('returns all built-in journal type codes when no custom types registered', () => {
      const codes = getJournalTypeCodes();
      expect(codes).toContain('SALES');
      expect(codes).toContain('GENERAL');
      expect(codes.length).toBe(Object.keys(JOURNAL_TYPES).length);
    });
  });

  describe('isValidJournalType', () => {
    it('returns true for valid types', () => {
      expect(isValidJournalType('SALES')).toBe(true);
      expect(isValidJournalType('PURCHASES')).toBe(true);
      expect(isValidJournalType('GENERAL')).toBe(true);
    });

    it('returns false for invalid types', () => {
      expect(isValidJournalType('INVALID')).toBe(false);
      expect(isValidJournalType('')).toBe(false);
      expect(isValidJournalType('sales')).toBe(false); // case-sensitive
    });
  });

  describe('getJournalType', () => {
    it('returns journal type for valid code', () => {
      const jt = getJournalType('SALES');
      expect(jt).toBeDefined();
      expect(jt!.code).toBe('SALES');
      expect(jt!.name).toBe('Sales Journal');
    });

    it('returns null for invalid code', () => {
      expect(getJournalType('INVALID')).toBeNull();
      expect(getJournalType('')).toBeNull();
    });
  });

  // ── Extensible Registry ─────────────────────────────────────────────────

  describe('registerJournalType (extensible registry)', () => {
    afterEach(() => {
      _resetCustomJournalTypes();
    });

    it('adds custom type to getJournalTypeCodes', () => {
      registerJournalType('POS_SALES', {
        code: 'POS_SALES',
        name: 'POS Sales Journal',
        description: 'Point-of-sale transactions aggregated by day',
      });
      const codes = getJournalTypeCodes();
      expect(codes).toContain('POS_SALES');
      expect(codes).toContain('SALES'); // built-in still there
      expect(codes.length).toBe(Object.keys(JOURNAL_TYPES).length + 1);
    });

    it('makes custom type valid via isValidJournalType', () => {
      registerJournalType('ECOM_SALES', {
        code: 'ECOM_SALES',
        name: 'E-Commerce Sales Journal',
        description: 'Online order transactions',
      });
      expect(isValidJournalType('ECOM_SALES')).toBe(true);
    });

    it('makes custom type retrievable via getJournalType', () => {
      registerJournalType('POS_SALES', {
        code: 'POS_SALES',
        name: 'POS Sales Journal',
        description: 'Point-of-sale transactions aggregated by day',
      });
      const jt = getJournalType('POS_SALES');
      expect(jt).toBeDefined();
      expect(jt!.code).toBe('POS_SALES');
      expect(jt!.name).toBe('POS Sales Journal');
    });

    it('returns custom types via getCustomJournalTypes', () => {
      registerJournalType('POS_SALES', {
        code: 'POS_SALES',
        name: 'POS Sales Journal',
        description: 'Point-of-sale daily aggregated transactions',
      });
      registerJournalType('ECOM_SALES', {
        code: 'ECOM_SALES',
        name: 'E-Commerce Sales Journal',
        description: 'Online order transactions posted per-order',
      });
      const custom = getCustomJournalTypes();
      expect(custom).toHaveLength(2);
      expect(custom.map(t => t.code)).toContain('POS_SALES');
      expect(custom.map(t => t.code)).toContain('ECOM_SALES');
    });

    it('does not mutate built-in JOURNAL_TYPES', () => {
      registerJournalType('POS_SALES', {
        code: 'POS_SALES',
        name: 'POS Sales Journal',
        description: 'POS transactions',
      });
      expect(JOURNAL_TYPES).not.toHaveProperty('POS_SALES');
      expect(Object.keys(JOURNAL_TYPES).length).toBe(15);
    });

    it('throws when overriding a built-in type', () => {
      expect(() =>
        registerJournalType('SALES', {
          code: 'SALES',
          name: 'Override',
          description: 'Attempt to override',
        }),
      ).toThrow('Cannot override built-in journal type: SALES');
    });

    it('throws on code mismatch between key and def.code', () => {
      expect(() =>
        registerJournalType('POS_SALES', {
          code: 'WRONG_CODE',
          name: 'POS Sales',
          description: 'Mismatched code',
        }),
      ).toThrow('code mismatch');
    });

    it('throws on empty name or description', () => {
      expect(() =>
        registerJournalType('POS_SALES', {
          code: 'POS_SALES',
          name: '',
          description: 'Has description',
        }),
      ).toThrow('requires non-empty name and description');

      expect(() =>
        registerJournalType('POS_SALES', {
          code: 'POS_SALES',
          name: 'Has name',
          description: '',
        }),
      ).toThrow('requires non-empty name and description');
    });

    it('resets cleanly via _resetCustomJournalTypes', () => {
      registerJournalType('TEMP', {
        code: 'TEMP',
        name: 'Temporary',
        description: 'Will be reset',
      });
      expect(isValidJournalType('TEMP')).toBe(true);

      _resetCustomJournalTypes();

      expect(isValidJournalType('TEMP')).toBe(false);
      expect(getJournalTypeCodes().length).toBe(Object.keys(JOURNAL_TYPES).length);
    });
  });
});
