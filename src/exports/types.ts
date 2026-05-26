/**
 * Export Types — Field maps, flat rows, and CSV builder configuration.
 *
 * All monetary values are in integer minor units (cents). For example,
 * 10050 represents $100.50. Field maps convert to dollar strings at CSV output.
 *
 * @module @classytic/ledger/exports
 */

import type { SourceRef } from '../bridges/source.bridge.js';

// ── Input Types (what the app layer provides) ────────────────────────────────

/**
 * A populated account object (the shape after .populate('journalItems.account')).
 * Only the fields the export module reads. Extra fields are ignored.
 */
export interface PopulatedAccount {
  _id: unknown;
  accountTypeCode: string;
  name?: string;
  active?: boolean;
  isCashAccount?: boolean;
}

/**
 * A single journal item with its account populated to an object.
 */
export interface PopulatedJournalItem {
  account: PopulatedAccount | string;
  label?: string;
  date?: Date | string;
  debit: number;
  credit: number;
  taxDetails?: Array<{ taxCode?: string; taxName?: string }>;
  /** Per-line source back-ref (0.13.0). Null defaults when unstamped. */
  sourceRef?: SourceRef;
  /** Additional docs this line touches (QBO `LinkedTxn[]` shape). */
  linkedRefs?: SourceRef[];
  /** Free-form per-line provenance. */
  meta?: Record<string, unknown> | null;
  /** Extra dimension fields from extraItemFields */
  [key: string]: unknown;
}

/**
 * A journal entry as returned from the DB after populate.
 * The export module never queries the DB — it receives these plain objects.
 */
export interface PopulatedJournalEntry {
  _id?: unknown;
  journalType: string;
  referenceNumber: string;
  label?: string;
  date: Date | string;
  journalItems: PopulatedJournalItem[];
  totalDebit: number;
  totalCredit: number;
  state: 'draft' | 'posted' | 'archived';
  reversed?: boolean;
  /** Entry-level source back-ref (0.13.0). Null defaults when unstamped. */
  sourceRef?: SourceRef;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  [key: string]: unknown;
}

// ── Flattened Row ────────────────────────────────────────────────────────────

/**
 * One flat row = one journal item with entry-level fields repeated.
 * All monetary values are in integer minor units (cents).
 */
export interface FlatJournalRow {
  entryId: string;
  journalType: string;
  referenceNumber: string;
  entryLabel: string;
  entryDate: Date;
  state: 'draft' | 'posted' | 'archived';
  reversed: boolean;
  totalDebit: number;
  totalCredit: number;

  accountId: string;
  accountName: string;
  accountTypeCode: string;
  itemLabel: string;
  itemDate: Date;
  debit: number;
  credit: number;
  taxCode: string;
  taxName: string;

  itemIndex: number;
  itemCount: number;

  /** Extra dimension fields carried from journal items */
  [key: string]: unknown;
}

// ── Field Map ────────────────────────────────────────────────────────────────

/**
 * A single export field definition.
 * The extract function returns a string value for the CSV column.
 */
export interface ExportField<TRow = FlatJournalRow> {
  readonly header: string;
  readonly extract: (row: TRow) => string;
}

/**
 * A named, reusable collection of export fields.
 */
export interface ExportFieldMap<TRow = FlatJournalRow> {
  readonly name: string;
  readonly target: string;
  readonly fields: readonly ExportField<TRow>[];
}

// ── CSV Options ──────────────────────────────────────────────────────────────

export interface CsvOptions {
  delimiter?: string;
  lineTerminator?: string;
  includeHeaders?: boolean;
}
