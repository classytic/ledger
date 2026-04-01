/**
 * Reconciliation Helpers
 *
 * Pure utility functions for reconciliation matching.
 * All monetary values are integer cents.
 */

export interface UnreconciledEntry {
  id: unknown;
  debit: number;   // integer cents
  credit: number;  // integer cents
  date: Date;
  label?: string;
}

export interface MatchSuggestion {
  debitEntryIds: unknown[];
  creditEntryIds: unknown[];
  amount: number;    // matched amount in cents
}

/**
 * Suggest matching groups from unreconciled entries.
 * Finds exact 1:1 debit/credit matches (within tolerance).
 *
 * @param entries - Unreconciled journal items
 * @param tolerance - Cents tolerance for matching (default: 0 = exact match)
 * @returns Suggested match groups
 */
export function suggestMatches(
  entries: UnreconciledEntry[],
  tolerance: number = 0,
): MatchSuggestion[] {
  // Separate into debit and credit entries
  const debits = entries.filter(e => e.debit > 0);
  const credits = entries.filter(e => e.credit > 0);

  const suggestions: MatchSuggestion[] = [];
  const usedDebitIds = new Set<unknown>();
  const usedCreditIds = new Set<unknown>();

  // 1:1 exact (or within tolerance) matching
  for (const debitEntry of debits) {
    if (usedDebitIds.has(debitEntry.id)) continue;

    for (const creditEntry of credits) {
      if (usedCreditIds.has(creditEntry.id)) continue;

      const diff = Math.abs(debitEntry.debit - creditEntry.credit);
      if (diff <= tolerance) {
        suggestions.push({
          debitEntryIds: [debitEntry.id],
          creditEntryIds: [creditEntry.id],
          amount: debitEntry.debit,
        });
        usedDebitIds.add(debitEntry.id);
        usedCreditIds.add(creditEntry.id);
        break;
      }
    }
  }

  return suggestions;
}
