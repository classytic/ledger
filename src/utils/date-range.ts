/**
 * Date Range Utility — Compute period boundaries for reports.
 *
 * All inputs are validated to prevent silent failures from invalid dates.
 *
 * Boundaries are resolved in the engine's reporting `zone` (default `'UTC'`)
 * via {@link zonedFirstOfMonth} / {@link civilPartsOf} — never the server-local
 * `new Date(year, month, day)` constructor, which shifts periods with the
 * deploy machine's `TZ` env. See `utils/zoned-boundaries.ts` + PACKAGE_RULES P12.
 */

import {
  addCivilDays,
  civilDate,
  civilDateOf,
  civilDateToInstant,
} from '@classytic/primitives/timezone';
import type { CustomDateRange, DateOption, DateRange, QuarterValue } from '../types/core.js';
import { civilPartsOf, endBefore, zonedFirstOfMonth } from './zoned-boundaries.js';

/**
 * Compute start/end dates from a date option + value, in the given reporting
 * `zone` (IANA name; default `'UTC'`).
 *
 * @throws {Error} If value is null/undefined/invalid for the given option
 *
 * Examples (zone = 'UTC'):
 *   getDateRange('month', '2025-03')            → Mar 1 – Mar 31
 *   getDateRange('quarter', { quarter: 2, year: 2025 }) → Apr 1 – Jun 30
 *   getDateRange('year', 2025)                  → Jan 1 – Dec 31
 *   getDateRange('custom', { startDate, endDate })
 */
export function getDateRange(option: DateOption, value: unknown, zone = 'UTC'): DateRange {
  // Validate: value is required for known date options (not the default fallback)
  if (
    value == null &&
    (option === 'month' || option === 'quarter' || option === 'year' || option === 'custom')
  ) {
    throw new Error(`dateValue is required for dateOption "${option}"`);
  }

  switch (option) {
    case 'month': {
      // Parse 'YYYY-MM' strings explicitly to avoid UTC-vs-local timezone shift
      let year: number;
      let month: number; // 0-indexed
      const strVal = String(value);
      const match = strVal.match(/^(\d{4})-(\d{1,2})$/);
      if (match) {
        year = parseInt(match[1], 10);
        month = parseInt(match[2], 10) - 1;
      } else {
        const date = new Date(value as string | number | Date);
        if (Number.isNaN(date.getTime())) {
          throw new Error(`Invalid month value: ${String(value)}`);
        }
        const p = civilPartsOf(date, zone);
        year = p.year;
        month = p.month - 1;
      }
      if (year < 1900 || year > 9999) {
        throw new Error(`Year ${year} is out of valid range (1900–9999)`);
      }
      const startDate = zonedFirstOfMonth(year, month + 1, zone);
      const endDate = endBefore(zonedFirstOfMonth(year, month + 2, zone));
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
      const startMonth = (quarter - 1) * 3; // 0-indexed
      const startDate = zonedFirstOfMonth(year, startMonth + 1, zone);
      const endDate = endBefore(zonedFirstOfMonth(year, startMonth + 4, zone));
      return { startDate, endDate };
    }

    case 'year': {
      const year = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (Number.isNaN(year) || year < 1900 || year > 9999) {
        throw new Error(`Invalid year: ${String(value)}. Must be a number between 1900–9999.`);
      }
      const startDate = zonedFirstOfMonth(year, 1, zone);
      const endDate = endBefore(zonedFirstOfMonth(year + 1, 1, zone));
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
      let end = new Date(rawEnd);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error('Custom date range contains invalid dates');
      }
      if (start > end) {
        throw new Error('startDate must be before endDate');
      }
      // If `end` lands exactly on local midnight in the reporting zone (a
      // date-only bound), extend it to the last instant of that day so the
      // whole day is included — zone-aware, never server-local getHours().
      const endCivil = civilDate(civilDateOf(end, zone));
      if (civilDateToInstant(endCivil, zone).getTime() === end.getTime()) {
        end = endBefore(civilDateToInstant(addCivilDays(endCivil, 1), zone));
      }
      return { startDate: start, endDate: end };
    }

    default: {
      // Default: current month (in the reporting zone)
      const p = civilPartsOf(new Date(), zone);
      return {
        startDate: zonedFirstOfMonth(p.year, p.month, zone),
        endDate: endBefore(zonedFirstOfMonth(p.year, p.month + 1, zone)),
      };
    }
  }
}

/** Get fiscal year start instant for a given date and fiscal start month, in `zone`. */
export function getFiscalYearStart(date: Date, fiscalStartMonth = 1, zone = 'UTC'): Date {
  const { year, month } = civilPartsOf(date, zone); // month is 1-based
  const fiscalYear = month < fiscalStartMonth ? year - 1 : year;
  return zonedFirstOfMonth(fiscalYear, fiscalStartMonth, zone);
}
