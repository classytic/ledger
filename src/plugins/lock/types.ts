/**
 * Lock Plugin — shared types.
 *
 * A "lock" expresses the fact that *some authority* has already consumed
 * a slice of the ledger and promises not to see retroactive changes:
 *
 *   - fiscal close  → board / auditors   (annual)
 *   - tax filing    → NBR / CRA / IRS    (monthly / quarterly)
 *   - daily close   → branch operations   (daily POS watermark)
 *   - bank recon    → bank statement      (per statement window)
 *   - payroll run   → payroll provider    (per run)
 *
 * Every lock is built from the same three primitives:
 *
 *   1. A **scope** string that labels the authority (`'fiscal'`, `'tax'`, …)
 *   2. A **resolver** that, given a journal-entry context, returns a
 *      `LockHit` if the entry falls inside a closed window, or `null`
 *      if the window is open.
 *   3. An optional **account selector** that narrows the check to only
 *      entries that touch specific accounts (e.g. `taxMetadata != null`
 *      for tax locks). Without a selector, the check applies to all entries.
 *
 * The `createLockPlugin` factory handles all the shared pipeline plumbing:
 * reading the entry date, resolving the org scope on partial updates,
 * fetching the persisted journal-entry doc when fields are missing, and
 * skipping legitimate internal transitions flagged by `_ledgerInternal`.
 */

import type { RepositoryContext } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';

/**
 * The resolved "who did what, when" for a locked slice of ledger.
 * Returned by a `LockResolver` to describe why an entry is blocked.
 */
export interface LockHit {
  /** Scope that this hit belongs to — e.g. `'fiscal'`, `'tax'`. */
  readonly scope: string;
  /** Human-readable label used in error messages (e.g. `'Q1 2025'`). */
  readonly label: string;
  /** Optional sub-type inside the scope (e.g. `'VAT'`, `'TDS'`, `'GST'`). */
  readonly subType?: string;
  /** Optional external reference (filed return number, statement ID, …). */
  readonly externalRef?: string;
}

/**
 * Context given to a lock resolver. All fields except `entryDate` are
 * pass-throughs from the `createLockPlugin` boilerplate — resolvers don't
 * need to worry about where the date came from (payload vs persisted doc).
 */
export interface LockResolverContext {
  /** The effective date the entry will be posted on. */
  readonly entryDate: Date;
  /** The resolved multi-tenant scope value, or `undefined` if unscoped. */
  readonly orgValue: unknown;
  /** The mongoose session if the operation is running inside a transaction. */
  readonly session: ClientSession | null;
  /** The raw entry payload (for resolvers that need extra context). */
  readonly data: Record<string, unknown>;
  /** The full upstream repository context (advanced use). */
  readonly repositoryContext: RepositoryContext;
}

/**
 * Resolver signature. Return `null` if the entry is allowed, or a
 * `LockHit` to block it with a 409 `PERIOD_LOCKED_{SCOPE}` error.
 */
export type LockResolver = (ctx: LockResolverContext) => Promise<LockHit | null>;

/**
 * Predicate used to narrow a lock to specific accounts. Called per
 * journal item; if *any* item's account matches, the entry is subject
 * to the lock. Receives the populated account document (lean).
 */
export type LockAccountSelector = (account: Record<string, unknown>) => boolean;

/**
 * Options accepted by `createLockPlugin`. All fields are type-safe —
 * the factory handles date/org resolution, session propagation, and
 * the `_ledgerInternal` skip path automatically.
 */
export interface CreateLockPluginOptions {
  /**
   * Scope identifier — short, lowercase, stable. Used in the plugin name
   * (`accounting:lock:{scope}`) and the error code
   * (`PERIOD_LOCKED_{SCOPE}`).
   */
  scope: string;

  /**
   * Resolver that decides whether a given entry is locked. Call one of
   * the builtin resolvers (`periodResolver`, `watermarkResolver`) or
   * implement your own.
   */
  resolve: LockResolver;

  /**
   * Optional account-level narrowing. When provided, the lock only
   * fires if at least one of the entry's journal items touches an
   * account that matches the predicate.
   *
   * When this is set, the plugin must be able to load account docs, so
   * `AccountModel` becomes required.
   */
  accountSelector?: LockAccountSelector;

  /** Required when `accountSelector` is set — used to hydrate accounts. */
  AccountModel?: Model<unknown>;

  /**
   * Journal-entry model — required for partial updates (we need to look
   * up the persisted `date` and `orgField` when the payload omits them).
   */
  JournalEntryModel?: Model<unknown>;

  /** Multi-tenant scope field name (e.g. `'organizationId'`). */
  orgField?: string;
}
