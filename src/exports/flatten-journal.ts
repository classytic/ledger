/**
 * Journal Entry Flattener — Denormalizes journal entries into flat rows.
 *
 * Each journal item becomes one row with entry-level fields repeated.
 * Monetary values stay as integer cents (matching DB storage).
 *
 * @module @classytic/ledger/exports
 */

import type {
  PopulatedJournalEntry,
  PopulatedAccount,
  FlatJournalRow,
} from './types.js';

function toDate(value: Date | string | undefined | null): Date {
  if (!value) return new Date(0);
  if (value instanceof Date) return value;
  return new Date(value);
}

function resolveAccount(
  account: PopulatedAccount | string | null | undefined,
): { id: string; name: string; typeCode: string } {
  if (!account) return { id: '', name: '', typeCode: '' };
  if (typeof account === 'string') return { id: account, name: '', typeCode: '' };
  return {
    id: String(account._id ?? ''),
    name: account.name ?? '',
    typeCode: account.accountTypeCode ?? '',
  };
}

/** Flatten a single journal entry into one FlatJournalRow per journal item. */
export function flattenJournalEntry(entry: PopulatedJournalEntry): FlatJournalRow[] {
  const entryDate = toDate(entry.date);
  const items = entry.journalItems ?? [];
  const itemCount = items.length;

  // Known core item keys — everything else is an extra dimension field
  const KNOWN_ITEM_KEYS = new Set(['account', 'label', 'date', 'debit', 'credit', 'taxDetails']);

  return items.map((item, index) => {
    const acct = resolveAccount(item.account);
    const firstTax = item.taxDetails?.[0];

    // Collect extra item fields (dimensions like departmentId, projectId, etc.)
    const extraItemFields: Record<string, unknown> = {};
    for (const key of Object.keys(item)) {
      if (!KNOWN_ITEM_KEYS.has(key)) {
        extraItemFields[key] = (item as Record<string, unknown>)[key];
      }
    }

    return {
      entryId: String(entry._id ?? ''),
      journalType: entry.journalType ?? '',
      referenceNumber: entry.referenceNumber ?? '',
      entryLabel: entry.label ?? '',
      entryDate,
      state: entry.state,
      reversed: entry.reversed ?? false,
      totalDebit: entry.totalDebit ?? 0,
      totalCredit: entry.totalCredit ?? 0,

      accountId: acct.id,
      accountName: acct.name,
      accountTypeCode: acct.typeCode,
      itemLabel: item.label ?? '',
      itemDate: item.date ? toDate(item.date) : entryDate,
      debit: item.debit ?? 0,
      credit: item.credit ?? 0,
      taxCode: firstTax?.taxCode ?? '',
      taxName: firstTax?.taxName ?? '',

      itemIndex: index,
      itemCount,
      ...extraItemFields,
    };
  });
}

/** Flatten multiple journal entries into a single flat row array. */
export function flattenJournalEntries(
  entries: readonly PopulatedJournalEntry[],
): FlatJournalRow[] {
  const rows: FlatJournalRow[] = [];
  for (const entry of entries) {
    rows.push(...flattenJournalEntry(entry));
  }
  return rows;
}
