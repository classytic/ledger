import { describe, expect, it } from 'vitest';
import {
  abs,
  add,
  allocate,
  equals,
  format,
  formatPlain,
  fromDecimal,
  isValid,
  isZero,
  Money,
  multiply,
  negate,
  parseCents,
  percentage,
  splitTaxExclusive,
  splitTaxInclusive,
  subtract,
  toDecimal,
} from '../src/money.js';

describe('Money — Integer-cents arithmetic', () => {
  // ── Conversion ───────────────────────────────────────────────────────────

  describe('fromDecimal / toDecimal', () => {
    it('converts dollars to cents', () => {
      expect(fromDecimal(10.5)).toBe(1050);
      expect(fromDecimal(0)).toBe(0);
      expect(fromDecimal(100)).toBe(10000);
      expect(fromDecimal(0.01)).toBe(1);
      expect(fromDecimal(99.99)).toBe(9999);
    });

    it('handles negative amounts', () => {
      expect(fromDecimal(-5.25)).toBe(-525);
    });

    it('rounds correctly on edge cases', () => {
      // 1.005 * 100 = 100.4999... in IEEE 754, so Math.round → 100
      // This is correct — use string input for precise amounts: parseCents('1.005')
      expect(fromDecimal(1.005)).toBe(100);
      expect(fromDecimal(0.1 + 0.2)).toBe(30); // classic float trap → 30 cents
    });

    it('converts cents back to dollars', () => {
      expect(toDecimal(1050)).toBe(10.5);
      expect(toDecimal(0)).toBe(0);
      expect(toDecimal(1)).toBe(0.01);
    });

    it('handles JPY (0 minor units)', () => {
      expect(fromDecimal(1000, 0)).toBe(1000);
      expect(toDecimal(1000, 0)).toBe(1000);
    });
  });

  // ── Arithmetic ───────────────────────────────────────────────────────────

  describe('arithmetic', () => {
    it('adds cents', () => {
      expect(add(100, 250)).toBe(350);
      expect(add(-100, 50)).toBe(-50);
    });

    it('subtracts cents', () => {
      expect(subtract(1000, 300)).toBe(700);
    });

    it('multiplies and rounds', () => {
      expect(multiply(100, 1.5)).toBe(150);
      expect(multiply(333, 0.1)).toBe(33); // rounds
    });

    it('calculates percentage', () => {
      expect(percentage(10000, 5)).toBe(500); // 5% of $100
      expect(percentage(10000, 13)).toBe(1300); // 13% of $100 (Ontario HST)
      expect(percentage(10000, 15)).toBe(1500); // 15% of $100 (Atlantic HST)
    });
  });

  // ── Tax Splitting ────────────────────────────────────────────────────────

  describe('tax splitting', () => {
    it('splits tax-inclusive GST 5%', () => {
      const { base, tax } = splitTaxInclusive(10500, 0.05);
      expect(base).toBe(10000);
      expect(tax).toBe(500);
      expect(base + tax).toBe(10500);
    });

    it('splits tax-inclusive HST 13%', () => {
      const { base, tax } = splitTaxInclusive(11300, 0.13);
      expect(base).toBe(10000);
      expect(tax).toBe(1300);
      expect(base + tax).toBe(11300);
    });

    it('splits tax-exclusive GST 5%', () => {
      const { base, tax, total } = splitTaxExclusive(10000, 0.05);
      expect(base).toBe(10000);
      expect(tax).toBe(500);
      expect(total).toBe(10500);
    });

    it('splits tax-exclusive HST 13%', () => {
      const { base, tax, total } = splitTaxExclusive(10000, 0.13);
      expect(base).toBe(10000);
      expect(tax).toBe(1300);
      expect(total).toBe(11300);
    });

    it('handles QST 9.975% correctly', () => {
      const { base, tax, total } = splitTaxExclusive(10000, 0.09975);
      expect(tax).toBe(998); // 9.975% of $100 = $9.975 → rounds to $9.98
      expect(total).toBe(10998);
    });
  });

  // ── Allocation ───────────────────────────────────────────────────────────

  describe('allocate', () => {
    it('splits evenly with no remainder', () => {
      expect(allocate(900, [1, 1, 1])).toEqual([300, 300, 300]);
    });

    it('distributes remainder fairly (largest-remainder method)', () => {
      const result = allocate(1000, [1, 1, 1]);
      expect(result).toEqual([334, 333, 333]);
      expect(result.reduce((s, a) => s + a, 0)).toBe(1000);
    });

    it('handles weighted allocation', () => {
      const result = allocate(10000, [50, 30, 20]);
      expect(result).toEqual([5000, 3000, 2000]);
    });

    it('handles single ratio', () => {
      expect(allocate(1000, [1])).toEqual([1000]);
    });

    it('throws on empty ratios', () => {
      expect(() => allocate(100, [])).toThrow();
    });

    it('throws on negative ratios', () => {
      expect(() => allocate(100, [1, -1])).toThrow();
    });

    it('always sums to the original amount', () => {
      // Property test: random amounts and ratios
      const amounts = [1, 7, 99, 100, 999, 10000, 123456];
      const ratioSets = [[1, 1, 1], [3, 2, 1], [1, 2, 3, 4], [1]];

      for (const amount of amounts) {
        for (const ratios of ratioSets) {
          const result = allocate(amount, ratios);
          expect(result.reduce((s, a) => s + a, 0)).toBe(amount);
        }
      }
    });
  });

  // ── Comparison ───────────────────────────────────────────────────────────

  describe('comparison', () => {
    it('equals', () => {
      expect(equals(100, 100)).toBe(true);
      expect(equals(100, 101)).toBe(false);
    });

    it('isZero', () => {
      expect(isZero(0)).toBe(true);
      expect(isZero(1)).toBe(false);
    });

    it('abs / negate', () => {
      expect(abs(-500)).toBe(500);
      expect(negate(500)).toBe(-500);
    });
  });

  // ── Formatting ───────────────────────────────────────────────────────────

  describe('formatting', () => {
    it('formats as currency', () => {
      const result = format(10550, 'CAD', 'en-CA');
      expect(result).toContain('105.50');
    });

    it('formats plain', () => {
      expect(formatPlain(10550)).toBe('105.50');
      expect(formatPlain(0)).toBe('0.00');
      expect(formatPlain(1)).toBe('0.01');
    });
  });

  // ── Validation & Parsing ─────────────────────────────────────────────────

  describe('validation', () => {
    it('validates integer cents', () => {
      expect(isValid(100)).toBe(true);
      expect(isValid(0)).toBe(true);
      expect(isValid(-50)).toBe(true);
      expect(isValid(1.5)).toBe(false); // not integer
      expect(isValid(NaN)).toBe(false);
      expect(isValid(Infinity)).toBe(false);
      expect(isValid('100' as unknown)).toBe(false);
    });

    it('parses string to cents', () => {
      expect(parseCents('105.50')).toBe(10550);
      expect(parseCents('$1,234.56')).toBe(123456);
      expect(parseCents(10.5)).toBe(1050);
    });

    it('throws on unparseable strings', () => {
      expect(() => parseCents('abc')).toThrow();
    });
  });

  // ── Comparison (extended) ────────────────────────────────────────────────

  describe('isPositive / isNegative', () => {
    it('isPositive', () => {
      expect(Money.isPositive(100)).toBe(true);
      expect(Money.isPositive(1)).toBe(true);
      expect(Money.isPositive(0)).toBe(false);
      expect(Money.isPositive(-1)).toBe(false);
    });

    it('isNegative', () => {
      expect(Money.isNegative(-100)).toBe(true);
      expect(Money.isNegative(-1)).toBe(true);
      expect(Money.isNegative(0)).toBe(false);
      expect(Money.isNegative(1)).toBe(false);
    });
  });

  describe('min / max', () => {
    it('returns min of two amounts', () => {
      expect(Money.min(100, 200)).toBe(100);
      expect(Money.min(200, 100)).toBe(100);
      expect(Money.min(-50, 50)).toBe(-50);
      expect(Money.min(0, 0)).toBe(0);
    });

    it('returns max of two amounts', () => {
      expect(Money.max(100, 200)).toBe(200);
      expect(Money.max(200, 100)).toBe(200);
      expect(Money.max(-50, 50)).toBe(50);
      expect(Money.max(0, 0)).toBe(0);
    });
  });

  // ── Formatting (extended) ──────────────────────────────────────────────

  describe('format (extended)', () => {
    it('formats USD', () => {
      const result = format(10550, 'USD', 'en-US');
      expect(result).toContain('105.50');
    });

    it('formats JPY (0 minor units)', () => {
      const result = format(1000, 'JPY', 'ja-JP', 0);
      expect(result).toContain('1,000');
    });

    it('formats negative amounts', () => {
      const result = format(-5050, 'CAD', 'en-CA');
      expect(result).toContain('50.50');
    });

    it('formats zero', () => {
      const result = format(0, 'CAD', 'en-CA');
      expect(result).toContain('0.00');
    });
  });

  describe('formatPlain (extended)', () => {
    it('handles JPY (0 minor units)', () => {
      expect(Money.formatPlain(1000, 0)).toBe('1000');
    });

    it('handles negative amounts', () => {
      expect(Money.formatPlain(-5050)).toBe('-50.50');
    });

    it('handles large amounts', () => {
      expect(Money.formatPlain(1234567890)).toBe('12345678.90');
    });
  });

  // ── Percentage (extended) ──────────────────────────────────────────────

  describe('percentage (extended)', () => {
    it('zero cents returns 0', () => {
      expect(percentage(0, 5)).toBe(0);
    });

    it('negative cents', () => {
      expect(percentage(-10000, 10)).toBe(-1000);
    });

    it('100% returns the original', () => {
      expect(percentage(5000, 100)).toBe(5000);
    });

    it('fractional percentage rounds correctly', () => {
      expect(percentage(10000, 9.975)).toBe(998); // QST
    });

    it('very small percentage', () => {
      expect(percentage(100, 0.01)).toBe(0); // rounds to 0
      expect(percentage(100000, 0.01)).toBe(10);
    });
  });

  // ── Tax Splitting (extended) ───────────────────────────────────────────

  describe('tax splitting (extended)', () => {
    it('splitTaxInclusive with zero amount', () => {
      const { base, tax } = splitTaxInclusive(0, 0.05);
      expect(base).toBe(0);
      expect(tax).toBe(0);
    });

    it('splitTaxExclusive with zero amount', () => {
      const { base, tax, total } = splitTaxExclusive(0, 0.05);
      expect(base).toBe(0);
      expect(tax).toBe(0);
      expect(total).toBe(0);
    });

    it('splitTaxInclusive with zero tax rate', () => {
      const { base, tax } = splitTaxInclusive(10000, 0);
      expect(base).toBe(10000);
      expect(tax).toBe(0);
    });

    it('splitTaxExclusive with zero tax rate', () => {
      const { base, tax, total } = splitTaxExclusive(10000, 0);
      expect(base).toBe(10000);
      expect(tax).toBe(0);
      expect(total).toBe(10000);
    });

    it('splitTaxInclusive preserves total', () => {
      const amounts = [1, 99, 10500, 99999];
      const rates = [0.05, 0.13, 0.15, 0.25];
      for (const amount of amounts) {
        for (const rate of rates) {
          const { base, tax } = splitTaxInclusive(amount, rate);
          expect(base + tax).toBe(amount);
        }
      }
    });
  });

  // ── Allocate (extended) ────────────────────────────────────────────────

  describe('allocate (extended)', () => {
    it('throws on all-zero ratios', () => {
      expect(() => allocate(1000, [0, 0, 0])).toThrow('Sum of ratios must be > 0');
    });

    it('handles zero total cents', () => {
      const result = allocate(0, [1, 1, 1]);
      expect(result).toEqual([0, 0, 0]);
    });

    it('handles two-way split with remainder', () => {
      const result = allocate(1001, [1, 1]);
      expect(result.reduce((s, a) => s + a, 0)).toBe(1001);
      expect(result[0]).toBe(501);
      expect(result[1]).toBe(500);
    });

    it('handles large number of ratios', () => {
      const ratios = Array.from({ length: 100 }, () => 1);
      const result = allocate(1000, ratios);
      expect(result.reduce((s, a) => s + a, 0)).toBe(1000);
      expect(result.every((v) => v === 10)).toBe(true);
    });

    it('handles unequal remainders with many parts', () => {
      const result = allocate(10, [1, 1, 1, 1, 1, 1, 1]);
      expect(result.reduce((s, a) => s + a, 0)).toBe(10);
    });
  });

  // ── Validation (extended) ─────────────────────────────────────────────

  describe('isValid (extended)', () => {
    it('rejects null/undefined', () => {
      expect(isValid(null)).toBe(false);
      expect(isValid(undefined)).toBe(false);
    });

    it('rejects boolean', () => {
      expect(isValid(true)).toBe(false);
    });

    it('accepts negative integers', () => {
      expect(isValid(-500)).toBe(true);
    });
  });

  // ── parseCents (extended) ──────────────────────────────────────────────

  describe('parseCents (extended)', () => {
    it('parses plain number strings', () => {
      expect(parseCents('0')).toBe(0);
      expect(parseCents('0.01')).toBe(1);
      expect(parseCents('1000')).toBe(100000);
    });

    it('strips whitespace', () => {
      expect(parseCents(' 50.00 ')).toBe(5000);
    });

    it('handles JPY (0 minor units)', () => {
      expect(parseCents('1000', 0)).toBe(1000);
    });

    it('handles empty string', () => {
      expect(() => parseCents('')).toThrow('Cannot parse');
    });
  });

  // ── round ──────────────────────────────────────────────────────────────

  describe('round', () => {
    it('rounds .5 up', () => {
      expect(Money.round(10.5)).toBe(11);
    });

    it('rounds .4 down', () => {
      expect(Money.round(10.4)).toBe(10);
    });

    it('identity for integers', () => {
      expect(Money.round(100)).toBe(100);
    });

    it('handles negative rounding', () => {
      expect(Money.round(-10.5)).toBe(-10);
      expect(Money.round(-10.6)).toBe(-11);
    });
  });

  // ── negate / abs (extended) ────────────────────────────────────────────

  describe('negate / abs (extended)', () => {
    it('negate of zero produces -0 (JS semantics)', () => {
      // In JavaScript, -0 is a valid value: -(0) === -0
      expect(negate(0)).toBe(-0);
    });

    it('double negate returns original', () => {
      expect(negate(negate(500))).toBe(500);
    });

    it('abs of zero is zero', () => {
      expect(abs(0)).toBe(0);
    });

    it('abs of positive is same', () => {
      expect(abs(500)).toBe(500);
    });
  });

  // ── Bundled Export ───────────────────────────────────────────────────────

  describe('Money namespace', () => {
    it('exports all functions', () => {
      expect(Money.fromDecimal).toBe(fromDecimal);
      expect(Money.toDecimal).toBe(toDecimal);
      expect(Money.allocate).toBe(allocate);
      expect(Money.splitTaxInclusive).toBe(splitTaxInclusive);
    });

    it('exports all comparison functions', () => {
      expect(typeof Money.equals).toBe('function');
      expect(typeof Money.isZero).toBe('function');
      expect(typeof Money.isPositive).toBe('function');
      expect(typeof Money.isNegative).toBe('function');
      expect(typeof Money.min).toBe('function');
      expect(typeof Money.max).toBe('function');
    });

    it('exports all formatting functions', () => {
      expect(typeof Money.format).toBe('function');
      expect(typeof Money.formatPlain).toBe('function');
    });

    it('exports validation functions', () => {
      expect(typeof Money.isValid).toBe('function');
      expect(typeof Money.parseCents).toBe('function');
    });
  });
});
