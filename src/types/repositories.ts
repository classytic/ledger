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

import type { ClientSession } from 'mongoose';
import type { Repository } from '@classytic/mongokit';

// ── Shared Options ────────────────────────────────────────────────────────

export interface PostOptions {
  session?: ClientSession | null;
  /** Actor performing this operation (required when strictness.requireActor is enabled) */
  actorId?: unknown;
}

export interface ReverseOptions extends PostOptions {
  /** Date for the reversal entry (defaults to now) */
  reversalDate?: Date;
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

export interface BulkCreateResult {
  summary: { total: number; created: number; skipped: number; errors: number };
  created: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
}

export interface ReverseResult {
  original: Record<string, unknown>;
  reversal: Record<string, unknown>;
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
export interface JournalEntryRepository<TDoc = unknown> extends Repository<TDoc> {
  /** Post an entry (draft → posted). Validates items, balance, and accounts. */
  post(id: unknown, orgId?: unknown, options?: PostOptions): Promise<Record<string, unknown>>;
  /** Unpost an entry (posted → draft). Resets state for re-editing. */
  unpost(id: unknown, orgId?: unknown, options?: PostOptions): Promise<Record<string, unknown>>;
  /** Archive a draft entry (draft → archived). Preserves audit trail. */
  archive(id: unknown, orgId?: unknown, options?: PostOptions): Promise<Record<string, unknown>>;
  /** Duplicate an entry as a new draft. Copies items, type, and label. */
  duplicate(id: unknown, orgId?: unknown, options?: PostOptions): Promise<Record<string, unknown>>;
  /** Reverse a posted entry. Creates mirror entry with flipped debits/credits. */
  reverse(id: unknown, orgId?: unknown, options?: ReverseOptions): Promise<ReverseResult>;
}

// ── Account Repository ────────────────────────────────────────────────────

/**
 * Account Repository — extends mongokit Repository with seed and bulk operations.
 */
export interface AccountRepository<TDoc = unknown> extends Repository<TDoc> {
  /** Seed standard posting accounts for an org from the country pack. */
  seedAccounts(orgId: unknown, options?: SeedOptions): Promise<SeedResult>;
  /** Bulk create accounts with validation and skip-if-exists logic. */
  bulkCreate(accounts: BulkCreateInput[], orgId: unknown): Promise<BulkCreateResult>;
}

// ── Reconciliation Repository ─────────────────────────────────────────────

/**
 * Reconciliation Repository — extends mongokit Repository with bank reconciliation methods.
 */
export interface ReconciliationRepository<TDoc = unknown> extends Repository<TDoc> {
  /** Reconcile journal entries for a specific account. */
  reconcile(params: ReconcileParams): Promise<Record<string, unknown>>;
  /** Remove a reconciliation record. */
  unreconcile(params: { reconciliationId: unknown; organizationId?: unknown }): Promise<{ success: boolean }>;
  /** Get unreconciled journal entries for an account. */
  getUnreconciled(params: { accountId: unknown; organizationId?: unknown }): Promise<Record<string, unknown>[]>;
}
