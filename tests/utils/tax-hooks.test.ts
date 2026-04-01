import { describe, it, expect } from 'vitest';
import { applyTaxHook } from '../../src/utils/tax-hooks.js';
import type { TaxLineGenerator, TaxLineInput, GeneratedTaxLine } from '../../src/utils/tax-hooks.js';
import type { JournalItem } from '../../src/types/core.js';

/** Helper to build a journal item */
function makeItem(overrides: Partial<JournalItem> & { account: string; debit: number; credit: number }): JournalItem {
  return overrides as JournalItem;
}

/** A 10% tax generator for testing */
const tenPercentGenerator: TaxLineGenerator = {
  generateTaxLines(input: TaxLineInput): GeneratedTaxLine[] {
    if (input.taxCode === 'GST10') {
      const taxAmount = Math.round(input.amount * 0.10);
      return [
        {
          account: 'tax-collected',
          debit: input.side === 'debit' ? taxAmount : 0,
          credit: input.side === 'credit' ? taxAmount : 0,
          label: 'GST 10%',
          taxDetails: [{ taxCode: 'GST10', taxName: 'GST 10%' }],
        },
      ];
    }
    // Unknown tax code — return nothing
    return [];
  },
};

describe('applyTaxHook', () => {
  it('produces no extra lines when items have no tax codes', () => {
    const items: JournalItem[] = [
      makeItem({ account: 'a1', debit: 10000, credit: 0 }),
      makeItem({ account: 'a2', debit: 0, credit: 10000 }),
    ];

    const result = applyTaxHook(items, tenPercentGenerator);

    expect(result).toHaveLength(2);
    expect(result).toEqual(items);
  });

  it('generates correct debit tax line for a 10% tax', () => {
    const items: JournalItem[] = [
      makeItem({
        account: 'revenue',
        debit: 10000,
        credit: 0,
        taxDetails: [{ taxCode: 'GST10' }],
      }),
      makeItem({ account: 'cash', debit: 0, credit: 10000 }),
    ];

    const result = applyTaxHook(items, tenPercentGenerator);

    expect(result).toHaveLength(3);
    // Third item is the generated tax line
    expect(result[2].account).toBe('tax-collected');
    expect(result[2].debit).toBe(1000);  // 10% of 10000
    expect(result[2].credit).toBe(0);
    expect(result[2].label).toBe('GST 10%');
    expect(result[2].taxDetails).toEqual([{ taxCode: 'GST10', taxName: 'GST 10%' }]);
  });

  it('generates correct credit tax line for a 10% tax', () => {
    const items: JournalItem[] = [
      makeItem({ account: 'expense', debit: 0, credit: 5000, taxDetails: [{ taxCode: 'GST10' }] }),
    ];

    const result = applyTaxHook(items, tenPercentGenerator);

    expect(result).toHaveLength(2);
    expect(result[1].account).toBe('tax-collected');
    expect(result[1].debit).toBe(0);
    expect(result[1].credit).toBe(500); // 10% of 5000
  });

  it('preserves original items unchanged', () => {
    const original: JournalItem[] = [
      makeItem({ account: 'a1', debit: 10000, credit: 0, taxDetails: [{ taxCode: 'GST10' }] }),
      makeItem({ account: 'a2', debit: 0, credit: 10000 }),
    ];

    const result = applyTaxHook(original, tenPercentGenerator);

    // Original items are still at the front
    expect(result[0]).toBe(original[0]);
    expect(result[1]).toBe(original[1]);
    // Original array is not mutated
    expect(original).toHaveLength(2);
  });

  it('handles multiple items with different tax codes', () => {
    const multiGenerator: TaxLineGenerator = {
      generateTaxLines(input: TaxLineInput): GeneratedTaxLine[] {
        if (input.taxCode === 'GST5') {
          return [{
            account: 'gst-account',
            debit: input.side === 'debit' ? Math.round(input.amount * 0.05) : 0,
            credit: input.side === 'credit' ? Math.round(input.amount * 0.05) : 0,
            label: 'GST 5%',
            taxDetails: [{ taxCode: 'GST5' }],
          }];
        }
        if (input.taxCode === 'PST8') {
          return [{
            account: 'pst-account',
            debit: input.side === 'debit' ? Math.round(input.amount * 0.08) : 0,
            credit: input.side === 'credit' ? Math.round(input.amount * 0.08) : 0,
            label: 'PST 8%',
            taxDetails: [{ taxCode: 'PST8' }],
          }];
        }
        return [];
      },
    };

    const items: JournalItem[] = [
      makeItem({ account: 'a1', debit: 10000, credit: 0, taxDetails: [{ taxCode: 'GST5' }] }),
      makeItem({ account: 'a2', debit: 20000, credit: 0, taxDetails: [{ taxCode: 'PST8' }] }),
      makeItem({ account: 'a3', debit: 0, credit: 30000 }),
    ];

    const result = applyTaxHook(items, multiGenerator);

    expect(result).toHaveLength(5); // 3 original + 2 tax lines
    expect(result[3].account).toBe('gst-account');
    expect(result[3].debit).toBe(500);  // 5% of 10000
    expect(result[4].account).toBe('pst-account');
    expect(result[4].debit).toBe(1600); // 8% of 20000
  });

  it('returns no extra lines when generator returns empty array for unknown codes', () => {
    const items: JournalItem[] = [
      makeItem({ account: 'a1', debit: 10000, credit: 0, taxDetails: [{ taxCode: 'UNKNOWN' }] }),
    ];

    const result = applyTaxHook(items, tenPercentGenerator);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(items[0]);
  });
});
