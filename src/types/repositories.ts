/**
 * Typed Repository Interfaces
 *
 * Each interface extends mongokit's `Repository<TDoc>` directly, so consumers
 * get full CRUD autocomplete (create, getById, getAll, update, delete, withTransaction, etc.)
 * plus the domain methods wired by the accounting engine.
 *
 * TDoc defaults to `unknown` — pass your document interface for full type safety:
 *
 * @example
 * ```ts
 * import type { JournalEntryRepository } from '@classytic/ledger';
 *
 * const repo = accounting.wireJournalEntryRepository(baseRepo, JournalEntryModel);
 * // repo is JournalEntryRepository<IJournalEntry>
 * repo.post(id, orgId)       // ← domain method, typed
 * repo.create(data)          // ← from Repository<IJournalEntry>, fully typed
 * repo.getById(id)           // ← returns IJournalEntry | null
 * ```
 */

import type { Repository } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';

// ── Shared Options ────────────────────────────────────────────────────────

export interface PostOptions {
  session?: ClientSession | null;
  /** Actor performing this operation (required when strictness.requireActor is enabled) */
  actorId?: unknown;
}

export interface ReverseOptions extends PostOptions {
  /** Date for the reversal entry (defaults to now) */
  reversalDate?: Date;
  /**
   * Post the reversal immediately after creating it. Defaults to `false` —
   * matches ERPNext (`make_reverse_journal_entry` returns Draft) and Odoo
   * (`_reverse_moves` creates Draft unless `cancel=True`). Pass `true` for
   * Odoo's `cancel=True` semantic — cancellation reversals that should
   * skip the review step.
   */
  autoPost?: boolean;
}

export interface SeedOptions {
  session?: ClientSession | null;
}

export interface SeedResult {
  created: number;
  skipped: number;
}

export interface BulkCreateInput {
  accountTypeCode?: string;
  accountNumber?: string;
  name?: string;
  active?: boolean;
  isCashAccount?: boolean;
}

/**
 * Generic over the account document type so consumers get real
 * IntelliSense on `created[0].accountNumber` instead of `unknown`.
 * Defaults to `Record<string, unknown>` for backwards-compatible call sites.
 */
export interface BulkCreateResult<TAccount = Record<string, unknown>> {
  summary: { total: number; created: number; skipped: number; errors: number };
  created: TAccount[];
  skipped: TAccount[];
  errors: TAccount[];
}

/**
 * Generic over the journal-entry document type — `{ original, reversal }`
 * are the actual persisted shapes, so callers can access `._id`, `.state`,
 * `.reversed`, etc. without casts.
 */
export interface ReverseResult<TEntry = Record<string, unknown>> {
  original: TEntry;
  reversal: TEntry;
}

export interface ReconcileParams {
  accountId: unknown;
  journalEntryIds: unknown[];
  organizationId?: unknown;
  note?: string;
  session?: ClientSession;
}

// ── Journal Entry Repository ──────────────────────────────────────────────

/**
 * Journal Entry Repository — extends mongokit Repository with accounting domain methods.
 *
 * Inherits ALL Repository<TDoc> methods: create, getById, getAll, update,
 * delete, count, exists, distinct, aggregate, withTransaction, etc.
 */
export interface JournalEntryRepository<TDoc = Record<string, unknown>> extends Repository<TDoc> {
  /** Post an entry (draft → posted). Validates items, balance, and accounts. */
  post(id: unknown, orgId?: unknown, options?: PostOptions): Promise<TDoc>;
  /** Unpost an entry (posted → draft). Resets state for re-editing. */
  unpost(id: unknown, orgId?: unknown, options?: PostOptions): Promise<TDoc>;
  /** Archive a draft entry (draft → archived). Preserves audit trail. */
  archive(id: unknown, orgId?: unknown, options?: PostOptions): Promise<TDoc>;
  /** Duplicate an entry as a new draft. Copies items, type, and label. */
  duplicate(id: unknown, orgId?: unknown, options?: PostOptions): Promise<TDoc>;
  /** Reverse a posted entry. Creates mirror entry with flipped debits/credits. */
  reverse(id: unknown, orgId?: unknown, options?: ReverseOptions): Promise<ReverseResult<TDoc>>;
}

// ── Account Repository ────────────────────────────────────────────────────

/**
 * Account Repository — extends mongokit Repository with seed and bulk operations.
 */
export interface AccountRepository<TDoc = Record<string, unknown>> extends Repository<TDoc> {
  /** Seed standard posting accounts for an org from the country pack. */
  seedAccounts(orgId: unknown, options?: SeedOptions): Promise<SeedResult>;
  /** Bulk create accounts with validation and skip-if-exists logic. */
  bulkCreate(accounts: BulkCreateInput[], orgId: unknown): Promise<BulkCreateResult<TDoc>>;
}

// ── Reconciliation Repository (0.6.0 — item-level matching) ─────────────

/**
 * Reference to a specific item inside a journal entry. Positional index
 * because journal items are embedded sub-documents.
 */
export interface JournalItemRef {
  /** Journal entry id. */
  entry: unknown;
  /** Zero-based index into the entry's `journalItems` array. */
  itemIndex: number;
}

export interface MatchInput {
  /** The account whose items are being matched (sanity checked). */
  account: unknown;
  /** Two or more items to match. Must share `account`. */
  items: JournalItemRef[];
  /**
   * Optional caller-provided matching number. When omitted, the repository
   * generates one via its counter. Must be unique per org.
   */
  matchingNumber?: string;
  note?: string;
  reconciledBy?: string;
  organizationId?: unknown;
  session?: ClientSession | null;
}

export interface OpenItem {
  entry: unknown;
  itemIndex: number;
  debit: number;
  credit: number;
  date?: Date;
  account: unknown;
  [key: string]: unknown;
}

export interface ReconciliationRepository<TDoc = Record<string, unknown>> extends Repository<TDoc> {
  /**
   * Match two or more journal items against each other. Stamps a
   * shared `matchingNumber` onto every referenced item and creates a
   * reconciliation document. When debit/credit totals balance, the
   * reconciliation is flagged `isFullReconcile: true`.
   *
   * Fires `after:match` hook — the fxRealizationPlugin listens here.
   */
  match(input: MatchInput): Promise<TDoc>;

  /**
   * Unwind a matching group. Clears `matchingNumber` on every referenced
   * item and deletes the reconciliation document. The FX realization
   * entry (if any) is reversed via `journalEntries.reverse`.
   */
  unmatch(input: {
    matchingNumber: string;
    organizationId?: unknown;
    session?: ClientSession | null;
  }): Promise<{ success: boolean }>;

  /**
   * Find all posted journal items referencing the given account that
   * do NOT yet have a matching number. Returns lean items with
   * `{ entry, itemIndex, debit, credit, date }` plus any extra fields
   * (dimension, maturityDate, currency).
   *
   * `filter` lets you narrow further by any journal-item field —
   * commonly used to scope by `partnerId` for supplier/customer
   * subsidiary ledger queries:
   *
   *   `getOpenItems({ accountId: apControlId, filter: { partnerId: 'sup-1' } })`
   *
   * `asOfDate` restricts to items posted on or before that date,
   * giving historical open-item snapshots — useful for aged-balance
   * reports run as of a previous month-end.
   */
  getOpenItems(params: {
    accountId: unknown;
    organizationId?: unknown;
    /** Extra equality filters on the journal item (e.g. `{ partnerId: 'X' }`). */
    filter?: Record<string, unknown>;
    /** Only consider items from entries dated on or before this date. */
    asOfDate?: Date;
    limit?: number;
    skip?: number;
  }): Promise<OpenItem[]>;
}

// ── Journal Repository (0.6.0) ────────────────────────────────────────────

export interface JournalRepository<TDoc = Record<string, unknown>> extends Repository<TDoc> {
  /**
   * Seed the organization's default journals from the country pack's
   * `journalTemplates`. Idempotent — skips journals that already exist.
   */
  seedDefaults(orgId: unknown): Promise<SeedResult>;

  /**
   * Atomically increment the journal's sequence counter and return a
   * formatted reference number (e.g. `'INV/2026/03/0042'`). Safe under
   * concurrent posts — uses `$inc` inside `findOneAndUpdate`.
   */
  nextSequenceNumber(journalId: unknown, orgId?: unknown): Promise<string>;
}
