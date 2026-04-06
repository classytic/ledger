/**
 * Scenario: Conservation Law Integration Test
 *
 * The fundamental invariant of double-entry bookkeeping:
 *   Total Debits === Total Credits (always, everywhere, forever)
 *
 * Inspired by @classytic/flow's inventory conservation tests.
 * We verify this invariant survives:
 * - Bulk posting
 * - Mixed journal types
 * - Multi-account entries
 * - Draft-to-posted transitions
 * - Rebuild from individual entries
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupScenario, teardownScenario, postEntry, draftEntry, assertConservation,
  type ScenarioEngine,
} from '../helpers/scenario-setup.js';

let s: ScenarioEngine;

beforeAll(async () => { s = await setupScenario({}, 'Conservation'); });
afterAll(async () => { await teardownScenario(s); });

// ═════════════════════════════════════════════════════════════════════════════
// 1. Bulk posting — 20 entries with varying amounts
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Bulk Posting Conservation', () => {
  it('posts 20 entries of varying sizes', async () => {
    const amounts = [
      100, 999, 1_000, 5_000, 10_000, 25_000, 50_000, 99_999,
      100_000, 250_000, 500_000, 1_000_000, 1_500_000, 2_000_000,
      3_000_000, 5_000_000, 7_500_000, 10_000_000, 15_000_000, 1,
    ];

    for (let i = 0; i < amounts.length; i++) {
      const amt = amounts[i];
      await postEntry(s, `2025-01-${String(i + 1).padStart(2, '0')}`, 'GENERAL', [
        { account: '1001', debit: amt, credit: 0 },
        { account: '3100', debit: 0, credit: amt },
      ]);
    }

    await assertConservation(s);
  });

  it('total debits === total credits across all 20 entries', async () => {
    const result = await s.JE.aggregate([
      { $match: { state: 'posted' } },
      { $group: { _id: null, d: { $sum: '$totalDebit' }, c: { $sum: '$totalCredit' } } },
    ]);

    expect(result[0].d).toBe(result[0].c);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Multi-line entries — 3+ accounts per entry
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Multi-Line Entry Conservation', () => {
  it('posts 3-line entry: revenue splits cash + AR', async () => {
    await postEntry(s, '2025-02-01', 'SALES', [
      { account: '1001', debit: 700_000, credit: 0 },      // Cash 70%
      { account: '1200', debit: 300_000, credit: 0 },      // AR 30%
      { account: '4010', debit: 0, credit: 1_000_000 },    // Revenue 100%
    ]);
    await assertConservation(s);
  });

  it('posts 5-line compound entry', async () => {
    await postEntry(s, '2025-02-05', 'GENERAL', [
      { account: '6010', debit: 200_000, credit: 0 },      // Rent
      { account: '6020', debit: 300_000, credit: 0 },      // Salaries
      { account: '6030', debit: 50_000, credit: 0 },       // Utilities
      { account: '2300', debit: 0, credit: 50_000 },       // Tax payable
      { account: '1001', debit: 0, credit: 500_000 },      // Cash
    ]);
    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Mixed journal types
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Mixed Journal Types', () => {
  it('posts entries across different journal types', async () => {
    await postEntry(s, '2025-03-01', 'SALES', [
      { account: '1001', debit: 500_000, credit: 0 },
      { account: '4020', debit: 0, credit: 500_000 },
    ]);
    await postEntry(s, '2025-03-02', 'PURCHASES', [
      { account: '5010', debit: 200_000, credit: 0 },
      { account: '2001', debit: 0, credit: 200_000 },
    ]);
    await postEntry(s, '2025-03-03', 'CASH_RECEIPTS', [
      { account: '1001', debit: 200_000, credit: 0 },
      { account: '1200', debit: 0, credit: 200_000 },
    ]);
    await postEntry(s, '2025-03-04', 'CASH_PAYMENTS', [
      { account: '2001', debit: 200_000, credit: 0 },
      { account: '1001', debit: 0, credit: 200_000 },
    ]);
    await postEntry(s, '2025-03-05', 'PAYROLL', [
      { account: '6020', debit: 400_000, credit: 0 },
      { account: '1001', debit: 0, credit: 400_000 },
    ]);

    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Drafts don't break conservation
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Drafts and Conservation', () => {
  it('unbalanced drafts do not affect posted conservation', async () => {
    // Create unbalanced draft
    await draftEntry(s, '2025-04-01', 'GENERAL', [
      { account: '1001', debit: 999_999, credit: 0 },
      { account: '4010', debit: 0, credit: 1 },
    ], 'Unbalanced draft — does not affect conservation');

    // Conservation only checks posted entries
    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Rebuild verification — sum line items matches sum totalDebit/Credit
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Rebuild Verification', () => {
  it('sum of all line item debits === sum of all totalDebit', async () => {
    const entries = await s.JE.find({ state: 'posted' }).lean();

    let lineDebitSum = 0;
    let lineCreditSum = 0;
    let headerDebitSum = 0;
    let headerCreditSum = 0;

    for (const entry of entries) {
      headerDebitSum += entry.totalDebit;
      headerCreditSum += entry.totalCredit;
      for (const item of entry.journalItems) {
        lineDebitSum += item.debit;
        lineCreditSum += item.credit;
      }
    }

    // Line items match header totals
    expect(lineDebitSum).toBe(headerDebitSum);
    expect(lineCreditSum).toBe(headerCreditSum);

    // Conservation law
    expect(lineDebitSum).toBe(lineCreditSum);
    expect(headerDebitSum).toBe(headerCreditSum);
  });

  it('no entry has zero total (non-trivial check)', async () => {
    const entries = await s.JE.find({ state: 'posted' }).lean();

    for (const entry of entries) {
      expect(entry.totalDebit, `Entry ${entry.referenceNumber} has zero total`).toBeGreaterThan(0);
    }
  });

  it('total number of posted entries matches expected count', async () => {
    const count = await s.JE.countDocuments({ state: 'posted' });
    // 20 bulk + 2 multi-line + 5 mixed + = 27
    expect(count).toBe(27);
  });
});
