/**
 * Scenario: Reversal & Correction Workflow
 *
 * An accountant posts an entry, discovers an error, reverses it,
 * and posts the corrected entry. Verifies that the audit trail
 * is clean and reports reflect only the correct amounts.
 *
 * Beats Odoo's correction tests by verifying the full pipeline:
 * Post → Discover Error → Reverse → Correct → Reports show net effect.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyBalanceSheet, legacyIncomeStatement, legacyTrialBalance } from '../helpers/legacy-report-view.js';
import {
  assertConservation,
  postEntry,
  type ScenarioEngine,
  setupScenario,
  teardownScenario,
} from '../helpers/scenario-setup.js';

let s: ScenarioEngine;

beforeAll(async () => {
  s = await setupScenario({}, 'Reversal');
});
afterAll(async () => {
  await teardownScenario(s);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Setup — Owner invests, business starts
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Setup', () => {
  it('owner invests $100,000', async () => {
    await postEntry(
      s,
      '2025-01-01',
      'GENERAL',
      [
        { account: '1001', debit: 10_000_000, credit: 0 },
        { account: '3100', debit: 0, credit: 10_000_000 },
      ],
      'Owner investment',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The Mistake — Accountant records $50,000 revenue (should be $5,000)
// ═════════════════════════════════════════════════════════════════════════════

describe('2. The Mistake', () => {
  it('posts wrong revenue amount ($50,000 instead of $5,000)', async () => {
    await postEntry(
      s,
      '2025-01-15',
      'SALES',
      [
        { account: '1001', debit: 5_000_000, credit: 0 },
        { account: '4010', debit: 0, credit: 5_000_000 },
      ],
      'WRONG: Jan revenue (should be $5K not $50K)',
    );

    // At this point, income statement would show $50K revenue — incorrect
    const is = await s.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-01',
    });
    expect(legacyIncomeStatement(is).netIncome).toBe(5_000_000); // $50,000 — wrong!
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The Reversal — Post an exact reversal entry
// ═════════════════════════════════════════════════════════════════════════════

describe('3. The Reversal', () => {
  it('posts reversal entry (mirror of the mistake)', async () => {
    // Reverse: swap debit/credit
    await postEntry(
      s,
      '2025-01-16',
      'GENERAL',
      [
        { account: '4010', debit: 5_000_000, credit: 0 }, // Reverse revenue
        { account: '1001', debit: 0, credit: 5_000_000 }, // Reverse cash
      ],
      'REVERSAL: Correcting wrong Jan revenue entry',
    );

    await assertConservation(s);
  });

  it('after reversal, net revenue from mistake is zero', async () => {
    const is = await s.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-01',
    });
    // $50K mistake + $50K reversal = $0 net revenue
    expect(legacyIncomeStatement(is).netIncome).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The Correction — Post the correct $5,000 revenue
// ═════════════════════════════════════════════════════════════════════════════

describe('4. The Correction', () => {
  it('posts correct revenue amount ($5,000)', async () => {
    await postEntry(
      s,
      '2025-01-17',
      'SALES',
      [
        { account: '1001', debit: 500_000, credit: 0 }, // Cash $5,000
        { account: '4010', debit: 0, credit: 500_000 }, // Service Revenue
      ],
      'CORRECTED: Jan revenue ($5,000)',
    );

    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Verification — Reports show correct final state
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Post-Correction Reports', () => {
  it('income statement shows correct $5,000 net income', async () => {
    const is = await s.reports.incomeStatement({
      dateOption: 'month',
      dateValue: '2025-01',
    });

    // Net revenue: $50K mistake - $50K reversal + $5K correct = $5,000
    expect(legacyIncomeStatement(is).netIncome).toBe(500_000);
  });

  it('trial balance still balanced after 4 entries', async () => {
    const tb = await s.reports.trialBalance({
      dateOption: 'month',
      dateValue: '2025-01',
    });

    const totalDebit = legacyTrialBalance(tb).rows.reduce((sum: number, r: any) => sum + r.ending.debit, 0);
    const totalCredit = legacyTrialBalance(tb).rows.reduce((sum: number, r: any) => sum + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('balance sheet: A = L + E', async () => {
    const bs = await s.reports.balanceSheet({
      dateOption: 'month',
      dateValue: '2025-01',
    });

    expect(legacyBalanceSheet(bs).summary.isBalanced).toBe(true);
    expect(legacyBalanceSheet(bs).summary.difference).toBe(0);
    // Assets = Cash = $100K + $5K net = $105K
    expect(legacyBalanceSheet(bs).summary.totalAssets).toBe(10_500_000);
  });

  it('general ledger revenue account shows all 3 entries', async () => {
    const gl = await s.reports.generalLedger({
      dateOption: 'month',
      dateValue: '2025-01',
      accountId: String(s.acctIds['4010']),
    });

    const revenueAcct = gl.accounts[0];
    expect(revenueAcct).toBeDefined();
    // 3 entries: mistake credit, reversal debit, correction credit
    expect(revenueAcct.entries.length).toBe(3);
  });

  it('conservation law holds at the end', async () => {
    await assertConservation(s);
  });
});
