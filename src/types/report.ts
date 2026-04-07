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
  businessName?: string;
  generatedAt: string;
}

export interface ReportAccount {
  id: unknown;
  name: string;
  code: string;
  balance: number;
  isTotal?: boolean;
  isVirtualTotal?: boolean;
  isCalculated?: boolean;
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

// ─── Trial Balance ───────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  account: unknown;
  initial: { debit: number; credit: number };
  current: { debit: number; credit: number };
  ending: { debit: number; credit: number };
}

export interface TrialBalanceReport {
  metadata?: ReportMetadata & { periodStart: string; periodEnd: string; displayPeriod: string };
  rows: TrialBalanceRow[];
  period: DateRange;
}

// ─── Balance Sheet ───────────────────────────────────────────────────────────

export interface BalanceSheetReport {
  metadata: ReportMetadata & { asOfDate: string; displayDate: string };
  assets: ReportCategory;
  liabilities: ReportCategory;
  equity: ReportCategory;
  summary: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    liabilitiesAndEquity: number;
    difference: number;
    isBalanced: boolean;
  };
}

// ─── Income Statement ────────────────────────────────────────────────────────

export interface IncomeStatementReport {
  metadata: ReportMetadata & { periodStart: string; periodEnd: string; displayPeriod: string };
  revenue: ReportCategory;
  costOfSales: number;
  grossProfit: number;
  expenses: ReportCategory;
  operatingIncome: number;
  netIncome: number;
}

// ─── General Ledger ──────────────────────────────────────────────────────────

export interface LedgerEntry {
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
  metadata?: ReportMetadata & { periodStart: string; periodEnd: string; displayPeriod: string };
  accounts: GeneralLedgerAccount[];
  period: DateRange;
}

// ─── Cash Flow Statement ────────────────────────────────────────────────────

export interface CashFlowSection {
  total: number;
  accounts: Array<{ name: string; code: string; amount: number }>;
}

export interface CashFlowReport {
  metadata: ReportMetadata & { periodStart: string; periodEnd: string; displayPeriod: string };
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netCashFlow: number;
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
  filters?: Record<string, unknown>;
}

export interface BalanceSheetParams extends PeriodParams {
  organizationId?: string;
}

export interface IncomeStatementParams extends PeriodParams {
  organizationId?: string;
}

export interface TrialBalanceParams extends PeriodParams {
  organizationId?: string;
  accountId?: string;
}

export interface GeneralLedgerParams extends PeriodParams {
  organizationId?: string;
  accountId?: string;
}
