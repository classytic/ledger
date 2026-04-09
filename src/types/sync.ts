/**
 * Import / Export types for `@classytic/ledger/sync`.
 *
 * These are the contracts that fin-io's canonical shapes flow through to
 * become real JournalEntry documents in the ledger. The types are pure —
 * zero runtime cost, zero fin-io dependency in the type file itself. The
 * fin-io dependency is only at the mapper layer (which imports
 * CanonicalTransaction etc. as type-only imports).
 *
 * Consumer flow:
 *
 *   import { parseOfx } from '@classytic/fin-io/ofx';
 *   import { wireImport, ofxBankMapper } from '@classytic/ledger/sync';
 *
 *   const parsed = parseOfx(buffer);
 *   if (!parsed.ok) throw ...;
 *   const importer = wireImport({
 *     source: parsed.data.flatMap(s => s.transactions),
 *     mapper: ofxBankMapper({ bankAccountCode: '1010', counterAccountCode: '5900' }),
 *     journalEntries,
 *     context: { organizationId },
 *   });
 *   const report = await importer.run();
 */

import type { Cents } from './core';

/**
 * Maps a raw record (from any source) into a JournalEntry creation payload.
 * The consumer passes this to wireImport. Reference implementations ship
 * for every fin-io canonical shape: ofxBankMapper, camtBankMapper, etc.
 */
export interface ImportMapper<TRaw> {
  /**
   * Transform one raw record into zero, one, or many JournalEntry inputs.
   * Return null to skip a record (e.g. opening-balance entries).
   */
  toJournalEntry(raw: TRaw, ctx: ImportContext): JournalEntryInput | JournalEntryInput[] | null;

  /**
   * Stable, source-assigned unique ID for the raw record. Used for
   * idempotent re-imports — wireImport checks for an existing entry
   * with this idempotencyKey before creating.
   */
  externalId(raw: TRaw): string;
}

export interface ImportContext {
  organizationId: unknown;
  /** When the import job started, for audit. */
  importedAt: Date;
  /** Optional run-scoped tag (e.g. 'monthly-bank-import-2026-04'). */
  importRunId?: string;
}

/**
 * Minimal JournalEntry creation payload. This is what the mapper produces
 * and wireImport passes to `journalEntries.create()`. The shape matches
 * the AccountingEngine's expected create input.
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

/**
 * Result of an import run. Always returned — never thrown. Errors on
 * individual records do NOT abort the run unless `strict: true`.
 */
export interface ImportReport {
  ok: boolean;
  inserted: number;
  skipped: number;
  failed: number;
  errors: ImportError[];
  durationMs: number;
}

export interface ImportError {
  externalId?: string;
  message: string;
  cause?: unknown;
}

/**
 * Maps a JournalEntry into an external format record. Used by wireExport.
 */
export interface ExportSink<TOut> {
  fromJournalEntry(entry: unknown): TOut;
  emit(records: TOut[]): Promise<void>;
  flush?(): Promise<void>;
}

export interface ExportReport {
  ok: boolean;
  emitted: number;
  errors: Array<{ entryId?: string; message: string }>;
  durationMs: number;
}

export interface WireImportArgs<TRaw> {
  /** The raw records to import. */
  source: Iterable<TRaw> | AsyncIterable<TRaw>;
  /** Maps raw → JournalEntry input. */
  mapper: ImportMapper<TRaw>;
  /** The ledger's JournalEntry repository (from createRepositories()). */
  journalEntries: {
    create(data: Record<string, unknown>): Promise<unknown>;
    /**
     * Bulk create journal entries. When provided, wireImport uses this for
     * batch inserts instead of per-record create() — dramatically faster
     * for large imports (single round-trip per batch instead of N).
     *
     * Falls back to sequential create() if not provided.
     */
    createMany?(data: Record<string, unknown>[]): Promise<unknown[]>;
    getAll(query: Record<string, unknown>): Promise<unknown[]>;
  };
  /** Organizational context. */
  context: Pick<ImportContext, 'organizationId' | 'importRunId'>;
  /**
   * Optional callback that checks whether entries with the given
   * referenceNumbers already exist. Returns the set of existing ones.
   * If not provided, wireImport skips the pre-check and relies on
   * create() errors (or the idempotency plugin) for dedup.
   *
   * Example using Mongoose Model directly:
   *   findExisting: async (refNums, orgId) => {
   *     const docs = await JournalEntry.find({
   *       organizationId: orgId,
   *       referenceNumber: { $in: refNums },
   *     }).select('referenceNumber').lean();
   *     return new Set(docs.map(d => d.referenceNumber));
   *   }
   */
  findExisting?: (referenceNumbers: string[], organizationId: unknown) => Promise<Set<string>>;
  options?: {
    /** First error aborts the run. Default: false. */
    strict?: boolean;
    /** Entries per batch. Default: 100. */
    batchSize?: number;
    /** Dry-run: do everything except persist. Default: false. */
    dryRun?: boolean;
    /** Progress callback. */
    onProgress?: (p: { processed: number; total?: number }) => void;
    /** Journal type for imported entries. Default: 'GENERAL'. */
    journalType?: string;
  };
}

export interface WireExportArgs<TOut> {
  /** Query to select entries for export. */
  query: Record<string, unknown>;
  sink: ExportSink<TOut>;
  journalEntries: {
    getAll(query: Record<string, unknown>): Promise<unknown[]>;
  };
  options?: {
    batchSize?: number;
    onProgress?: (p: { emitted: number }) => void;
  };
}
