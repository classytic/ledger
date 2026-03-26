import { describe, it, expect } from 'vitest';
import {
  JOURNAL_TYPES, JOURNAL_CODES,
  getJournalTypeCodes, isValidJournalType, getJournalType,
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
    it('returns all journal type codes', () => {
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
});
