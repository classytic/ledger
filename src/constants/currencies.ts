/**
 * ISO 4217 Currency Definitions
 */

import type { Currency } from '../types/core.js';

export const CURRENCIES: Readonly<Record<string, Currency>> = Object.freeze({
  CAD: { code: 'CAD', name: 'Canadian Dollar', symbol: '$', minorUnit: 2 },
  USD: { code: 'USD', name: 'US Dollar', symbol: '$', minorUnit: 2 },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£', minorUnit: 2 },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€', minorUnit: 2 },
  JPY: { code: 'JPY', name: 'Japanese Yen', symbol: '¥', minorUnit: 0 },
  AUD: { code: 'AUD', name: 'Australian Dollar', symbol: '$', minorUnit: 2 },
  CHF: { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', minorUnit: 2 },
  INR: { code: 'INR', name: 'Indian Rupee', symbol: '₹', minorUnit: 2 },
  BDT: { code: 'BDT', name: 'Bangladeshi Taka', symbol: '৳', minorUnit: 2 },
  AED: { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', minorUnit: 2 },
  SAR: { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', minorUnit: 2 },
});

export function getCurrency(code: string): Currency | null {
  return CURRENCIES[code] ?? null;
}

export function isValidCurrency(code: string): boolean {
  return code in CURRENCIES;
}

export function getMinorUnit(code: string): number {
  return CURRENCIES[code]?.minorUnit ?? 2;
}
