/**
 * Unit tests — repartition tax generator (0.6.0).
 *
 * Verifies that a declarative `TaxCode.repartition` expands into the
 * correct multiple journal items, honoring:
 *
 *   - factor signs (negative = mirror)
 *   - debit/credit side inversion per input.side
 *   - multi-line splits (collected + recoverable)
 *   - documentType filtering
 *   - gridCode propagation into taxDetails
 *   - fallback to single-line when no repartition is declared
 */

import { describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import type { TaxCode } from '../../src/country/index.js';
import { createRepartitionTaxGenerator } from '../../src/utils/repartition-tax.js';

function makeCountryPackWith(codes: Record<string, TaxCode>, resolver?: (role: string) => string | undefined) {
  return defineCountryPack({
    code: 'TR',
    name: 'Test',
    defaultCurrency: 'USD',
    accountTypes: [
      { code: '1000', name: 'x', category: 'Balance Sheet-Asset', description: '', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
    taxCodes: codes,
    taxCodesByRegion: {},
    regions: [],
    resolveTaxRepartitionAccountCode: resolver ? (role) => resolver(role) : undefined,
  });
}

describe('createRepartitionTaxGenerator', () => {
  it('single-line collected HST on a sale (credit side) → credit to collected acct', () => {
    const country = makeCountryPackWith({
      HST13: {
        code: 'HST13',
        name: 'HST 13%',
        taxType: 'HST',
        rate: 13,
        direction: 'collected',
        province: 'ON',
        description: '',
        active: true,
        repartition: [{ factor: 1, accountRole: 'collected', gridCode: 103 }],
      },
    });

    const gen = createRepartitionTaxGenerator({
      country,
      resolveAccount: (role) => `acct-${role}`,
    });

    const lines = gen.generateTaxLines({
      account: 'revenue-acct',
      amount: 100_00, // $100 revenue
      side: 'credit', // the revenue item was a credit
      taxCode: 'HST13',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].account).toBe('acct-collected');
    expect(lines[0].credit).toBe(13_00);
    expect(lines[0].debit).toBe(0);
    expect(lines[0].taxDetails).toEqual([
      { taxCode: 'HST13', taxName: 'HST 13%', gridCode: '103' },
    ]);
  });

  it('reverse-charge: collected + recoverable produces a balanced pair', () => {
    // Convention: factor is the absolute magnitude, role determines side.
    // For reverse-charge on a purchase, both lines are factor=1 — the role
    // picks credit (liability) and debit (asset). Net: perfectly balanced.
    const country = makeCountryPackWith({
      'RC-VAT': {
        code: 'RC-VAT',
        name: 'Reverse-charge VAT',
        taxType: 'VAT',
        rate: 20,
        direction: 'collected',
        description: '',
        active: true,
        repartition: [
          { factor: 1, accountRole: 'collected', gridCode: 100 },
          { factor: 1, accountRole: 'recoverable', gridCode: 200 },
        ],
      },
    });

    const gen = createRepartitionTaxGenerator({
      country,
      resolveAccount: (role) => `acct-${role}`,
    });

    const lines = gen.generateTaxLines({
      account: 'expense-acct',
      amount: 500_00,
      side: 'debit',
      taxCode: 'RC-VAT',
    });

    expect(lines).toHaveLength(2);

    const collected = lines.find((l) => l.account === 'acct-collected');
    expect(collected?.credit).toBe(100_00);
    expect(collected?.debit).toBe(0);

    const recoverable = lines.find((l) => l.account === 'acct-recoverable');
    expect(recoverable?.debit).toBe(100_00);
    expect(recoverable?.credit).toBe(0);

    // Balanced — the two lines net to zero so the parent entry remains balanced.
    const debitSum = lines.reduce((s, l) => s + l.debit, 0);
    const creditSum = lines.reduce((s, l) => s + l.credit, 0);
    expect(debitSum).toBe(creditSum);
  });

  it('falls back to single-line when no repartition is declared', () => {
    const country = makeCountryPackWith({
      FLAT: {
        code: 'FLAT',
        name: 'Flat 5%',
        taxType: 'SALES',
        rate: 5,
        direction: 'collected',
        description: '',
        active: true,
      },
    });

    const gen = createRepartitionTaxGenerator({
      country,
      resolveAccount: (role) => `acct-${role}`,
    });

    const lines = gen.generateTaxLines({
      account: 'x',
      amount: 200_00,
      side: 'credit',
      taxCode: 'FLAT',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].credit).toBe(10_00);
  });

  it('documentType filter skips lines not applicable to the flow', () => {
    const country = makeCountryPackWith({
      COND: {
        code: 'COND',
        name: 'Conditional',
        taxType: 'TEST',
        rate: 10,
        direction: 'collected',
        description: '',
        active: true,
        repartition: [
          { factor: 1, accountRole: 'collected', documentTypes: ['invoice'] },
          { factor: 1, accountRole: 'transition', documentTypes: ['refund'] },
        ],
      },
    });

    const invoiceGen = createRepartitionTaxGenerator({
      country,
      resolveAccount: (role) => `acct-${role}`,
      documentType: 'invoice',
    });
    const invoiceLines = invoiceGen.generateTaxLines({
      account: 'x',
      amount: 100_00,
      side: 'credit',
      taxCode: 'COND',
    });
    expect(invoiceLines).toHaveLength(1);
    expect(invoiceLines[0].account).toBe('acct-collected');

    const refundGen = createRepartitionTaxGenerator({
      country,
      resolveAccount: (role) => `acct-${role}`,
      documentType: 'refund',
    });
    const refundLines = refundGen.generateTaxLines({
      account: 'x',
      amount: 100_00,
      side: 'credit',
      taxCode: 'COND',
    });
    expect(refundLines).toHaveLength(1);
    expect(refundLines[0].account).toBe('acct-transition');
  });

  it('throws when a repartition line references an unresolvable role', () => {
    const country = makeCountryPackWith({
      BAD: {
        code: 'BAD',
        name: 'Bad',
        taxType: 'T',
        rate: 10,
        direction: 'collected',
        description: '',
        active: true,
        repartition: [{ factor: 1, accountRole: 'mystery-role' }],
      },
    });

    const gen = createRepartitionTaxGenerator({
      country,
      resolveAccount: () => undefined, // nothing resolves
    });

    expect(() =>
      gen.generateTaxLines({ account: 'x', amount: 100_00, side: 'credit', taxCode: 'BAD' }),
    ).toThrow(/cannot resolve account for role "mystery-role"/);
  });
});
