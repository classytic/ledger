/**
 * Money — Integer-cents arithmetic helpers for safe financial computation.
 *
 * Provides utilities that operate on **integer minor-unit values** (cents) to
 * avoid floating-point rounding errors in intermediate calculations.
 *
 * **DB storage contract:**
 * Journal entry `debit` / `credit` / `totalDebit` / `totalCredit` fields are
 * stored as **integer cents** (e.g. 10050 for $100.50). All report outputs,
 * aggregation results, and repository methods return integer cents.
 *
 * Use `Money.fromDecimal()` to convert user-facing dollar inputs to cents
 * at the HTTP/API boundary. Use `Money.toDecimal()` or `Money.formatPlain()`
 * to convert cents back to dollars for display or CSV export.
 *
 * Example workflow:
 *   const cents = Money.fromDecimal(req.body.debit);  // 100.50 → 10050
 *   const taxCents = Money.percentage(cents, 5);       // 5% → 502 (rounded)
 *   const display = Money.formatPlain(taxCents);       // 502 → "5.02"
 *
 * Inspired by Stripe's money handling — simple, correct, auditable.
 *
 * @module @classytic/ledger/money
 */

// ─── Core Arithmetic ─────────────────────────────────────────────────────────

/** Round a floating-point value to the nearest integer cent */
export function round(amount: number): number {
  return Math.round(amount);
}

/** Convert a decimal dollar amount to integer cents: 10.50 → 1050 */
export function fromDecimal(dollars: number, minorUnit = 2): number {
  const factor = 10 ** minorUnit;
  const cents = Math.round(dollars * factor);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `Amount ${dollars} exceeds safe integer limit when converted to minor units. ` +
      `Max safe amount: ${Number.MAX_SAFE_INTEGER / factor}`,
    );
  }
  return cents;
}

/** Convert integer cents to a decimal dollar amount: 1050 → 10.50 */
export function toDecimal(cents: number, minorUnit = 2): number {
  const factor = 10 ** minorUnit;
  return cents / factor;
}

/** Add two cent amounts */
export function add(a: number, b: number): number {
  return a + b;
}

/** Subtract b from a in cents */
export function subtract(a: number, b: number): number {
  return a - b;
}

/** Multiply cents by a factor, rounding to nearest cent */
export function multiply(cents: number, factor: number): number {
  return Math.round(cents * factor);
}

/**
 * Calculate a percentage of a cent amount.
 * percentage(10000, 5) → 500 (5% of $100.00 = $5.00)
 */
export function percentage(cents: number, rate: number): number {
  return Math.round((cents * rate) / 100);
}

/**
 * Calculate tax from a tax-inclusive amount.
 * splitTaxInclusive(10500, 0.05) → { base: 10000, tax: 500 }
 */
export function splitTaxInclusive(
  inclusiveAmount: number,
  taxRate: number,
): { base: number; tax: number } {
  const base = Math.round(inclusiveAmount / (1 + taxRate));
  const tax = inclusiveAmount - base;
  return { base, tax };
}

/**
 * Calculate tax from a tax-exclusive amount.
 * splitTaxExclusive(10000, 0.05) → { base: 10000, tax: 500, total: 10500 }
 */
export function splitTaxExclusive(
  exclusiveAmount: number,
  taxRate: number,
): { base: number; tax: number; total: number } {
  const tax = Math.round(exclusiveAmount * taxRate);
  return { base: exclusiveAmount, tax, total: exclusiveAmount + tax };
}

// ─── Allocation ──────────────────────────────────────────────────────────────

/**
 * Allocate cents across ratios with zero remainder error.
 * Uses largest-remainder method (same as parliamentary seat allocation).
 *
 * allocate(1000, [1, 1, 1]) → [334, 333, 333]  (sums to 1000 exactly)
 * allocate(10000, [50, 30, 20]) → [5000, 3000, 2000]
 */
export function allocate(totalCents: number, ratios: number[]): number[] {
  if (ratios.length === 0) throw new Error('Ratios must be non-empty');
  if (ratios.some(r => r < 0)) throw new Error('Ratios must be non-negative');

  const ratioSum = ratios.reduce((s, r) => s + r, 0);
  if (ratioSum === 0) throw new Error('Sum of ratios must be > 0');

  // Base allocation (floor)
  const allocations = ratios.map(r => Math.floor((totalCents * r) / ratioSum));
  let remainder = totalCents - allocations.reduce((s, a) => s + a, 0);

  // Distribute remainder by largest fractional part
  const fractions = ratios.map((r, i) => ({
    index: i,
    frac: ((totalCents * r) / ratioSum) - allocations[i],
  }));
  fractions.sort((a, b) => b.frac - a.frac);

  for (let i = 0; i < remainder; i++) {
    allocations[fractions[i].index]++;
  }

  return allocations;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

/** Are two cent amounts equal? */
export function equals(a: number, b: number): boolean {
  return a === b;
}

/** Is the amount zero? */
export function isZero(cents: number): boolean {
  return cents === 0;
}

/** Is the amount positive (> 0)? */
export function isPositive(cents: number): boolean {
  return cents > 0;
}

/** Is the amount negative (< 0)? */
export function isNegative(cents: number): boolean {
  return cents < 0;
}

/** Absolute value */
export function abs(cents: number): number {
  return Math.abs(cents);
}

/** Negate */
export function negate(cents: number): number {
  return -cents;
}

/** Min of two amounts */
export function min(a: number, b: number): number {
  return Math.min(a, b);
}

/** Max of two amounts */
export function max(a: number, b: number): number {
  return Math.max(a, b);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format cents as a currency string.
 * format(10550, 'CAD') → "$105.50"
 * format(10550, 'CAD', 'en-CA') → "$105.50"
 */
export function format(
  cents: number,
  currencyCode = 'CAD',
  locale = 'en-CA',
  minorUnit = 2,
): string {
  const dollars = toDecimal(cents, minorUnit);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
  }).format(dollars);
}

/**
 * Format cents as a plain decimal string (no currency symbol).
 * formatPlain(10550) → "105.50"
 */
export function formatPlain(cents: number, minorUnit = 2): string {
  return toDecimal(cents, minorUnit).toFixed(minorUnit);
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Is the value a valid integer cent amount? */
export function isValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Parse a string or number into cents.
 * parseCents("105.50") → 10550
 * parseCents(105.50) → 10550
 */
export function parseCents(input: string | number, minorUnit = 2): number {
  if (typeof input === 'number') return fromDecimal(input, minorUnit);

  const cleaned = input.replace(/[$,\s]/g, '');
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) throw new Error(`Cannot parse "${input}" as money`);
  return fromDecimal(parsed, minorUnit);
}

// ─── Bundled Export ──────────────────────────────────────────────────────────

export const Money = {
  round,
  fromDecimal,
  toDecimal,
  add,
  subtract,
  multiply,
  percentage,
  splitTaxInclusive,
  splitTaxExclusive,
  allocate,
  equals,
  isZero,
  isPositive,
  isNegative,
  abs,
  negate,
  min,
  max,
  format,
  formatPlain,
  isValid,
  parseCents,
} as const;
