/**
 * Legacy report-view helpers — bridge old test assertion patterns to the
 * new columnar/multi-period report shape.
 *
 * Why this exists: pre-0.10 reports used a flat `summary`/`assets`/
 * `liabilities`/`equity`/`groups[]/accounts[]` shape. The 0.10 refactor
 * adopts the ERPNext / QBO columnar shape — every monetary field is
 * `Record<string, number>` keyed by `period.key`, and detail lines live
 * in `assetsSection.lines[]` / `equitySection.lines[]` / etc.
 *
 * The new shape is the right shape for FE rendering (single envelope for
 * single- and multi-period). But many tests don't care about multi-period
 * — they assert "is the BS balanced for this date range?" or "does the
 * equity section contain a Stockholders' Equity group?". Forcing each
 * such test to write `report.summaryByPeriod.isBalanced.total` everywhere
 * would bury intent in column-key noise.
 *
 * These helpers project a single-period (or 'total' column) view back
 * onto the legacy flat shape so test files read naturally:
 *
 *   const view = legacyBalanceSheet(report);
 *   expect(view.summary.isBalanced).toBe(true);
 *   expect(view.equity.groups.map(g => g.name)).toContain('Retained Earnings');
 *
 * Tests that explicitly verify multi-period behavior should assert against
 * the real new shape (`report.summaryByPeriod.totalAssets['2025-01']`) —
 * no helper there.
 */

import type {
  BalanceSheetReport,
  BalanceSheetSection,
  IncomeStatementReport,
  IncomeStatementSection,
  ReportAccount,
  ReportCategory,
  ReportGroup,
  TrialBalanceReport,
} from '../../src/types/report.js';

/**
 * Choose the column key to project onto the legacy view. Defaults to 'total'
 * (the single-period column or the appended total column on multi-period
 * reports). Pass a specific period key (e.g. `'2025-01'`) to inspect one
 * column of a multi-period report through the legacy lens.
 */
const DEFAULT_KEY = 'total';

// ─── Balance Sheet ─────────────────────────────────────────────────────────

export interface LegacyBalanceSheetView {
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

export function legacyBalanceSheet(
  report: BalanceSheetReport,
  key: string = DEFAULT_KEY,
): LegacyBalanceSheetView {
  const labels = report.metadata.labels ?? {};
  return {
    assets: sectionToCategory(labels.assets ?? 'Assets', report.assetsSection, key),
    liabilities: sectionToCategory(labels.liabilities ?? 'Liabilities', report.liabilitiesSection, key),
    equity: sectionToCategory(labels.equity ?? 'Equity', report.equitySection, key),
    summary: {
      totalAssets: report.summaryByPeriod.totalAssets[key] ?? 0,
      totalLiabilities: report.summaryByPeriod.totalLiabilities[key] ?? 0,
      totalEquity: report.summaryByPeriod.totalEquity[key] ?? 0,
      liabilitiesAndEquity: report.summaryByPeriod.liabilitiesAndEquity[key] ?? 0,
      difference: report.summaryByPeriod.difference[key] ?? 0,
      isBalanced: report.summaryByPeriod.isBalanced[key] ?? false,
    },
  };
}

// ─── Income Statement ──────────────────────────────────────────────────────

export interface LegacyIncomeStatementView {
  revenue: ReportCategory;
  expenses: ReportCategory;
  netIncome: number;
  grossProfit: number;
  costOfSales: number;
  operatingIncome: number;
}

export function legacyIncomeStatement(
  report: IncomeStatementReport,
  key: string = DEFAULT_KEY,
): LegacyIncomeStatementView {
  const labels = report.metadata.labels ?? {};
  return {
    revenue: sectionToCategory(labels.revenue ?? 'Revenue', report.revenueSection, key),
    expenses: sectionToCategory(labels.expenses ?? 'Expenses', report.expensesSection, key),
    netIncome: report.netIncomeByPeriod[key] ?? 0,
    grossProfit: report.grossProfitByPeriod[key] ?? 0,
    costOfSales: report.costOfSalesByPeriod[key] ?? 0,
    operatingIncome: report.operatingIncomeByPeriod[key] ?? 0,
  };
}

// ─── Trial Balance ─────────────────────────────────────────────────────────

export interface LegacyTrialBalanceRow {
  account: unknown;
  initial: { debit: number; credit: number };
  current: { debit: number; credit: number };
  ending: { debit: number; credit: number };
}

export interface LegacyTrialBalanceView {
  rows: LegacyTrialBalanceRow[];
  period: TrialBalanceReport['period'];
}

export function legacyTrialBalance(
  report: TrialBalanceReport,
  key: string = DEFAULT_KEY,
): LegacyTrialBalanceView {
  const rows: LegacyTrialBalanceRow[] = report.columnarRows.map((row) => ({
    account: row.account,
    initial: {
      debit: row.initial.debit[key] ?? 0,
      credit: row.initial.credit[key] ?? 0,
    },
    current: {
      debit: row.current.debit[key] ?? 0,
      credit: row.current.credit[key] ?? 0,
    },
    ending: {
      debit: row.ending.debit[key] ?? 0,
      credit: row.ending.credit[key] ?? 0,
    },
  }));
  return { rows, period: report.period };
}

// ─── Section → Category projection ─────────────────────────────────────────
//
// New shape: section.lines is a flat list with `source.group` carrying the
// group name. Old shape: section.groups is a bucketed list of {name, total,
// accounts[]}. This helper inverts the projection.

function sectionToCategory(
  name: string,
  section:
    | BalanceSheetSection
    | IncomeStatementSection
    | { totals: Record<string, number>; lines: Array<{ label: string; code: string; amounts: Record<string, number>; source: unknown }> },
  key: string,
): ReportCategory {
  const groupsByName = new Map<string, ReportGroup>();
  for (const line of section.lines) {
    const groupName = extractGroupName(line.source);
    if (!groupsByName.has(groupName)) {
      groupsByName.set(groupName, { name: groupName, total: 0, accounts: [] });
    }
    const group = groupsByName.get(groupName)!;
    const balance = line.amounts[key] ?? 0;
    const account: ReportAccount = {
      id: extractAccountId(line.source) ?? line.code,
      name: line.label,
      code: line.code,
      balance,
      isCalculated: extractIsCalculated(line.source),
    };
    group.accounts.push(account);
    group.total += balance;
  }
  const groups = [...groupsByName.values()];
  const total = section.totals[key] ?? groups.reduce((s, g) => s + g.total, 0);
  return { name, total, groups };
}

function extractGroupName(source: unknown): string {
  if (source && typeof source === 'object' && 'group' in source && typeof (source as { group: unknown }).group === 'string') {
    return (source as { group: string }).group;
  }
  // Aggregate lines (costOfSales, grossProfit, etc.) — bucket under their kind name.
  if (source && typeof source === 'object' && 'name' in source && typeof (source as { name: unknown }).name === 'string') {
    return (source as { name: string }).name;
  }
  return 'Other';
}

function extractAccountId(source: unknown): string | null {
  if (source && typeof source === 'object' && 'accountId' in source) {
    return String((source as { accountId: unknown }).accountId);
  }
  return null;
}

function extractIsCalculated(source: unknown): boolean | undefined {
  if (source && typeof source === 'object' && 'kind' in source) {
    const kind = (source as { kind: string }).kind;
    if (kind === 'calculated' || kind === 'aggregate') return true;
  }
  return undefined;
}
