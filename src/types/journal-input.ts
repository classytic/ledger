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

import type { SourceRef } from '../bridges/source.bridge.js';
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
  /**
   * Entry-level source back-reference (0.13.0+). Set at create time to stamp
   * "what produced this whole JE". Most ingestion paths set this *after*
   * insert via `repo.updateMany({ _importRunId }, { $set: { sourceRef } })`
   * (because the source doc id is known only after the batch lands), but
   * single-shot creators can pass it inline here. Drill-down: query
   * `find({ 'sourceRef.sourceId': id })` — add `ENTRY_SOURCE_INDEX` to
   * `schemaOptions.journalEntry.extraIndexes` for the index.
   */
  sourceRef?: SourceRef;
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
  /** "The document this line settles" — primary per-line back-reference. */
  sourceRef?: SourceRef;
  /** Additional docs this line touches (QBO `LinkedTxn[]` shape). */
  linkedRefs?: SourceRef[];
  /** Free-form per-line provenance (cost-center, project code, etc). */
  meta?: Record<string, unknown> | null;
}
