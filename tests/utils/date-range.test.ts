/**
 * Date-range boundaries are CIVIL dates bound in the reporting zone
 * (default 'UTC') via primitives/timezone — NOT server-local Date parts.
 * Assertions therefore use getUTC* getters and Date.UTC fixtures so the
 * suite passes identically on any deploy machine TZ (PACKAGE_RULES P12).
 */
import { describe, expect, it } from 'vitest';
import { getDateRange, getFiscalYearStart } from '../../src/utils/date-range.js';

describe('Date Range', () => {
  describe('getDateRange', () => {
    it('computes month range from YYYY-MM string', () => {
      const { startDate, endDate } = getDateRange('month', '2025-03');
      expect(startDate.toISOString()).toBe('2025-03-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-03-31T23:59:59.999Z');
    });

    it('month range handles single-digit month (YYYY-M)', () => {
      const { startDate, endDate } = getDateRange('month', '2025-1');
      expect(startDate.toISOString()).toBe('2025-01-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-01-31T23:59:59.999Z');
    });

    it('month range handles Date object', () => {
      const { startDate, endDate } = getDateRange('month', new Date(Date.UTC(2025, 5, 15))); // June 15 UTC
      expect(startDate.toISOString()).toBe('2025-06-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-06-30T23:59:59.999Z');
    });

    it('computes quarter range', () => {
      const { startDate, endDate } = getDateRange('quarter', { quarter: 2, year: 2025 });
      expect(startDate.toISOString()).toBe('2025-04-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-06-30T23:59:59.999Z');
    });

    it('computes year range', () => {
      const { startDate, endDate } = getDateRange('year', 2025);
      expect(startDate.toISOString()).toBe('2025-01-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-12-31T23:59:59.999Z');
    });

    it('computes custom range and normalizes date-only end to end-of-day', () => {
      const start = new Date('2025-06-01');
      const end = new Date(Date.UTC(2025, 5, 30)); // UTC midnight — a date-only bound
      const { startDate, endDate } = getDateRange('custom', { startDate: start, endDate: end });
      expect(startDate.toISOString()).toBe('2025-06-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-06-30T23:59:59.999Z');
    });

    it('custom range preserves explicit non-midnight time', () => {
      const start = new Date('2025-06-01T00:00:00Z');
      const end = new Date('2025-06-30T18:30:00Z'); // 6:30 PM UTC
      const { endDate } = getDateRange('custom', { startDate: start, endDate: end });
      expect(endDate.toISOString()).toBe('2025-06-30T18:30:00.000Z');
    });

    it('resolves boundaries in a non-UTC reporting zone', () => {
      // March 2025 in Dhaka (UTC+6, no DST): starts 28 Feb 18:00Z.
      const { startDate, endDate } = getDateRange('month', '2025-03', 'Asia/Dhaka');
      expect(startDate.toISOString()).toBe('2025-02-28T18:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-03-31T17:59:59.999Z');
    });
  });

  describe('getFiscalYearStart', () => {
    it('January fiscal year (default)', () => {
      const result = getFiscalYearStart(new Date('2025-06-15T00:00:00Z'), 1);
      expect(result.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    });

    it('April fiscal year (UK/India style)', () => {
      const result = getFiscalYearStart(new Date('2025-02-15T00:00:00Z'), 4);
      expect(result.toISOString()).toBe('2024-04-01T00:00:00.000Z');
    });

    it('April fiscal year when date is after start', () => {
      const result = getFiscalYearStart(new Date('2025-06-15T00:00:00Z'), 4);
      expect(result.toISOString()).toBe('2025-04-01T00:00:00.000Z');
    });

    it('October fiscal year (US government style)', () => {
      // Before October → previous fiscal year
      const before = getFiscalYearStart(new Date('2025-08-15T00:00:00Z'), 10);
      expect(before.toISOString()).toBe('2024-10-01T00:00:00.000Z');

      // After October → current fiscal year
      const after = getFiscalYearStart(new Date('2025-11-15T00:00:00Z'), 10);
      expect(after.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    });

    it('defaults to January if fiscalStartMonth omitted', () => {
      const result = getFiscalYearStart(new Date('2025-06-15T00:00:00Z'));
      expect(result.getUTCMonth()).toBe(0); // January
    });

    it('exact fiscal start month', () => {
      // Civil April 1 (UTC) with April fiscal start → current year.
      const result = getFiscalYearStart(new Date(Date.UTC(2025, 3, 1)), 4);
      expect(result.toISOString()).toBe('2025-04-01T00:00:00.000Z');
    });
  });

  describe('getDateRange (extended)', () => {
    it('February handles leap year', () => {
      const { endDate } = getDateRange('month', '2024-02'); // 2024 is leap year
      expect(endDate.getUTCDate()).toBe(29);
    });

    it('February handles non-leap year', () => {
      const { endDate } = getDateRange('month', '2025-02');
      expect(endDate.getUTCDate()).toBe(28);
    });

    it('Q1 covers January-March', () => {
      const { startDate, endDate } = getDateRange('quarter', { quarter: 1, year: 2025 });
      expect(startDate.getUTCMonth()).toBe(0); // January
      expect(endDate.getUTCMonth()).toBe(2); // March
      expect(endDate.getUTCDate()).toBe(31);
    });

    it('Q4 covers October-December', () => {
      const { startDate, endDate } = getDateRange('quarter', { quarter: 4, year: 2025 });
      expect(startDate.getUTCMonth()).toBe(9); // October
      expect(endDate.getUTCMonth()).toBe(11); // December
      expect(endDate.getUTCDate()).toBe(31);
    });

    it('year range end date has end-of-day time', () => {
      const { endDate } = getDateRange('year', 2025);
      expect(endDate.getUTCHours()).toBe(23);
      expect(endDate.getUTCMinutes()).toBe(59);
      expect(endDate.getUTCSeconds()).toBe(59);
      expect(endDate.getUTCMilliseconds()).toBe(999);
    });

    it('month range end date has end-of-day time', () => {
      const { endDate } = getDateRange('month', '2025-06');
      expect(endDate.getUTCHours()).toBe(23);
      expect(endDate.getUTCMinutes()).toBe(59);
    });

    it('year accepts string value', () => {
      const { startDate, endDate } = getDateRange('year', '2025');
      expect(startDate.getUTCFullYear()).toBe(2025);
      expect(endDate.getUTCFullYear()).toBe(2025);
    });

    it('default case falls back to current month (UTC civil)', () => {
      const { startDate, endDate } = getDateRange('invalid' as never, null);
      const now = new Date();
      expect(startDate.getUTCFullYear()).toBe(now.getUTCFullYear());
      expect(startDate.getUTCMonth()).toBe(now.getUTCMonth());
      expect(startDate.getUTCDate()).toBe(1);
      expect(endDate.getUTCMonth()).toBe(now.getUTCMonth());
    });
  });
});
