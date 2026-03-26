import { describe, it, expect } from 'vitest';
import { getDateRange, getFiscalYearStart } from '../../src/utils/date-range.js';

describe('Date Range', () => {
  describe('getDateRange', () => {
    it('computes month range from YYYY-MM string', () => {
      const { startDate, endDate } = getDateRange('month', '2025-03');
      expect(startDate.getFullYear()).toBe(2025);
      expect(startDate.getMonth()).toBe(2); // March (0-indexed)
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getMonth()).toBe(2);
      expect(endDate.getDate()).toBe(31);
    });

    it('month range handles single-digit month (YYYY-M)', () => {
      const { startDate, endDate } = getDateRange('month', '2025-1');
      expect(startDate.getFullYear()).toBe(2025);
      expect(startDate.getMonth()).toBe(0); // January
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getMonth()).toBe(0);
      expect(endDate.getDate()).toBe(31);
    });

    it('month range handles Date object', () => {
      const { startDate, endDate } = getDateRange('month', new Date(2025, 5, 15)); // June 15
      expect(startDate.getMonth()).toBe(5);
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getMonth()).toBe(5);
      expect(endDate.getDate()).toBe(30);
    });

    it('computes quarter range', () => {
      const { startDate, endDate } = getDateRange('quarter', { quarter: 2, year: 2025 });
      expect(startDate.getMonth()).toBe(3); // April
      expect(endDate.getMonth()).toBe(5);   // June
    });

    it('computes year range', () => {
      const { startDate, endDate } = getDateRange('year', 2025);
      expect(startDate.getMonth()).toBe(0);  // January
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getMonth()).toBe(11);   // December
      expect(endDate.getDate()).toBe(31);
    });

    it('computes custom range and normalizes midnight end to end-of-day', () => {
      const start = new Date('2025-06-01');
      const end = new Date(2025, 5, 30); // midnight
      const { startDate, endDate } = getDateRange('custom', { startDate: start, endDate: end });
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getDate()).toBe(30);
      expect(endDate.getHours()).toBe(23);
      expect(endDate.getMinutes()).toBe(59);
      expect(endDate.getSeconds()).toBe(59);
      expect(endDate.getMilliseconds()).toBe(999);
    });

    it('custom range preserves explicit non-midnight time', () => {
      const start = new Date('2025-06-01T00:00:00');
      const end = new Date(2025, 5, 30, 18, 30, 0); // 6:30 PM
      const { endDate } = getDateRange('custom', { startDate: start, endDate: end });
      expect(endDate.getHours()).toBe(18);
      expect(endDate.getMinutes()).toBe(30);
    });
  });

  describe('getFiscalYearStart', () => {
    it('January fiscal year (default)', () => {
      const result = getFiscalYearStart(new Date('2025-06-15'), 1);
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(0); // January
    });

    it('April fiscal year (UK/India style)', () => {
      const result = getFiscalYearStart(new Date('2025-02-15'), 4);
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(3); // April 2024
    });

    it('April fiscal year when date is after start', () => {
      const result = getFiscalYearStart(new Date('2025-06-15'), 4);
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(3); // April 2025
    });

    it('October fiscal year (US government style)', () => {
      // Before October → previous fiscal year
      const before = getFiscalYearStart(new Date('2025-08-15'), 10);
      expect(before.getFullYear()).toBe(2024);
      expect(before.getMonth()).toBe(9); // October 2024

      // After October → current fiscal year
      const after = getFiscalYearStart(new Date('2025-11-15'), 10);
      expect(after.getFullYear()).toBe(2025);
      expect(after.getMonth()).toBe(9); // October 2025
    });

    it('defaults to January if fiscalStartMonth omitted', () => {
      const result = getFiscalYearStart(new Date('2025-06-15'));
      expect(result.getMonth()).toBe(0); // January
    });

    it('exact fiscal start month', () => {
      // When date.getMonth() equals fiscal start month, should be current year
      const result = getFiscalYearStart(new Date(2025, 3, 1), 4); // April 1
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(3);
    });
  });

  describe('getDateRange (extended)', () => {
    it('February handles leap year', () => {
      const { endDate } = getDateRange('month', '2024-02'); // 2024 is leap year
      expect(endDate.getDate()).toBe(29);
    });

    it('February handles non-leap year', () => {
      const { endDate } = getDateRange('month', '2025-02');
      expect(endDate.getDate()).toBe(28);
    });

    it('Q1 covers January-March', () => {
      const { startDate, endDate } = getDateRange('quarter', { quarter: 1, year: 2025 });
      expect(startDate.getMonth()).toBe(0); // January
      expect(endDate.getMonth()).toBe(2);   // March
      expect(endDate.getDate()).toBe(31);
    });

    it('Q4 covers October-December', () => {
      const { startDate, endDate } = getDateRange('quarter', { quarter: 4, year: 2025 });
      expect(startDate.getMonth()).toBe(9);  // October
      expect(endDate.getMonth()).toBe(11);   // December
      expect(endDate.getDate()).toBe(31);
    });

    it('year range end date has end-of-day time', () => {
      const { endDate } = getDateRange('year', 2025);
      expect(endDate.getHours()).toBe(23);
      expect(endDate.getMinutes()).toBe(59);
      expect(endDate.getSeconds()).toBe(59);
      expect(endDate.getMilliseconds()).toBe(999);
    });

    it('month range end date has end-of-day time', () => {
      const { endDate } = getDateRange('month', '2025-06');
      expect(endDate.getHours()).toBe(23);
      expect(endDate.getMinutes()).toBe(59);
    });

    it('year accepts string value', () => {
      const { startDate, endDate } = getDateRange('year', '2025');
      expect(startDate.getFullYear()).toBe(2025);
      expect(endDate.getFullYear()).toBe(2025);
    });

    it('default case falls back to current month', () => {
      const { startDate, endDate } = getDateRange('invalid' as any, null);
      const now = new Date();
      expect(startDate.getFullYear()).toBe(now.getFullYear());
      expect(startDate.getMonth()).toBe(now.getMonth());
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getMonth()).toBe(now.getMonth());
    });
  });
});
