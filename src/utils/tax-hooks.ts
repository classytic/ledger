/**
 * Tax Calculation Hooks
 *
 * Provides a TaxLineGenerator interface and applyTaxHook utility
 * so users can plug in their own tax logic (GST, VAT, sales tax)
 * without the engine being opinionated about tax rules.
 */

import type { JournalItem, TaxDetail } from '../types/core.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface TaxLineInput {
  account: unknown;
  amount: number;            // integer cents
  side: 'debit' | 'credit';
  taxCode?: string;
  extraFields?: Record<string, unknown>;
}

export interface GeneratedTaxLine {
  account: unknown;          // tax account to post to
  debit: number;             // integer cents
  credit: number;            // integer cents
  label?: string;
  taxDetails?: Array<{ taxCode: string; taxName?: string }>;
}

export interface TaxLineGenerator {
  generateTaxLines(input: TaxLineInput): GeneratedTaxLine[];
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Apply a tax hook to journal items.
 *
 * Iterates each item that has a taxCode in taxDetails, calls
 * `generator.generateTaxLines` for each, and appends the generated
 * tax lines as new journal items.
 *
 * @returns The original items + generated tax items
 */
export function applyTaxHook(
  items: JournalItem[],
  generator: TaxLineGenerator,
): JournalItem[] {
  const taxLines: JournalItem[] = [];

  for (const item of items) {
    const taxDetails = item.taxDetails as TaxDetail[] | undefined;
    if (!taxDetails || taxDetails.length === 0) continue;

    // Find the first taxCode in the item's taxDetails
    const taxCode = taxDetails.find(td => td.taxCode != null)?.taxCode;
    if (!taxCode) continue;

    // Determine side and amount from the item
    const side: 'debit' | 'credit' = item.debit > 0 ? 'debit' : 'credit';
    const amount = item.debit > 0 ? item.debit : item.credit;

    const input: TaxLineInput = {
      account: item.account,
      amount,
      side,
      taxCode,
    };

    const generated = generator.generateTaxLines(input);

    for (const line of generated) {
      taxLines.push({
        account: line.account,
        debit: line.debit,
        credit: line.credit,
        label: line.label,
        taxDetails: line.taxDetails,
      } as JournalItem);
    }
  }

  return [...items, ...taxLines];
}
