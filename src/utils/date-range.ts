/**
 * Date Range Utility — Compute period boundaries for reports.
 *
 * All inputs are validated to prevent silent failures from invalid dates.
 */

import type { DateOption, DateRange, QuarterValue, CustomDateRange } from '../types/core.js';

/**
 * Compute start/end dates from a date option + value.
 *
 * @throws {Error} If value is null/undefined/invalid for the given option
 *
 * Examples:
 *   getDateRange('month', '2025-03')            → Mar 1 – Mar 31
 *   getDateRange('quarter', { quarter: 2, year: 2025 }) → Apr 1 – Jun 30
 *   getDateRange('year', 2025)                  → Jan 1 – Dec 31
 *   getDateRange('custom', { startDate, endDate })
 */
export function getDateRange(option: DateOption, value: unknown): DateRange {
  // Validate: value is required for known date options (not the default fallback)
  if (value == null && (option === 'month' || option === 'quarter' || option === 'year' || option === 'custom')) {
    throw new Error(`dateValue is required for dateOption "${option}"`);
  }

  switch (option) {
    case 'month': {
      // Parse 'YYYY-MM' strings explicitly to avoid UTC-vs-local timezone shift
      let year: number;
      let month: number;
      const strVal = String(value);
      const match = strVal.match(/^(\d{4})-(\d{1,2})$/);
      if (match) {
        year = parseInt(match[1], 10);
        month = parseInt(match[2], 10) - 1; // 0-indexed
      } else {
        const date = new Date(value as string | number | Date);
        if (isNaN(date.getTime())) {
          throw new Error(`Invalid month value: ${String(value)}`);
        }
        year = date.getFullYear();
        month = date.getMonth();
      }
      if (year < 1900 || year > 9999) {
        throw new Error(`Year ${year} is out of valid range (1900–9999)`);
      }
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
      return { startDate, endDate };
    }

    case 'quarter': {
      if (typeof value !== 'object' || value === null) {
        throw new Error('Quarter dateValue must be an object with { quarter, year }');
      }
      const { quarter, year } = value as QuarterValue;
      if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        throw new Error(`Invalid quarter: ${quarter}. Must be 1–4.`);
      }
      if (!Number.isInteger(year) || year < 1900 || year > 9999) {
        throw new Error(`Invalid year: ${year}. Must be 1900–9999.`);
      }
      const startMonth = (quarter - 1) * 3;
      const startDate = new Date(year, startMonth, 1);
      const endDate = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
      return { startDate, endDate };
    }

    case 'year': {
      const year = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (isNaN(year) || year < 1900 || year > 9999) {
        throw new Error(`Invalid year: ${String(value)}. Must be a number between 1900–9999.`);
      }
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59, 999);
      return { startDate, endDate };
    }

    case 'custom': {
      if (typeof value !== 'object' || value === null) {
        throw new Error('Custom dateValue must be an object with { startDate, endDate }');
      }
      const { startDate: rawStart, endDate: rawEnd } = value as CustomDateRange;
      if (!rawStart || !rawEnd) {
        throw new Error('Custom date range requires both startDate and endDate');
      }
      const start = new Date(rawStart);
      const end = new Date(rawEnd);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error('Custom date range contains invalid dates');
      }
      if (start > end) {
        throw new Error('startDate must be before endDate');
      }
      // Normalize end date to end-of-day if time is midnight (00:00:00)
      if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0) {
        end.setHours(23, 59, 59, 999);
      }
      return { startDate: start, endDate: end };
    }

    default: {
      // Default: current month
      const now = new Date();
      return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1),
        endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      };
    }
  }
}

/** Get fiscal year start date for a given date and fiscal start month */
export function getFiscalYearStart(date: Date, fiscalStartMonth = 1): Date {
  const month = fiscalStartMonth - 1; // 0-indexed
  const year = date.getMonth() < month ? date.getFullYear() - 1 : date.getFullYear();
  return new Date(year, month, 1);
}
