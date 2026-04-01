import { describe, it, expect } from 'vitest';
import { taxHookPlugin } from '../../src/plugins/tax-hook.plugin.js';
import type { TaxLineGenerator, TaxLineInput, GeneratedTaxLine } from '../../src/utils/tax-hooks.js';
import { createMockRepository } from '../helpers/mock-repository.js';

/** A 10% tax generator for testing */
const tenPercentGenerator: TaxLineGenerator = {
  generateTaxLines(input: TaxLineInput): GeneratedTaxLine[] {
    if (input.taxCode === 'GST10') {
      const taxAmount = Math.round(input.amount * 0.10);
      return [
        {
          account: 'tax-collected',
          debit: input.side === 'credit' ? taxAmount : 0,
          credit: input.side === 'debit' ? taxAmount : 0,
          label: 'GST 10%',
          taxDetails: [{ taxCode: 'GST10', taxName: 'GST 10%' }],
        },
      ];
    }
    return [];
  },
};

describe('taxHookPlugin', () => {
  it('generates tax lines on posted entries', async () => {
    const repo = createMockRepository();
    taxHookPlugin({ generator: tenPercentGenerator }).apply(repo);

    const data = {
      state: 'posted',
      journalItems: [
        { account: 'revenue', debit: 0, credit: 10000, taxDetails: [{ taxCode: 'GST10' }] },
        { account: 'cash', debit: 10000, credit: 0 },
      ],
    };

    await repo._emitHook('before:create', { data });

    // Should have 3 items: 2 original + 1 tax line
    expect(data.journalItems).toHaveLength(3);
    expect(data.journalItems[2].account).toBe('tax-collected');
    expect(data.journalItems[2].debit).toBe(1000); // 10% of 10000, on credit side -> debit tax
    expect(data.journalItems[2].credit).toBe(0);
  });

  it('skips draft entries when onlyOnPost=true (default)', async () => {
    const repo = createMockRepository();
    taxHookPlugin({ generator: tenPercentGenerator }).apply(repo);

    const data = {
      state: 'draft',
      journalItems: [
        { account: 'revenue', debit: 0, credit: 10000, taxDetails: [{ taxCode: 'GST10' }] },
        { account: 'cash', debit: 10000, credit: 0 },
      ],
    };

    await repo._emitHook('before:create', { data });

    // No tax lines added — items unchanged
    expect(data.journalItems).toHaveLength(2);
  });

  it('applies to all entries when onlyOnPost=false', async () => {
    const repo = createMockRepository();
    taxHookPlugin({ generator: tenPercentGenerator, onlyOnPost: false }).apply(repo);

    const data = {
      state: 'draft',
      journalItems: [
        { account: 'revenue', debit: 0, credit: 10000, taxDetails: [{ taxCode: 'GST10' }] },
        { account: 'cash', debit: 10000, credit: 0 },
      ],
    };

    await repo._emitHook('before:create', { data });

    // Tax lines should be added even for draft
    expect(data.journalItems).toHaveLength(3);
    expect(data.journalItems[2].account).toBe('tax-collected');
  });

  it('maintains balance after tax injection (total debits = total credits)', async () => {
    // Generator that creates balanced tax entries (debit tax-payable, credit original account)
    const balancedGenerator: TaxLineGenerator = {
      generateTaxLines(input: TaxLineInput): GeneratedTaxLine[] {
        if (input.taxCode === 'VAT20') {
          const taxAmount = Math.round(input.amount * 0.20);
          if (input.side === 'debit') {
            // Original was a debit — add a debit to tax account and credit to offset
            return [
              { account: 'vat-input', debit: taxAmount, credit: 0, label: 'VAT Input' },
              { account: 'vat-payable', debit: 0, credit: taxAmount, label: 'VAT Payable' },
            ];
          } else {
            return [
              { account: 'vat-output', debit: 0, credit: taxAmount, label: 'VAT Output' },
              { account: 'vat-receivable', debit: taxAmount, credit: 0, label: 'VAT Receivable' },
            ];
          }
        }
        return [];
      },
    };

    const repo = createMockRepository();
    taxHookPlugin({ generator: balancedGenerator }).apply(repo);

    const data = {
      state: 'posted',
      journalItems: [
        { account: 'expense', debit: 10000, credit: 0, taxDetails: [{ taxCode: 'VAT20' }] },
        { account: 'cash', debit: 0, credit: 10000 },
      ],
    };

    await repo._emitHook('before:create', { data });

    // 2 original + 2 tax lines
    expect(data.journalItems).toHaveLength(4);

    // Verify total debits = total credits
    const totalDebit = data.journalItems.reduce((s, i) => s + (i.debit ?? 0), 0);
    const totalCredit = data.journalItems.reduce((s, i) => s + (i.credit ?? 0), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(12000); // 10000 original + 2000 tax
  });

  it('does not modify items when no tax codes are present', async () => {
    const repo = createMockRepository();
    taxHookPlugin({ generator: tenPercentGenerator }).apply(repo);

    const data = {
      state: 'posted',
      journalItems: [
        { account: 'a1', debit: 5000, credit: 0 },
        { account: 'a2', debit: 0, credit: 5000 },
      ],
    };

    await repo._emitHook('before:create', { data });

    expect(data.journalItems).toHaveLength(2);
  });
});
