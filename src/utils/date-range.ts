/**
 * Date Range Utility — Compute period boundaries for reports.
 */

import type { DateOption, DateRange, QuarterValue, CustomDateRange } from '../types/core.js';

/**
 * Compute start/end dates from a date option + value.
 *
 * Examples:
 *   getDateRange('month', '2025-03')            → Mar 1 – Mar 31
 *   getDateRange('quarter', { quarter: 2, year: 2025 }) → Apr 1 – Jun 30
 *   getDateRange('year', 2025)                  → Jan 1 – Dec 31
 *   getDateRange('custom', { startDate, endDate })
 */
export function getDateRange(option: DateOption, value: unknown): DateRange {
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
        year = date.getFullYear();
        month = date.getMonth();
      }
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
      return { startDate, endDate };
    }

    case 'quarter': {
      const { quarter, year } = value as QuarterValue;
      const startMonth = (quarter - 1) * 3;
      const startDate = new Date(year, startMonth, 1);
      const endDate = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
      return { startDate, endDate };
    }

    case 'year': {
      const year = typeof value === 'number' ? value : parseInt(String(value), 10);
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59, 999);
      return { startDate, endDate };
    }

    case 'custom': {
      const { startDate, endDate } = value as CustomDateRange;
      const end = new Date(endDate);
      // Normalize end date to end-of-day if time is midnight (00:00:00)
      if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0) {
        end.setHours(23, 59, 59, 999);
      }
      return {
        startDate: new Date(startDate),
        endDate: end,
      };
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
