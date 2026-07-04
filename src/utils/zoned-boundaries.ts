/**
 * Zone-aware calendar boundaries for reports, fiscal periods, and reference
 * numbers — the ONE place ledger turns a civil period ("March 2025", "Q2",
 * "FY2025", "the month containing this entry") into an absolute instant.
 *
 * Report windows are CIVIL boundaries that must resolve to the same instant
 * regardless of the deploy machine's `TZ` env. We express each boundary as a
 * civil date in the engine's reporting zone and bind it via
 * `@classytic/primitives/timezone` (DST-exact). Never the server-local
 * `new Date(year, month, day)` constructor, which silently shifts periods on
 * a non-UTC host (PACKAGE_RULES P12).
 *
 * The default zone `'UTC'` reproduces a UTC-deployed server's historical
 * behaviour exactly, so the fix only changes hosts that were already drifting.
 */

import { civilDate, civilDateOf, civilDateToInstant } from '@classytic/primitives/timezone';

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');

/**
 * First-of-month local-midnight instant in `zone`. `month1` is 1-based and may
 * overflow/underflow (e.g. `13` → next January, `0` → previous December).
 */
export function zonedFirstOfMonth(year: number, month1: number, zone: string): Date {
  const y = year + Math.floor((month1 - 1) / 12);
  const m = ((((month1 - 1) % 12) + 12) % 12) + 1;
  return civilDateToInstant(civilDate(`${pad4(y)}-${pad2(m)}-01`), zone);
}

/**
 * Inclusive period end: 1ms before the next period's first-midnight — i.e. the
 * last instant of the period in `zone` (`…-31T23:59:59.999` at UTC). Pass the
 * NEXT period's `zonedFirstOfMonth(...)`.
 */
export function endBefore(nextFirst: Date): Date {
  return new Date(nextFirst.getTime() - 1);
}

/** Civil year / month (1-based) / day of `instant` in `zone`. */
export function civilPartsOf(
  instant: Date,
  zone: string,
): { year: number; month: number; day: number } {
  const [year, month, day] = civilDateOf(instant, zone).split('-').map(Number);
  return { year, month, day };
}
