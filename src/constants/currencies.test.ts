import { describe, it, expect } from 'vitest';
import {
  CURRENCIES, getCurrency, isValidCurrency, getMinorUnit,
} from './currencies.js';

describe('Currencies', () => {
  describe('CURRENCIES', () => {
    it('includes major currencies', () => {
      expect(CURRENCIES.CAD).toBeDefined();
      expect(CURRENCIES.USD).toBeDefined();
      expect(CURRENCIES.GBP).toBeDefined();
      expect(CURRENCIES.EUR).toBeDefined();
      expect(CURRENCIES.JPY).toBeDefined();
    });

    it('each currency has code, name, symbol, and minorUnit', () => {
      for (const [key, curr] of Object.entries(CURRENCIES)) {
        expect(curr.code).toBe(key);
        expect(typeof curr.name).toBe('string');
        expect(typeof curr.symbol).toBe('string');
        expect(typeof curr.minorUnit).toBe('number');
      }
    });

    it('JPY has 0 minor units', () => {
      expect(CURRENCIES.JPY.minorUnit).toBe(0);
    });

    it('CAD has 2 minor units', () => {
      expect(CURRENCIES.CAD.minorUnit).toBe(2);
    });

    it('includes regional currencies (BDT, AED, SAR)', () => {
      expect(CURRENCIES.BDT).toBeDefined();
      expect(CURRENCIES.AED).toBeDefined();
      expect(CURRENCIES.SAR).toBeDefined();
    });
  });

  describe('getCurrency', () => {
    it('returns currency for valid code', () => {
      const cad = getCurrency('CAD');
      expect(cad).toBeDefined();
      expect(cad!.code).toBe('CAD');
      expect(cad!.name).toBe('Canadian Dollar');
      expect(cad!.symbol).toBe('$');
    });

    it('returns null for invalid code', () => {
      expect(getCurrency('XXX')).toBeNull();
      expect(getCurrency('')).toBeNull();
    });
  });

  describe('isValidCurrency', () => {
    it('returns true for valid codes', () => {
      expect(isValidCurrency('CAD')).toBe(true);
      expect(isValidCurrency('USD')).toBe(true);
      expect(isValidCurrency('JPY')).toBe(true);
    });

    it('returns false for invalid codes', () => {
      expect(isValidCurrency('XXX')).toBe(false);
      expect(isValidCurrency('')).toBe(false);
      expect(isValidCurrency('cad')).toBe(false); // case-sensitive
    });
  });

  describe('getMinorUnit', () => {
    it('returns correct minor unit for known currencies', () => {
      expect(getMinorUnit('CAD')).toBe(2);
      expect(getMinorUnit('USD')).toBe(2);
      expect(getMinorUnit('JPY')).toBe(0);
      expect(getMinorUnit('GBP')).toBe(2);
    });

    it('defaults to 2 for unknown currencies', () => {
      expect(getMinorUnit('XXX')).toBe(2);
      expect(getMinorUnit('')).toBe(2);
    });
  });
});
