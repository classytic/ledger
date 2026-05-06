/**
 * Public input shapes accepted by `journalEntries.create()` and
 * `buildOpeningBalanceEntry()`. Extracted from the now-removed
 * `types/sync.ts` because:
 *   - These shapes describe ledger's CREATE surface; they're inherent to the
 *     accounting engine, independent of any importer/exporter glue.
 *   - The opening-balance builder (still public ledger API) needs them.
 *   - Extracting them lets host-owned import code re-import these types
 *     from `@classytic/ledger` without re-introducing a sync subpath.
 *
 * The host import/export orchestrators (`wireImport`, mappers, etc.) lived
 * in `@classytic/ledger/sync` until 0.11.0. They are now host responsibility
 * — see fajr-be-arc's `#shared/ledger-sync` for the canonical implementation.
 */

import type { Cents } from './core.js';

/**
 * Minimal JournalEntry creation payload. Matches the `journalEntries.create()`
 * input. Host import code populates this from external formats; ledger's
 * own builders (e.g. `buildOpeningBalanceEntry`) also produce this shape.
 */
export interface JournalEntryInput {
  journalType?: string;
  journal?: unknown;
  referenceNumber?: string;
  label?: string;
  date: Date;
  journalItems: JournalItemInput[];
  /** Extra fields injected into the entry doc (dimension fields, tags, etc.). */
  extra?: Record<string, unknown>;
}

export interface JournalItemInput {
  account: unknown;
  debit: Cents;
  credit: Cents;
  label?: string;
  currency?: string;
  exchangeRate?: number;
  originalDebit?: Cents;
  originalCredit?: Cents;
  matchingNumber?: string;
  maturityDate?: Date;
}
