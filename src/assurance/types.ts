/**
 * Ledger assurance — continuous integrity checks over the posted book.
 *
 * Tests prove the posting RULES match intent (golden drafts, parity suites).
 * Assurance proves the BOOK matches the rules — it re-derives the invariants
 * from raw journal items and reports drift, catching everything the schema
 * guards can't see: direct `updateOne`/`bulkWrite` writes, migrations,
 * restored backups, and denormalized-total rot.
 *
 * All amounts are integer minor units (Cents). All checks are read-only
 * aggregations — assurance NEVER mutates the book.
 */

import type { Model } from 'mongoose';

export type AssuranceSeverity = 'error' | 'warn';

export interface AssuranceCheckResult {
  /** Stable check id, e.g. 'entry-balance'. */
  check: string;
  severity: AssuranceSeverity;
  /** True when the invariant holds (affected === 0). */
  ok: boolean;
  /** One-line human summary of what was checked / what drifted. */
  summary: string;
  /** Number of violating documents/groups (0 when ok). */
  affected: number;
  /**
   * Net drift in minor units where the check has a scalar notion of drift
   * (trial-balance imbalance, control-account gap). Absent otherwise.
   */
  driftMinor?: number | undefined;
  /** Capped sample of violations for drill-down (first `sampleLimit`). */
  sample: unknown[];
}

export interface AssuranceReport {
  organizationId?: unknown;
  /** Date ceiling applied to entry matching (when provided). */
  until?: Date | undefined;
  /** False when any error-severity check failed. Warns don't flip it. */
  ok: boolean;
  results: AssuranceCheckResult[];
}

/**
 * Host-declared expectation for a control account tie-out: the GL balance
 * (Σdebit − Σcredit over posted items, i.e. debit-positive convention) of
 * every account with `accountTypeCode` must equal the subledger's own total
 * (e.g. Σ open A/R items for the receivable control account).
 */
export interface ControlAccountExpectation {
  /** Primary chart code — the display key for the tie-out row. */
  accountTypeCode: string;
  /**
   * Optional GROUP of chart codes whose GL balances are summed before the
   * comparison. Use when one subledger total spans several accounts — e.g.
   * inventory valuation covers on-hand AND in-transit stock (a transfer
   * moves value between the two without changing the subledger total).
   * When present it fully replaces `accountTypeCode` for matching.
   */
  accountTypeCodes?: string[] | undefined;
  /** Expected balance as debit − credit, integer minor units. */
  expectedMinor: number;
  /** Display label for the report ('A/R control vs open invoices'). */
  label?: string | undefined;
}

export interface LedgerAssuranceOptions {
  JournalEntryModel: Model<unknown>;
  AccountModel: Model<unknown>;
  /** Tenant field on journal entries (engine's `multiTenant.tenantField`). */
  orgField?: string | undefined;
  /** Max violations embedded per check result (default 20). */
  sampleLimit?: number | undefined;
}

export interface LedgerAssuranceParams {
  /** Scope to one branch; omit for the whole book. */
  organizationId?: unknown;
  /** Only consider entries dated <= until (reproducible as-of runs). */
  until?: Date | undefined;
  /**
   * Control-account tie-outs. The host resolves subledger totals (open A/R,
   * open A/P, unremitted VAT vs filings) and passes expectations; assurance
   * computes the GL side and reports the gap.
   */
  controlAccounts?: ControlAccountExpectation[] | undefined;
  /**
   * Flag drafts older than this many days (severity 'warn'). Requires `now`.
   * Omit to skip the check.
   */
  staleDraftDays?: number | undefined;
  /** Injected clock for the stale-draft check (keeps runs reproducible). */
  now?: Date | undefined;
}
