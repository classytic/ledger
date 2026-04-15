/**
 * Ledger domain event names.
 *
 * Convention: `ledger:<resource>.<verb>` — matches the catalog/revenue/flow
 * namespace pattern so hosts can subscribe with a single glob
 * (`ledger:entry.*`, `ledger:*`).
 */

export const LEDGER_EVENTS = {
  // Journal entry lifecycle
  ENTRY_CREATED: 'ledger:entry.created',
  ENTRY_POSTED: 'ledger:entry.posted',
  ENTRY_UNPOSTED: 'ledger:entry.unposted',
  ENTRY_ARCHIVED: 'ledger:entry.archived',
  ENTRY_DUPLICATED: 'ledger:entry.duplicated',
  ENTRY_REVERSED: 'ledger:entry.reversed',

  // Accounts
  ACCOUNT_SEEDED: 'ledger:account.seeded',
  ACCOUNT_BULK_CREATED: 'ledger:account.bulk-created',

  // Journals
  JOURNAL_SEEDED: 'ledger:journal.seeded',

  // Reconciliation (item-level matching)
  RECONCILIATION_MATCHED: 'ledger:reconciliation.matched',
  RECONCILIATION_UNMATCHED: 'ledger:reconciliation.unmatched',
} as const;

export type LedgerEventName = (typeof LEDGER_EVENTS)[keyof typeof LEDGER_EVENTS];
