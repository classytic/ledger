/**
 * buildOpeningBalanceEntry — pure function tests.
 *
 * Verifies:
 *   - Balanced trial balance → residual is 0, no extra equity line
 *   - Unbalanced TB → equity contra line absorbs the difference
 *   - Mixed debit/credit balances
 *   - Zero-balance accounts are skipped
 *   - Single account edge case
 *   - Label and externalId format
 *   - Entry always balances (debits = credits)
 */

import { describe, expect, it } from 'vitest';

import { buildOpeningBalanceEntry } from '../../../src/sync/builders/opening-balance';
import type { Cents } from '../../../src/types/core';

function sumDebitsCredits(items: Array<{ debit: Cents; credit: Cents }>) {
  const totalDebit = items.reduce((s, i) => s + i.debit, 0);
  const totalCredit = items.reduce((s, i) => s + i.credit, 0);
  return { totalDebit, totalCredit };
}

describe('buildOpeningBalanceEntry — balanced trial balance', () => {
  it('produces a balanced JE with no equity contra line when TB balances', () => {
    // Assets $100k, Liabilities $30k, Equity $70k → debits = credits
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [
        { accountCode: '1000', balance: 10000000 },  // $100k debit (cash)
        { accountCode: '2620', balance: -3000000 },   // $30k credit (AP)
        { accountCode: '3600', balance: -7000000 },   // $70k credit (RE)
      ],
      equityAccountCode: '3600',
    });

    expect(result.residual).toBe(0);
    expect(result.lineCount).toBe(3);
    // No extra equity line since 3600 is already in balances and it balances
    expect(result.entry.journalItems).toHaveLength(3);

    const { totalDebit, totalCredit } = sumDebitsCredits(result.entry.journalItems);
    expect(totalDebit).toBe(totalCredit);
  });

  it('includes metadata fields for idempotency', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [{ accountCode: '1000', balance: 10000 }],
      equityAccountCode: '3600',
    });

    expect(result.entry.extra?._externalId).toBe('opening-balance:2025-01-01');
    expect(result.entry.extra?._importSource).toBe('opening-balance');
    expect(result.entry.journalType).toBe('GENERAL');
  });
});

describe('buildOpeningBalanceEntry — unbalanced trial balance', () => {
  it('adds equity contra line to absorb the difference (more debits)', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [
        { accountCode: '1000', balance: 50000 },  // $500 debit
        { accountCode: '2620', balance: -20000 },  // $200 credit
      ],
      equityAccountCode: '3600',
    });

    // Residual = 50000 - 20000 = 30000 → equity gets a $300 credit
    expect(result.residual).toBe(30000);
    expect(result.entry.journalItems).toHaveLength(3);

    const equityLine = result.entry.journalItems[2];
    expect(equityLine.account).toBe('3600');
    expect(equityLine.credit).toBe(30000);
    expect(equityLine.debit).toBe(0);

    const { totalDebit, totalCredit } = sumDebitsCredits(result.entry.journalItems);
    expect(totalDebit).toBe(totalCredit);
  });

  it('adds equity debit line when credits exceed debits', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [
        { accountCode: '1000', balance: 10000 },
        { accountCode: '2620', balance: -50000 },
      ],
      equityAccountCode: '3600',
    });

    expect(result.residual).toBe(-40000);
    const equityLine = result.entry.journalItems[2];
    expect(equityLine.debit).toBe(40000);
    expect(equityLine.credit).toBe(0);

    const { totalDebit, totalCredit } = sumDebitsCredits(result.entry.journalItems);
    expect(totalDebit).toBe(totalCredit);
  });
});

describe('buildOpeningBalanceEntry — edge cases', () => {
  it('skips zero-balance accounts', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [
        { accountCode: '1000', balance: 10000 },
        { accountCode: '1060', balance: 0 },
        { accountCode: '2620', balance: -10000 },
      ],
      equityAccountCode: '3600',
    });

    expect(result.lineCount).toBe(2);
    expect(result.entry.journalItems).toHaveLength(2);
  });

  it('handles a single account (creates equity contra)', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [{ accountCode: '1000', balance: 50000 }],
      equityAccountCode: '3600',
    });

    expect(result.entry.journalItems).toHaveLength(2);
    expect(result.residual).toBe(50000);

    const { totalDebit, totalCredit } = sumDebitsCredits(result.entry.journalItems);
    expect(totalDebit).toBe(totalCredit);
  });

  it('uses custom label when provided', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [{ accountCode: '1000', balance: 10000 }],
      equityAccountCode: '3600',
      label: 'QBO Migration Opening',
    });

    expect(result.entry.label).toBe('QBO Migration Opening');
  });

  it('uses default label with date when not provided', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-06-15'),
      balances: [{ accountCode: '1000', balance: 10000 }],
      equityAccountCode: '3600',
    });

    expect(result.entry.label).toBe('Opening Balance — Cutover 2025-06-15');
  });

  it('handles empty balances array', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [],
      equityAccountCode: '3600',
    });

    expect(result.entry.journalItems).toHaveLength(0);
    expect(result.residual).toBe(0);
    expect(result.lineCount).toBe(0);
  });
});

describe('buildOpeningBalanceEntry — real-world Canadian small business', () => {
  it('handles a complete Canadian TB with 13 accounts', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: new Date('2025-01-01'),
      balances: [
        { accountCode: '1000', balance: 5000000 },   // Cash $50k
        { accountCode: '1060', balance: 1250000 },   // AR $12.5k
        { accountCode: '1120', balance: 800000 },    // Inventory $8k
        { accountCode: '1180', balance: 500000 },    // ST Investments $5k
        { accountCode: '1600', balance: 2500000 },   // Land $25k
        { accountCode: '1680', balance: 15000000 },  // Buildings $150k
        { accountCode: '1681', balance: -4500000 },  // Accum Amort ($45k)
        { accountCode: '1740', balance: 3500000 },   // M&E $35k
        { accountCode: '1741', balance: -1050000 },  // Accum Amort ($10.5k)
        { accountCode: '2620', balance: -1875000 },  // AP ($18.75k)
        { accountCode: '2680', balance: -8000000 },  // LT Debt ($80k)
        { accountCode: '3400', balance: -10000000 }, // Share Capital ($100k)
        { accountCode: '3600', balance: -3125000 },  // RE ($31.25k)
      ],
      equityAccountCode: '3600',
    });

    expect(result.lineCount).toBe(13);
    expect(result.residual).toBe(0); // balanced TB

    // Entry should have exactly 13 items (no extra equity line)
    expect(result.entry.journalItems).toHaveLength(13);

    const { totalDebit, totalCredit } = sumDebitsCredits(result.entry.journalItems);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(28550000); // sum of all debit-normal balances
  });
});
