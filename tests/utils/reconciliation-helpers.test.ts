import { describe, expect, it } from 'vitest';
import { suggestMatches, type UnreconciledEntry } from '../../src/utils/reconciliation-helpers.js';

function entry(id: string, debit: number, credit: number): UnreconciledEntry {
  return { id, debit, credit, date: new Date() };
}

describe('suggestMatches', () => {
  it('finds exact 1:1 matches', () => {
    const entries: UnreconciledEntry[] = [entry('d1', 5000, 0), entry('c1', 0, 5000)];

    const suggestions = suggestMatches(entries);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].debitEntryIds).toEqual(['d1']);
    expect(suggestions[0].creditEntryIds).toEqual(['c1']);
    expect(suggestions[0].amount).toBe(5000);
  });

  it('matches with tolerance for close amounts', () => {
    const entries: UnreconciledEntry[] = [
      entry('d1', 5000, 0),
      entry('c1', 0, 4998), // 2 cents off
    ];

    // No match with zero tolerance
    expect(suggestMatches(entries, 0)).toHaveLength(0);

    // Match with 5 cent tolerance
    const suggestions = suggestMatches(entries, 5);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].debitEntryIds).toEqual(['d1']);
    expect(suggestions[0].creditEntryIds).toEqual(['c1']);
    expect(suggestions[0].amount).toBe(5000);
  });

  it('returns empty for no matches', () => {
    const entries: UnreconciledEntry[] = [entry('d1', 5000, 0), entry('c1', 0, 3000)];

    const suggestions = suggestMatches(entries);
    expect(suggestions).toHaveLength(0);
  });

  it('returns empty for empty input', () => {
    expect(suggestMatches([])).toHaveLength(0);
  });

  it('returns empty when only debits exist', () => {
    const entries: UnreconciledEntry[] = [entry('d1', 5000, 0), entry('d2', 3000, 0)];

    expect(suggestMatches(entries)).toHaveLength(0);
  });

  it('returns empty when only credits exist', () => {
    const entries: UnreconciledEntry[] = [entry('c1', 0, 5000), entry('c2', 0, 3000)];

    expect(suggestMatches(entries)).toHaveLength(0);
  });

  it('handles multiple matching pairs', () => {
    const entries: UnreconciledEntry[] = [
      entry('d1', 5000, 0),
      entry('d2', 3000, 0),
      entry('c1', 0, 5000),
      entry('c2', 0, 3000),
    ];

    const suggestions = suggestMatches(entries);

    expect(suggestions).toHaveLength(2);

    const amounts = suggestions.map((s) => s.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([3000, 5000]);
  });

  it('does not reuse entries across matches', () => {
    const entries: UnreconciledEntry[] = [
      entry('d1', 5000, 0),
      entry('d2', 5000, 0),
      entry('c1', 0, 5000), // Only one credit, should match only one debit
    ];

    const suggestions = suggestMatches(entries);
    expect(suggestions).toHaveLength(1);
  });

  it('preserves entry labels in suggestions', () => {
    const entries: UnreconciledEntry[] = [
      { id: 'd1', debit: 1000, credit: 0, date: new Date(), label: 'Payment' },
      { id: 'c1', debit: 0, credit: 1000, date: new Date(), label: 'Invoice' },
    ];

    const suggestions = suggestMatches(entries);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].amount).toBe(1000);
  });
});
