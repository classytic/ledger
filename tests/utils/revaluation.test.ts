/**
 * Revaluation Utility Tests
 *
 * Unit tests for the pure revaluation computation functions.
 * No database required — tests pure logic only.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRevaluation,
  buildRevaluationEntry,
  type AccountForeignBalance,
  type RevaluationRate,
} from '../../src/utils/revaluation.js';
import mongoose from 'mongoose';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const id1 = new mongoose.Types.ObjectId();
const id2 = new mongoose.Types.ObjectId();
const id3 = new mongoose.Types.ObjectId();
const gainLossAcctId = new mongoose.Types.ObjectId();

function makeAccount(overrides: Partial<AccountForeignBalance> & { accountId: unknown }): AccountForeignBalance {
  return {
    accountName: 'Test Account',
    accountCode: '1000',
    currency: 'USD',
    foreignBalance: 10000, // 100.00 USD
    baseBalance: 13700,    // 137.00 CAD at historical rate 1.37
    category: 'Balance Sheet-Asset',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// computeRevaluation
// ═════════════════════════════════════════════════════════════════════════════

describe('computeRevaluation', () => {
  it('computes gain when rate increases', () => {
    const accounts: AccountForeignBalance[] = [
      makeAccount({ accountId: id1, foreignBalance: 10000, baseBalance: 13700 }),
    ];
    // Rate went from 1.37 to 1.40 → revaluedBase = 10000 * 1.40 = 14000
    const rates: RevaluationRate[] = [{ currency: 'USD', rate: 1.40 }];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(1);
    expect(results[0].revaluedBase).toBe(14000);
    expect(results[0].historicalBase).toBe(13700);
    expect(results[0].gainLoss).toBe(300); // 14000 - 13700 = 300 cents gain
  });

  it('computes loss when rate decreases', () => {
    const accounts: AccountForeignBalance[] = [
      makeAccount({ accountId: id1, foreignBalance: 10000, baseBalance: 13700 }),
    ];
    // Rate went from 1.37 to 1.30 → revaluedBase = 10000 * 1.30 = 13000
    const rates: RevaluationRate[] = [{ currency: 'USD', rate: 1.30 }];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(1);
    expect(results[0].revaluedBase).toBe(13000);
    expect(results[0].gainLoss).toBe(-700); // 13000 - 13700 = -700 cents loss
  });

  it('skips accounts with zero gain/loss', () => {
    const accounts: AccountForeignBalance[] = [
      makeAccount({ accountId: id1, foreignBalance: 10000, baseBalance: 13700 }),
    ];
    // Same rate → no change
    const rates: RevaluationRate[] = [{ currency: 'USD', rate: 1.37 }];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(0);
  });

  it('handles multiple currencies', () => {
    const accounts: AccountForeignBalance[] = [
      makeAccount({ accountId: id1, currency: 'USD', foreignBalance: 10000, baseBalance: 13700 }),
      makeAccount({ accountId: id2, currency: 'EUR', foreignBalance: 5000, baseBalance: 7500, accountCode: '1100' }),
    ];
    const rates: RevaluationRate[] = [
      { currency: 'USD', rate: 1.40 },
      { currency: 'EUR', rate: 1.60 },
    ];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(2);

    const usdResult = results.find(r => r.currency === 'USD')!;
    expect(usdResult.revaluedBase).toBe(14000);
    expect(usdResult.gainLoss).toBe(300);

    const eurResult = results.find(r => r.currency === 'EUR')!;
    expect(eurResult.revaluedBase).toBe(8000); // 5000 * 1.60
    expect(eurResult.gainLoss).toBe(500);      // 8000 - 7500
  });

  it('skips accounts in the base currency', () => {
    const accounts: AccountForeignBalance[] = [
      makeAccount({ accountId: id1, currency: 'CAD', foreignBalance: 10000, baseBalance: 10000 }),
    ];
    const rates: RevaluationRate[] = [{ currency: 'CAD', rate: 1.0 }];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(0);
  });

  it('skips accounts with no matching rate', () => {
    const accounts: AccountForeignBalance[] = [
      makeAccount({ accountId: id1, currency: 'GBP', foreignBalance: 10000, baseBalance: 17000 }),
    ];
    const rates: RevaluationRate[] = [{ currency: 'USD', rate: 1.40 }];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(0);
  });

  it('rounds revaluedBase to nearest cent', () => {
    const accounts: AccountForeignBalance[] = [
      // 333 cents * 1.37 = 456.21 → rounds to 456
      makeAccount({ accountId: id1, foreignBalance: 333, baseBalance: 450 }),
    ];
    const rates: RevaluationRate[] = [{ currency: 'USD', rate: 1.37 }];

    const results = computeRevaluation(accounts, rates, 'CAD');

    expect(results).toHaveLength(1);
    expect(results[0].revaluedBase).toBe(456); // Math.round(333 * 1.37) = Math.round(456.21) = 456
    expect(results[0].gainLoss).toBe(6);       // 456 - 450
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildRevaluationEntry
// ═════════════════════════════════════════════════════════════════════════════

describe('buildRevaluationEntry', () => {
  it('creates a balanced entry (totalDebit === totalCredit)', () => {
    const results = [
      {
        accountId: id1, accountName: 'USD Cash', accountCode: '1000',
        currency: 'USD', foreignBalance: 10000, historicalBase: 13700,
        revaluedBase: 14000, gainLoss: 300,
      },
      {
        accountId: id2, accountName: 'EUR Receivable', accountCode: '1100',
        currency: 'EUR', foreignBalance: 5000, historicalBase: 7500,
        revaluedBase: 7200, gainLoss: -300,
      },
    ];

    const entry = buildRevaluationEntry(results, gainLossAcctId, new Date('2026-03-31'));

    expect(entry.totalDebit).toBe(entry.totalCredit);
    expect(entry.totalDebit).toBe(600); // 300 gain + 300 loss = 600 each side
  });

  it('handles gains correctly (debit account, credit gain/loss)', () => {
    const results = [
      {
        accountId: id1, accountName: 'USD Cash', accountCode: '1000',
        currency: 'USD', foreignBalance: 10000, historicalBase: 13700,
        revaluedBase: 14000, gainLoss: 300,
      },
    ];

    const entry = buildRevaluationEntry(results, gainLossAcctId, new Date('2026-03-31'));

    expect(entry.journalItems).toHaveLength(2);

    // Account line: debit
    const accountLine = entry.journalItems.find(i => i.account === id1)!;
    expect(accountLine.debit).toBe(300);
    expect(accountLine.credit).toBe(0);

    // Gain/loss line: credit
    const glLine = entry.journalItems.find(i => i.account === gainLossAcctId)!;
    expect(glLine.debit).toBe(0);
    expect(glLine.credit).toBe(300);
  });

  it('handles losses correctly (credit account, debit gain/loss)', () => {
    const results = [
      {
        accountId: id1, accountName: 'USD Cash', accountCode: '1000',
        currency: 'USD', foreignBalance: 10000, historicalBase: 13700,
        revaluedBase: 13000, gainLoss: -700,
      },
    ];

    const entry = buildRevaluationEntry(results, gainLossAcctId, new Date('2026-03-31'));

    expect(entry.journalItems).toHaveLength(2);

    // Account line: credit
    const accountLine = entry.journalItems.find(i => i.account === id1)!;
    expect(accountLine.debit).toBe(0);
    expect(accountLine.credit).toBe(700);

    // Gain/loss line: debit
    const glLine = entry.journalItems.find(i => i.account === gainLossAcctId)!;
    expect(glLine.debit).toBe(700);
    expect(glLine.credit).toBe(0);
  });

  it('skips results with zero gainLoss', () => {
    const results = [
      {
        accountId: id1, accountName: 'USD Cash', accountCode: '1000',
        currency: 'USD', foreignBalance: 10000, historicalBase: 13700,
        revaluedBase: 13700, gainLoss: 0,
      },
    ];

    const entry = buildRevaluationEntry(results, gainLossAcctId, new Date('2026-03-31'));

    expect(entry.journalItems).toHaveLength(0);
    expect(entry.totalDebit).toBe(0);
    expect(entry.totalCredit).toBe(0);
  });

  it('includes a descriptive label with the date', () => {
    const results = [
      {
        accountId: id1, accountName: 'USD Cash', accountCode: '1000',
        currency: 'USD', foreignBalance: 10000, historicalBase: 13700,
        revaluedBase: 14000, gainLoss: 300,
      },
    ];

    const entry = buildRevaluationEntry(results, gainLossAcctId, new Date('2026-03-31'));

    expect(entry.label).toContain('2026-03-31');
    expect(entry.label).toContain('revaluation');
  });

  it('handles multiple results with mixed gains and losses', () => {
    const results = [
      {
        accountId: id1, accountName: 'USD Cash', accountCode: '1000',
        currency: 'USD', foreignBalance: 10000, historicalBase: 13700,
        revaluedBase: 14000, gainLoss: 300,
      },
      {
        accountId: id2, accountName: 'EUR Receivable', accountCode: '1100',
        currency: 'EUR', foreignBalance: 5000, historicalBase: 7500,
        revaluedBase: 7000, gainLoss: -500,
      },
      {
        accountId: id3, accountName: 'GBP Payable', accountCode: '2100',
        currency: 'GBP', foreignBalance: 2000, historicalBase: 3400,
        revaluedBase: 3600, gainLoss: 200,
      },
    ];

    const entry = buildRevaluationEntry(results, gainLossAcctId, new Date('2026-03-31'));

    // 3 results × 2 lines each = 6 journal items
    expect(entry.journalItems).toHaveLength(6);
    // Total each side: 300 + 500 + 200 = 1000
    expect(entry.totalDebit).toBe(1000);
    expect(entry.totalCredit).toBe(1000);
  });
});
