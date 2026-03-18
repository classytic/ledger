/**
 * Posting Contracts — Typed interfaces for subledger integration.
 *
 * These types define the shape that subledger packages (inventory, payroll,
 * billing, etc.) should implement to integrate with the ledger's posting
 * pipeline. They are **type-only** — no runtime code.
 *
 * @example
 * ```typescript
 * import type { PostingContract, SubledgerPostingInput } from '@classytic/ledger';
 *
 * const billingContract: PostingContract<Invoice> = {
 *   name: 'billing',
 *   toJournalEntries(invoice) { ... },
 *   validate(invoice) { ... },
 * };
 * ```
 */

import type { ObjectId } from './core.js';

// ─── Subledger Journal Item ─────────────────────────────────────────────────

/** A single line produced by a subledger for posting */
export interface SubledgerJournalItem {
  /** Account type code (resolved to ObjectId by the app layer) */
  accountCode: string;
  /** Integer cents */
  debit: number;
  /** Integer cents */
  credit: number;
  /** Line-item description */
  label?: string;
  /** Extra dimension fields (departmentId, projectId, etc.) */
  extraFields?: Record<string, unknown>;
}

// ─── Subledger Posting Input ─────────────────────────────────────────────────

/** The shape of a journal entry that a subledger produces */
export interface SubledgerPostingInput {
  journalType: string;
  label: string;
  date: Date;
  journalItems: SubledgerJournalItem[];
  /** Prevents duplicate postings on retry */
  idempotencyKey?: string;
  /** Arbitrary metadata for the entry (stored via extraFields) */
  metadata?: Record<string, unknown>;
}

// ─── Posting Contract ────────────────────────────────────────────────────────

/**
 * Contract that subledger posting adapters must implement.
 *
 * @typeParam TSource - The source document type (e.g., Invoice, Bill, PayrollRun)
 */
export interface PostingContract<TSource = unknown> {
  /** Unique name for this subledger (e.g. 'billing', 'inventory', 'payroll') */
  readonly name: string;
  /** Convert a source document into one or more journal entry inputs */
  toJournalEntries(source: TSource): SubledgerPostingInput[];
  /** Validate that the source document is ready to post. Throws on failure. */
  validate(source: TSource): void;
}

// ─── Posting Result ──────────────────────────────────────────────────────────

/** Result of a subledger posting operation */
export interface PostingResult {
  journalEntryIds: (string | ObjectId)[];
  idempotencyKeys?: string[];
}
