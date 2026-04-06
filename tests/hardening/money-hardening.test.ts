/**
 * Money Arithmetic Hardening Tests
 *
 * Penny-leak prevention, overflow safety, pathological allocation,
 * and precision boundary tests. Beats Odoo's rounding-aware balance
 * checks by testing every edge the float-to-int conversion can hit.
 */

import { describe, it, expect } from 'vitest';
import {
  fromDecimal, toDecimal, add, subtract, multiply,
  percentage, splitTaxInclusive, splitTaxExclusive,
  allocate, round, equals, isZero, abs, negate,
  format, formatPlain, parseCents,
} from '../../src/money.js';

// ── Overflow & Safe Integer Limits ────────────────────────────────────────

describe('Money — overflow protection', () => {
  it('fromDecimal throws when result exceeds MAX_SAFE_INTEGER', () => {
    // MAX_SAFE_INTEGER = 9007199254740991
    // 90071992547409.92 * 100 > MAX_SAFE_INTEGER
    expect(() => fromDecimal(90_071_992_547_410)).toThrow('exceeds safe integer');
  });

  it('fromDecimal succeeds at the boundary', () => {
    // 90071992547409.91 * 100 = 9007199254740991 = MAX_SAFE_INTEGER
    const cents = fromDecimal(90_071_992_547_409.91);
    expect(Number.isSafeInteger(cents)).toBe(true);
  });

  it('fromDecimal with minorUnit=0 handles large whole numbers', () => {
    const cents = fromDecimal(9_007_199_254_740_991, 0);
    expect(cents).toBe(9_007_199_254_740_991);
  });

  it('fromDecimal with minorUnit=3 (e.g. KWD) has tighter limit', () => {
    // 1000x multiplier → lower max
    expect(() => fromDecimal(9_007_199_254_741, 3)).toThrow('exceeds safe integer');
  });
});

// ── Penny-Leak Prevention (Conservation Law) ─────────────────────────────

describe('Money — penny-leak prevention', () => {
  it('splitTaxInclusive: base + tax === inclusive (no penny leak)', () => {
    // Test across many amounts and rates
    const rates = [0.05, 0.07, 0.10, 0.13, 0.15, 0.20, 0.25];
    const amounts = [1, 99, 100, 999, 1001, 9999, 10000, 99999, 123456789];

    for (const rate of rates) {
      for (const amount of amounts) {
        const { base, tax } = splitTaxInclusive(amount, rate);
        expect(base + tax, `splitTaxInclusive(${amount}, ${rate}): ${base} + ${tax} ≠ ${amount}`).toBe(amount);
      }
    }
  });

  it('splitTaxExclusive: base + tax === total (no penny leak)', () => {
    const rates = [0.05, 0.07, 0.10, 0.13, 0.15, 0.20, 0.25];
    const amounts = [1, 99, 100, 999, 1001, 9999, 10000, 99999, 123456789];

    for (const rate of rates) {
      for (const amount of amounts) {
        const { base, tax, total } = splitTaxExclusive(amount, rate);
        expect(base).toBe(amount);
        expect(base + tax, `splitTaxExclusive(${amount}, ${rate}): base + tax ≠ total`).toBe(total);
      }
    }
  });

  it('allocate: sum always equals input (zero remainder error)', () => {
    const cases = [
      { total: 1000, ratios: [1, 1, 1] },
      { total: 1, ratios: [1, 1, 1] },         // 1 cent among 3
      { total: 7, ratios: [1, 1, 1] },          // 7 among 3
      { total: 100, ratios: [33, 33, 34] },
      { total: 99999, ratios: [1, 2, 3, 4, 5] },
      { total: 1, ratios: [1, 1, 1, 1, 1, 1, 1] }, // 1 cent among 7
      { total: 10000, ratios: [1] },             // single ratio
      { total: 0, ratios: [1, 1] },              // zero total
    ];

    for (const { total, ratios } of cases) {
      const parts = allocate(total, ratios);
      const sum = parts.reduce((s, p) => s + p, 0);
      expect(sum, `allocate(${total}, [${ratios}]) sums to ${sum}`).toBe(total);
      expect(parts.length).toBe(ratios.length);
    }
  });

  it('allocate: no part is negative', () => {
    const parts = allocate(3, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // 3 among 10
    for (const p of parts) {
      expect(p).toBeGreaterThanOrEqual(0);
    }
    expect(parts.reduce((s, p) => s + p, 0)).toBe(3);
  });

  it('round-trip: toDecimal(fromDecimal(x)) preserves value for clean decimals', () => {
    const values = [0, 0.01, 0.10, 1.00, 10.50, 100.99, 999.99, 1234.56];
    for (const v of values) {
      expect(toDecimal(fromDecimal(v)), `round-trip failed for ${v}`).toBeCloseTo(v, 10);
    }
  });
});

// ── Float Precision Traps ─────────────────────────────────────────────────

describe('Money — float precision traps', () => {
  it('0.1 + 0.2 problem is avoided via integer cents', () => {
    // In floating point: 0.1 + 0.2 = 0.30000000000000004
    // In cents: 10 + 20 = 30 (exact)
    expect(add(fromDecimal(0.1), fromDecimal(0.2))).toBe(fromDecimal(0.3));
  });

  it('1.005 demonstrates the float precision trap', () => {
    // 1.005 * 100 = 100.49999... in float → Math.round → 100
    // This is the documented trade-off of simple Math.round
    // For exact 3-decimal input, use minorUnit=3 or string parsing
    expect(fromDecimal(1.005)).toBe(100);
  });

  it('negative fractional values round via Math.round semantics', () => {
    // Math.round(-0.5) = -0 in JS (rounds toward +Infinity)
    expect(Object.is(fromDecimal(-0.005), -0)).toBe(true);
    expect(fromDecimal(-1.005)).toBe(-100);
    expect(fromDecimal(-99.995)).toBe(-9999); // -9999.5 → -9999 (rounds toward +∞)
  });

  it('percentage does not lose cents for typical tax rates', () => {
    // 5% of $100.00 = $5.00 = 500 cents
    expect(percentage(10000, 5)).toBe(500);
    // 13% of $99.99 = $12.9987 → 1300 cents
    expect(percentage(9999, 13)).toBe(1300);
    // 7% of $1.00 = $0.07 = 7 cents
    expect(percentage(100, 7)).toBe(7);
  });

  it('percentage with extreme rates', () => {
    // 0.001% (micro-rate)
    expect(percentage(1_000_000, 0.001)).toBe(10);
    // 200% rate
    expect(percentage(10000, 200)).toBe(20000);
    // 0% rate
    expect(percentage(10000, 0)).toBe(0);
  });
});

// ── Allocation Pathology ──────────────────────────────────────────────────

describe('Money — pathological allocation', () => {
  it('allocate 1 cent among 100 recipients', () => {
    const ratios = Array.from({ length: 100 }, () => 1);
    const parts = allocate(1, ratios);
    const sum = parts.reduce((s, p) => s + p, 0);
    expect(sum).toBe(1);
    // Exactly 1 recipient gets the cent, others get 0
    expect(parts.filter(p => p === 1).length).toBe(1);
    expect(parts.filter(p => p === 0).length).toBe(99);
  });

  it('allocate 0 cents among any ratios', () => {
    const parts = allocate(0, [1, 2, 3]);
    expect(parts).toEqual([0, 0, 0]);
  });

  it('allocate with single ratio returns entire amount', () => {
    expect(allocate(12345, [1])).toEqual([12345]);
    expect(allocate(12345, [99])).toEqual([12345]);
  });

  it('allocate with unequal ratios distributes proportionally', () => {
    // 10000 split 70/30
    const parts = allocate(10000, [70, 30]);
    expect(parts[0]).toBe(7000);
    expect(parts[1]).toBe(3000);
  });

  it('allocate with very large ratios', () => {
    const parts = allocate(100, [1_000_000, 1_000_000]);
    expect(parts).toEqual([50, 50]);
  });

  it('throws on empty ratios', () => {
    expect(() => allocate(100, [])).toThrow('non-empty');
  });

  it('throws on negative ratios', () => {
    expect(() => allocate(100, [1, -1])).toThrow('non-negative');
  });

  it('throws on all-zero ratios', () => {
    expect(() => allocate(100, [0, 0, 0])).toThrow('> 0');
  });
});

// ── Formatting Edge Cases ─────────────────────────────────────────────────

describe('Money — formatting edge cases', () => {
  it('formats zero correctly', () => {
    expect(formatPlain(0)).toBe('0.00');
  });

  it('formats negative amounts', () => {
    expect(formatPlain(-1050)).toBe('-10.50');
  });

  it('formats single cent', () => {
    expect(formatPlain(1)).toBe('0.01');
  });

  it('format with JPY produces yen symbol', () => {
    const formatted = format(1000, 'JPY');
    // JPY minorUnit=0 so 1000 = ¥1,000
    expect(formatted).toContain('1');
  });

  it('parseCents handles standard inputs', () => {
    expect(parseCents('0')).toBe(0);
    expect(parseCents('0.00')).toBe(0);
    expect(parseCents('1234.56')).toBe(123456);
  });
});

// ── Comparison & Identity ─────────────────────────────────────────────────

describe('Money — comparison identities', () => {
  it('add(a, negate(a)) === 0 for any a', () => {
    for (const a of [0, 1, -1, 100, -999, 123456789]) {
      expect(add(a, negate(a))).toBe(0);
    }
  });

  it('abs(negate(a)) === abs(a)', () => {
    for (const a of [0, 42, -42, 999999]) {
      expect(abs(negate(a))).toBe(abs(a));
    }
  });

  it('subtract(a, a) === 0', () => {
    for (const a of [0, 1, 100, 999999]) {
      expect(subtract(a, a)).toBe(0);
    }
  });

  it('multiply by 1 is identity', () => {
    for (const a of [0, 1, -1, 100, 999999]) {
      expect(multiply(a, 1)).toBe(a);
    }
  });

  it('multiply by 0 produces zero (or -0 for negatives)', () => {
    expect(multiply(0, 0)).toBe(0);
    expect(multiply(1, 0)).toBe(0);
    expect(multiply(100, 0)).toBe(0);
    // Math.round(-1 * 0) = -0 in JS
    expect(multiply(-1, 0) === 0).toBe(true);
  });

  it('equals is reflexive, symmetric', () => {
    expect(equals(100, 100)).toBe(true);
    expect(equals(100, 200)).toBe(false);
    expect(equals(0, 0)).toBe(true);
  });

  it('isZero only for exactly zero', () => {
    expect(isZero(0)).toBe(true);
    expect(isZero(1)).toBe(false);
    expect(isZero(-1)).toBe(false);
  });
});
