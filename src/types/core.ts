/**
 * Core Types — Foundation for @classytic/ledger
 *
 * **Storage contract:** All monetary `number` fields (`debit`, `credit`,
 * `totalDebit`, `totalCredit`, report balances/totals) are stored and
 * returned as **integer minor units (cents)**. For example, 10050 represents
 * $100.50.
 *
 * Use `Money.fromDecimal()` to convert user-facing dollar inputs to cents
 * at the HTTP/API boundary. Use `Money.toDecimal()` or `Money.formatPlain()`
 * to convert cents back to dollars for display or CSV export.
 */

import type { ClientSession, Types } from 'mongoose';

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Integer cents — the canonical monetary type throughout the engine */
export type Cents = number & { readonly __brand: 'Cents' };

/** Mongoose ObjectId */
export type ObjectId = Types.ObjectId;

/** Sort direction for queries */
export type SortDirection = 1 | -1;

/** Sort specification */
export type SortSpec = Record<string, SortDirection>;

// ─── Financial Categories ────────────────────────────────────────────────────

/** Statement type — which financial statement an account belongs to */
export type StatementType = 'Balance Sheet' | 'Income Statement';

/** Main account type — the fundamental classification */
export type MainType = 'Asset' | 'Liability' | 'Equity' | 'Income' | 'Expense';

/**
 * Category key — composite key used throughout the engine.
 * Format: "{StatementType}-{MainType}"
 */
export type CategoryKey =
  | 'Balance Sheet-Asset'
  | 'Balance Sheet-Liability'
  | 'Balance Sheet-Equity'
  | 'Income Statement-Income'
  | 'Income Statement-Expense';

/** Category definition */
export interface Category {
  readonly name: StatementType;
  readonly mainType: MainType;
  readonly statementType: StatementType;
}

/** Normal balance — which side increases this account type */
export type NormalBalance = 'debit' | 'credit';

/** Cash flow classification */
export type CashFlowCategory = 'Operating' | 'Investing' | 'Financing';

/**
 * Non-cash adjustment tag — flags an Income-Statement account whose
 * movement should be added back to Net Income in the Operating section
 * of the Cash Flow Statement (Indirect Method, IAS 7 / ASC 230).
 *
 * Without this tag, an Income/Expense account is fully subsumed in Net
 * Income; the CFS does not list it separately.
 *
 * Adopted from Odoo Enterprise's CF-IM tag taxonomy (PR #35522). Generic
 * — country packs add new tags by string. The CFS algorithm groups all
 * accounts sharing a tag onto a single labelled adjustment line.
 */
export type NonCashAdjustmentTag =
  | 'depreciation'
  | 'amortization'
  | 'impairment'
  | 'gain_on_disposal'
  | 'loss_on_disposal'
  | 'unrealized_fx'
  | 'stock_based_compensation'
  | (string & {}); // escape hatch for country-specific tags

// ─── Account Types ───────────────────────────────────────────────────────────

/** Roll-up operation for total accounts */
export interface TotalAccountOp {
  readonly account: string;
  readonly operation: '+' | '-';
}

/** Tax metadata embedded in tax account type definitions */
export interface TaxMetadata {
  readonly taxType: string;
  readonly rate?: number;
  readonly direction: 'collected' | 'recoverable' | 'instalment' | 'payable' | 'receivable';
  readonly craLine?: number | null;
  readonly provinces?: readonly string[];
  readonly isContraAccount?: boolean;
}

/**
 * AccountType — a template/definition for an account (NOT a database row).
 * Provided by country packs.
 */
export interface AccountType {
  readonly code: string;
  readonly name: string;
  readonly category: CategoryKey;
  readonly description: string;
  readonly parentCode: string | null;
  readonly isTotal?: boolean;
  readonly isVirtualTotal?: boolean;
  readonly isGroup?: boolean;
  readonly totalAccountTypes?: readonly TotalAccountOp[];
  readonly cashFlowCategory?: CashFlowCategory | null;
  /**
   * Non-cash adjustment tag for Cash Flow Statement (Indirect Method).
   * Set ONLY on Income-Statement accounts whose movement should be added
   * back to Net Income in the Operating section. Tagging a Balance-Sheet
   * account with this is a country-pack bug — the algorithm ignores it
   * there because B/S movements already feed the working-capital path.
   *
   * Common values: 'depreciation', 'amortization', 'impairment',
   * 'gain_on_disposal' (negative), 'loss_on_disposal' (positive). See
   * NonCashAdjustmentTag type for the canonical set.
   */
  readonly nonCashAdjustmentTag?: NonCashAdjustmentTag | null;
  /**
   * Marks this AccountType as a cash/bank account (GIFI 1000-family in
   * CA, equivalent in other charts). Set on the country-pack template
   * so that `bulkCreate` propagates it to every Account instance seeded
   * from this code without each caller needing to know the rule.
   *
   * Downstream consumers — Cash Flow Statement (Indirect/Direct method),
   * Bank Reconciliation, the JE-detail "Bank & Cash movement" panel —
   * key off `Account.isCashAccount` to decide what flows through cash.
   * Putting the source-of-truth here keeps the country pack as the
   * single owner of "what is cash in this jurisdiction's chart".
   */
  readonly isCashAccount?: boolean;
  readonly taxMetadata?: TaxMetadata;
  readonly deprecated?: boolean;
  readonly replacedBy?: string;
  readonly notes?: string;
}

// ─── Journal Types ───────────────────────────────────────────────────────────

/** Journal type definition */
export interface JournalType {
  readonly code: string;
  readonly name: string;
  readonly description: string;
}

/** Entry state machine: draft → posted, draft → archived */
export type EntryState = 'draft' | 'posted' | 'archived';

/** Tax detail on a journal item (audit reference only) */
export interface TaxDetail {
  taxCode?: string;
  taxName?: string;
}

/**
 * A single line in a journal entry.
 * Additional dimension fields can be injected via `extraItemFields` in JournalSchemaOptions.
 */
export interface JournalItem {
  account: ObjectId | string;
  label?: string;
  date?: Date;
  debit: number; // Integer cents (e.g. 10050 = $100.50)
  credit: number; // Integer cents (e.g. 10050 = $100.50)
  taxDetails?: TaxDetail[];
  /** Extra dimension fields injected via extraItemFields */
  [key: string]: unknown;
}

// ─── Currency ────────────────────────────────────────────────────────────────

/** ISO 4217 currency definition */
export interface Currency {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly minorUnit: number; // decimal places (2 for CAD/USD, 0 for JPY)
}

// ─── Date Range ──────────────────────────────────────────────────────────────

export type DateOption = 'month' | 'quarter' | 'year' | 'custom';

export interface QuarterValue {
  quarter: 1 | 2 | 3 | 4;
  year: number;
}

export interface CustomDateRange {
  startDate: Date;
  endDate: Date;
}

export type DateValue = string | number | Date | QuarterValue | CustomDateRange;

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

// ─── Operation Context ───────────────────────────────────────────────────────

/** Shared options for DB operations */
export interface OperationOptions {
  session?: ClientSession;
  /** ID of the user performing the operation (used when audit.trackActor is enabled) */
  actorId?: string | ObjectId;
}

/** Multi-tenant context passed to repositories */
export interface TenantContext {
  organizationId?: string | ObjectId;
}
