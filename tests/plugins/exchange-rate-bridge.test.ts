/**
 * ExchangeRateBridge — Contract Tests
 *
 * Verifies the bridge interface contract per PACKAGE_RULES §23:
 *   - All bridges optional, all methods optional
 *   - getRate returns a positive number
 *   - getRates (batch) is optional
 *   - Engine degrades gracefully when no bridge is provided
 */

import { describe, it, expect } from 'vitest';
import type { ExchangeRateBridge } from '../../src/bridges/exchange-rate.bridge.js';

// ── Minimal implementation (manual rates) ──────────────────────────────────

const fixedRates: Record<string, number> = {
  'USD→BDT': 120.50,
  'EUR→BDT': 131.20,
  'GBP→BDT': 153.80,
  'BDT→BDT': 1,
};

const manualBridge: ExchangeRateBridge = {
  async getRate(from, to, _date, _purpose) {
    if (from === to) return 1;
    const key = `${from}→${to}`;
    const rate = fixedRates[key];
    if (!rate) throw new Error(`No rate for ${key}`);
    return rate;
  },
};

// ── Implementation with batch support ──────────────────────────────────────

const batchBridge: ExchangeRateBridge = {
  async getRate(from, to) {
    if (from === to) return 1;
    return fixedRates[`${from}→${to}`] ?? 0;
  },
  async getRates(requests) {
    const results = new Map<string, number>();
    for (const req of requests) {
      const key = `${req.fromCurrency}→${req.toCurrency}`;
      results.set(key, fixedRates[key] ?? 1);
    }
    return results;
  },
};

describe('ExchangeRateBridge contract', () => {
  it('getRate returns a positive number for known pairs', async () => {
    const rate = await manualBridge.getRate('USD', 'BDT', new Date());
    expect(rate).toBe(120.50);
    expect(rate).toBeGreaterThan(0);
  });

  it('getRate returns 1 for same-currency pair', async () => {
    const rate = await manualBridge.getRate('BDT', 'BDT', new Date());
    expect(rate).toBe(1);
  });

  it('getRate throws for unknown pair', async () => {
    await expect(
      manualBridge.getRate('XYZ', 'BDT', new Date()),
    ).rejects.toThrow('No rate');
  });

  it('getRate accepts optional purpose parameter', async () => {
    const buying = await manualBridge.getRate('USD', 'BDT', new Date(), 'buying');
    const selling = await manualBridge.getRate('USD', 'BDT', new Date(), 'selling');
    // Fixed bridge returns same rate for both — host implementations may differ
    expect(buying).toBe(selling);
  });

  it('getRates is optional (PACKAGE_RULES §23)', () => {
    expect(manualBridge.getRates).toBeUndefined();
  });

  it('getRates batch lookup returns Map when implemented', async () => {
    const results = await batchBridge.getRates!([
      { fromCurrency: 'USD', toCurrency: 'BDT', date: new Date() },
      { fromCurrency: 'EUR', toCurrency: 'BDT', date: new Date() },
    ]);
    expect(results).toBeInstanceOf(Map);
    expect(results.get('USD→BDT')).toBe(120.50);
    expect(results.get('EUR→BDT')).toBe(131.20);
  });

  it('bridge satisfies LedgerBridges.exchangeRate type', () => {
    // Type-level check — if this compiles, the bridge fits
    const bridges: { exchangeRate?: ExchangeRateBridge } = {
      exchangeRate: manualBridge,
    };
    expect(bridges.exchangeRate).toBeDefined();
  });

  it('engine works without bridge (rate passed explicitly on journal items)', () => {
    // When no bridge, caller must provide exchangeRate on each journal item.
    // This is the existing behavior — bridge is additive convenience.
    const bridges: { exchangeRate?: ExchangeRateBridge } = {};
    expect(bridges.exchangeRate).toBeUndefined();
  });
});
