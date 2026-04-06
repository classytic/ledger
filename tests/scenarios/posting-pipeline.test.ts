/**
 * Scenario: Full Posting Pipeline → Reports
 *
 * A small consulting business (AcmeTech) operates for one quarter.
 * Verifies that every posted entry flows correctly through the
 * reporting pipeline: Trial Balance → Income Statement → Balance Sheet.
 *
 * DX: Each test section is a numbered chapter that reads like a story.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConservation,
  postEntry,
  type ScenarioEngine,
  setupScenario,
  teardownScenario,
} from '../helpers/scenario-setup.js';

let s: ScenarioEngine;

beforeAll(async () => {
  s = await setupScenario({}, 'Pipeline');
});
afterAll(async () => {
  await teardownScenario(s);
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 1: Opening — Owner invests $50,000 cash
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Opening Balance', () => {
  it('owner invests $50,000 cash into the business', async () => {
    await postEntry(
      s,
      '2025-01-01',
      'GENERAL',
      [
        { account: '1001', debit: 5_000_000, credit: 0 }, // Cash +$50,000
        { account: '3100', debit: 0, credit: 5_000_000 }, // Share Capital
      ],
      'Owner investment',
    );

    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 2: January Operations
// ═════════════════════════════════════════════════════════════════════════════

describe('2. January Operations', () => {
  it('earns $20,000 service revenue (cash)', async () => {
    await postEntry(
      s,
      '2025-01-15',
      'SALES',
      [
        { account: '1001', debit: 2_000_000, credit: 0 }, // Cash
        { account: '4010', debit: 0, credit: 2_000_000 }, // Service Revenue
      ],
      'Jan consulting revenue',
    );
  });

  it('pays $5,000 rent', async () => {
    await postEntry(
      s,
      '2025-01-20',
      'CASH_PAYMENTS',
      [
        { account: '6010', debit: 500_000, credit: 0 }, // Rent
        { account: '1001', debit: 0, credit: 500_000 }, // Cash
      ],
      'Jan rent',
    );
  });

  it('pays $8,000 salaries', async () => {
    await postEntry(
      s,
      '2025-01-31',
      'PAYROLL',
      [
        { account: '6020', debit: 800_000, credit: 0 }, // Salaries
        { account: '1001', debit: 0, credit: 800_000 }, // Cash
      ],
      'Jan payroll',
    );
  });

  it('conservation holds after January', async () => {
    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 3: February — Revenue on account (AR) + COGS
// ═════════════════════════════════════════════════════════════════════════════

describe('3. February Operations', () => {
  it('invoices $15,000 on account', async () => {
    await postEntry(
      s,
      '2025-02-10',
      'SALES',
      [
        { account: '1200', debit: 1_500_000, credit: 0 }, // AR
        { account: '4010', debit: 0, credit: 1_500_000 }, // Service Revenue
      ],
      'Feb invoice',
    );
  });

  it('incurs $3,000 subcontractor cost', async () => {
    await postEntry(
      s,
      '2025-02-15',
      'PURCHASES',
      [
        { account: '5010', debit: 300_000, credit: 0 }, // COGS
        { account: '2001', debit: 0, credit: 300_000 }, // AP
      ],
      'Subcontractor cost',
    );
  });

  it('pays $5,000 rent and $400 utilities', async () => {
    await postEntry(
      s,
      '2025-02-28',
      'CASH_PAYMENTS',
      [
        { account: '6010', debit: 500_000, credit: 0 }, // Rent
        { account: '6030', debit: 40_000, credit: 0 }, // Utilities
        { account: '1001', debit: 0, credit: 540_000 }, // Cash
      ],
      'Feb rent + utilities',
    );
  });

  it('collects $15,000 AR payment', async () => {
    await postEntry(
      s,
      '2025-02-28',
      'CASH_RECEIPTS',
      [
        { account: '1001', debit: 1_500_000, credit: 0 }, // Cash
        { account: '1200', debit: 0, credit: 1_500_000 }, // AR
      ],
      'AR collection',
    );
  });

  it('conservation holds after February', async () => {
    await assertConservation(s);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 4: March — Equipment purchase + final month
// ═════════════════════════════════════════════════════════════════════════════

describe('4. March Operations', () => {
  it('buys $10,000 equipment', async () => {
    await postEntry(
      s,
      '2025-03-05',
      'GENERAL',
      [
        { account: '1500', debit: 1_000_000, credit: 0 }, // Equipment
        { account: '1001', debit: 0, credit: 1_000_000 }, // Cash
      ],
      'Equipment purchase',
    );
  });

  it('earns $25,000 revenue', async () => {
    await postEntry(
      s,
      '2025-03-15',
      'SALES',
      [
        { account: '1001', debit: 2_500_000, credit: 0 }, // Cash
        { account: '4010', debit: 0, credit: 2_500_000 }, // Service Revenue
      ],
      'Mar revenue',
    );
  });

  it('pays $8,000 salaries + $5,000 rent', async () => {
    await postEntry(
      s,
      '2025-03-31',
      'PAYROLL',
      [
        { account: '6020', debit: 800_000, credit: 0 }, // Salaries
        { account: '1001', debit: 0, credit: 800_000 }, // Cash
      ],
      'Mar payroll',
    );

    await postEntry(
      s,
      '2025-03-31',
      'CASH_PAYMENTS',
      [
        { account: '6010', debit: 500_000, credit: 0 }, // Rent
        { account: '1001', debit: 0, credit: 500_000 }, // Cash
      ],
      'Mar rent',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Chapter 5: Q1 Reports — The payoff
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Q1 Reports Verification', () => {
  it('conservation law holds across all entries', async () => {
    await assertConservation(s);
  });

  it('trial balance debits equal credits', async () => {
    const tb = await s.reports.trialBalance({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    const totalDebit = tb.rows.reduce((sum: number, r: any) => sum + r.ending.debit, 0);
    const totalCredit = tb.rows.reduce((sum: number, r: any) => sum + r.ending.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeGreaterThan(0);
  });

  it('income statement shows correct net income', async () => {
    const is = await s.reports.incomeStatement({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    // Revenue: $20K + $15K + $25K = $60,000 = 6,000,000 cents
    // Expenses: Rent 3x$5K=$15K, Salaries 2x$8K=$16K, COGS $3K, Utilities $400
    // Total expenses: $34,400 = 3,440,000 cents
    // Net income: $25,600 = 2,560,000 cents
    expect(is.netIncome).toBe(2_560_000);
  });

  it('balance sheet balances (A = L + E)', async () => {
    const bs = await s.reports.balanceSheet({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
    });

    expect(bs.summary.isBalanced).toBe(true);
    expect(bs.summary.difference).toBe(0);
    expect(bs.summary.totalAssets).toBeGreaterThan(0);
  });

  it('general ledger cash account shows correct ending balance', async () => {
    const gl = await s.reports.generalLedger({
      dateOption: 'quarter',
      dateValue: { quarter: 1, year: 2025 },
      accountId: String(s.acctIds['1001']),
    });

    const cashLedger = gl.accounts[0];
    expect(cashLedger).toBeDefined();

    // Cash debits: 5M + 2M + 1.5M + 2.5M = 11,000,000
    // Cash credits: 500K + 800K + 540K + 1M + 800K + 500K = 4,140,000
    // Ending: 11,000,000 - 4,140,000 = 6,860,000
    expect(cashLedger.closingBalance).toBe(6_860_000);
  });
});
