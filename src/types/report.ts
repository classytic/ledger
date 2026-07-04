/**
 * Report Types — Typed outputs for all financial reports.
 *
 * All monetary `number` fields (balance, total, debit, credit, amount, etc.)
 * are in **integer minor units (cents)**. For example, 10050 represents $100.50.
 * Use `Money.toDecimal()` or `Money.formatPlain()` to convert for display.
 */

import type { DateRange } from './core.js';

// ─── Shared ──────────────────────────────────────────────────────────────────

export interface ReportMetadata {
  businessName?: string | undefined;
  generatedAt: string;
}

export interface ReportAccount {
  id: unknown;
  name: string;
  code: string;
  balance: number;
  isTotal?: boolean | undefined;
  isVirtualTotal?: boolean | undefined;
  isCalculated?: boolean | undefined;
}

export interface ReportGroup {
  name: string;
  total: number;
  accounts: ReportAccount[];
}

export interface ReportCategory {
  name: string;
  total: number;
  groups: ReportGroup[];
}

export type ComparativeMode = 'monthly' | 'quarterly' | null;

export interface PeriodColumn {
  /** Stable column key (e.g. '2026-01', '2026-Q2', 'total', '31-60'). */
  key: string;
  /** Human label shown in the column header (e.g. 'Jan 2026', 'Q2 2026'). */
  label: string;
  /**
   * Column start boundary — ISO yyyy-mm-dd. Empty string for age buckets
   * (`isAgeBucket: true`), since aging buckets represent age windows
   * relative to `asOfDate`, not absolute date ranges.
   */
  startDate: string;
  /**
   * Column end boundary — ISO yyyy-mm-dd. Empty string for age buckets.
   * Consumers should drive UI rendering off `isAgeBucket` + `label`, not
   * `startDate`/`endDate`, when displaying aging columns.
   */
  endDate: string;
  /** True for aggregate columns appended after detail columns. */
  isTotal?: boolean | undefined;
  /** True when the column is an aging bucket rather than a date period. */
  isAgeBucket?: boolean | undefined;
}

export interface ReportLine<TSource = Record<string, unknown>> {
  label: string;
  code: string;
  amounts: Record<string, number>;
  source: TSource;
}

export interface ReportSection<TSource = Record<string, unknown>> {
  totals: Record<string, number>;
  lines: Array<ReportLine<TSource>>;
}

// ─── Trial Balance ───────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  account: unknown;
  initial: { debit: number; credit: number };
  current: { debit: number; credit: number };
  ending: { debit: number; credit: number };
}

export interface TrialBalanceColumnRow {
  account: unknown;
  initial: { debit: Record<string, number>; credit: Record<string, number> };
  current: { debit: Record<string, number>; credit: Record<string, number> };
  ending: { debit: Record<string, number>; credit: Record<string, number> };
}

export interface TrialBalanceReport {
  metadata?: ReportMetadata & {
    periodStart: string;
    periodEnd: string;
    displayPeriod: string;
    comparative?: ComparativeMode | undefined;
  };
  period: DateRange;
  periods: PeriodColumn[];
  columnarRows: TrialBalanceColumnRow[];
}

// ─── Balance Sheet ───────────────────────────────────────────────────────────

export interface BalanceSheetReport {
  metadata: ReportMetadata & {
    asOfDate: string;
    displayDate: string;
    comparative?: ComparativeMode | undefined;
    /**
     * Display labels sourced from the country pack's `reportLabels`. FE
     * renders section headers from these so the same engine output can
     * power "Stockholders' Equity" (US) or "Owners' Equity" (UK) without
     * a fork. Defaults: assets='Assets', liabilities='Liabilities', equity='Equity'.
     */
    labels?: {
      assets?: string | undefined;
      liabilities?: string | undefined;
      equity?: string | undefined;
    };
  };
  periods: PeriodColumn[];
  summaryByPeriod: {
    totalAssets: Record<string, number>;
    totalLiabilities: Record<string, number>;
    totalEquity: Record<string, number>;
    liabilitiesAndEquity: Record<string, number>;
    difference: Record<string, number>;
    isBalanced: Record<string, boolean>;
  };
  assetsSection: BalanceSheetSection;
  liabilitiesSection: BalanceSheetSection;
  equitySection: BalanceSheetSection;
}

export type BalanceSheetLineSource =
  | {
      kind: 'account';
      accountId: string;
      group: string;
      section: 'assets' | 'liabilities' | 'equity';
    }
  | { kind: 'calculated'; accountId: string; group: string; section: 'equity' };

export type BalanceSheetSection = ReportSection<BalanceSheetLineSource>;

// ─── Income Statement ────────────────────────────────────────────────────────

export interface IncomeStatementReport {
  metadata: ReportMetadata & {
    periodStart: string;
    periodEnd: string;
    displayPeriod: string;
    comparative?: ComparativeMode | undefined;
    /**
     * Display labels sourced from the country pack's `reportLabels`. Same
     * shape as `BalanceSheetReport.metadata.labels`; powers section
     * headers like "Net Revenue" (US) vs "Revenue" (default).
     */
    labels?: { revenue?: string | undefined; expenses?: string | undefined };
  };
  periods: PeriodColumn[];
  revenueSection: IncomeStatementSection;
  expensesSection: IncomeStatementSection;
  summarySection: IncomeStatementSection;
  costOfSalesByPeriod: Record<string, number>;
  grossProfitByPeriod: Record<string, number>;
  operatingIncomeByPeriod: Record<string, number>;
  netIncomeByPeriod: Record<string, number>;
}

export type IncomeStatementLineSource =
  | { kind: 'account'; accountId: string; group: string; statementType: 'revenue' | 'expense' }
  | { kind: 'aggregate'; name: 'costOfSales' | 'grossProfit' | 'operatingIncome' | 'netIncome' };

export type IncomeStatementSection = ReportSection<IncomeStatementLineSource>;

// ─── General Ledger ──────────────────────────────────────────────────────────

export interface LedgerEntry {
  /** Source journal-entry `_id` — lets the UI link a GL row to its JE. */
  journalEntryId: string;
  date: Date;
  referenceNumber: string;
  label: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface GeneralLedgerAccount {
  account: unknown;
  openingBalance: number;
  entries: LedgerEntry[];
  closingBalance: number;
}

export interface GeneralLedgerReport {
  metadata?: ReportMetadata & { periodStart: string | undefined; periodEnd: string; displayPeriod: string };
  accounts: GeneralLedgerAccount[];
  period: DateRange;
}

// ─── Cash Flow Statement ────────────────────────────────────────────────────
//
// Indirect Method (IAS 7 / ASC 230). Net Income at the top of Operating,
// then non-cash adjustments + ΔWorking Capital. Investing + Financing list
// direct movements on tagged Balance-Sheet accounts. FX cash effect is its
// own line so consumers always render the same layout. Per-line `source`
// discriminator drives drill-down on the UI.
//
// One envelope for both single- and multi-period reports: every monetary
// value is keyed by `period.key`. Single-period reports have one entry
// (key 'total'); comparative reports have N period columns + an optional
// 'total' YTD column. ERPNext (`period_list`) and QBO (`Columns`) both
// use this shape — consumers iterate columns generically without per-mode
// special cases.

/** Discriminator on each CashFlowLine — drives UI drill-down + section logic. */
export type CashFlowLineSource =
  | { kind: 'netIncome' }
  | { kind: 'nonCashAdjustment'; tag: string }
  | { kind: 'workingCapital'; accountId: string }
  | { kind: 'directMovement'; accountId: string }
  | { kind: 'fxEffect' };

/**
 * One column of a comparative CFS — also used for single-period reports
 * (in which case `periods` has a single entry with key `'total'`).
 */
export type CashFlowPeriodColumn = PeriodColumn;

export type CashFlowLine = ReportLine<CashFlowLineSource>;

export type CashFlowSection = ReportSection<CashFlowLineSource>;

/**
 * Per-column reconciliation. `tieOutOk: false` means the algorithm has
 * drifted from reality — fail-loud QA signal. Mirrors ERPNext's
 * opening/closing balance reconciliation (cash_flow.py:282-308).
 */
export interface CashFlowColumnReconciliation {
  openingCash: number;
  closingCash: number;
  /** `openingCash + netCashFlow` — what closingCash should be. */
  calculated: number;
  /** `true` when |closingCash − calculated| ≤ 1 cent. */
  tieOutOk: boolean;
}

export interface CashFlowReport {
  metadata: ReportMetadata & {
    periodStart: string;
    periodEnd: string;
    displayPeriod: string;
    /** Currency the report is denominated in. */
    currency?: string | undefined;
    /** Comparative mode used to build the columns ('monthly' | 'quarterly' | null). */
    comparative?: ComparativeMode | undefined;
  };
  /** Column definitions in display order. Always at least one entry. */
  periods: CashFlowPeriodColumn[];
  /** Operating: Net Income + non-cash adjustments + ΔWorking Capital. */
  operating: CashFlowSection;
  /** Investing: direct movements on fixed/non-current asset accounts. */
  investing: CashFlowSection;
  /** Financing: direct movements on equity (excl. retained earnings) + non-current liabilities. */
  financing: CashFlowSection;
  /** FX cash effect (IAS 7 §28 / ASC 230) per column. Zero for single-currency hosts. */
  fxEffect: Record<string, number>;
  /** Net change in cash per column = operating + investing + financing + fxEffect. */
  netCashFlow: Record<string, number>;
  /** Per-column tie-out against actual cash account balance deltas. */
  cashReconciliation: Record<string, CashFlowColumnReconciliation>;
}

// ─── Report Query Params ─────────────────────────────────────────────────────

export interface PeriodParams {
  dateOption: 'month' | 'quarter' | 'year' | 'custom';
  dateValue: unknown;
  /**
   * Optional dimension filters injected into aggregation $match stages.
   * Keys are dot-path field names (e.g. 'journalItems.departmentId').
   * Values are matched with equality or MongoDB query operators.
   */
  filters?: Record<string, unknown> | undefined;
}

export interface BalanceSheetParams extends PeriodParams {
  organizationId?: string | undefined;
  comparative?: ComparativeMode | undefined;
}

export interface IncomeStatementParams extends PeriodParams {
  organizationId?: string | undefined;
  comparative?: ComparativeMode | undefined;
}

export interface TrialBalanceParams extends PeriodParams {
  organizationId?: string | undefined;
  accountId?: string | undefined;
  comparative?: ComparativeMode | undefined;
}

export interface GeneralLedgerParams extends PeriodParams {
  organizationId?: string | undefined;
  accountId?: string | undefined;
}
